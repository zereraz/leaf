/**
 * bot.ts — Telegram long-polling loop.
 *
 * Responsibilities:
 *  - Poll getUpdates, deduplicate by update_id
 *  - Commands → instant reply (no agent)
 *  - Messages → runMessage() with streaming placeholder
 *  - Exponential backoff on conflict/network errors
 *  - ⌛ reaction while working, ✅ when done
 */
import { TG } from "./config.js";
import {
  getUpdates, sendMessage, sendPlaceholder, editMessage, sendTyping,
  setReaction, copyButton, notifyOwner, TgApiError,
  type TgUpdate,
} from "./telegram.js";
import { appendLog, seenUpdateIds, updateState, readState } from "./store.js";
import { route } from "./router.js";
import { runMessage, formatToolCall, formatToolResult } from "./agent.js";

// ── Update handler ─────────────────────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  if (msg.chat.id !== TG.ownerChatId) return;

  const chatId    = msg.chat.id;
  const userMsgId = msg.message_id;
  const text      = msg.text.trim();
  const ts        = msg.date * 1000;
  const updateId  = update.update_id;

  // Commands — no agent, reply immediately
  const routed = route(text);
  if (routed.kind === "command_reply") {
    await sendMessage(chatId, routed.text);
    return;
  }

  // Dedup — skip if already processed
  if (seenUpdateIds().has(updateId)) {
    console.log(`[bot] Dedup: update ${updateId}`);
    return;
  }

  // Persist immediately — dedup is based on this
  await appendLog({ date: new Date(ts).toISOString(), ts, role: "user", text, updateId, messageId: userMsgId });

  // Streaming run — agent.ts holds the in-process + file lock
  const EDIT_INTERVAL_MS = 400;
  const NEAR_MAX = 3700;

  let activeMsgId: number | null = null;
  let committedChars = 0;
  let latestContent = "";
  let lastEditedText = "";
  let showingToolStatus = false;
  const toolLog: string[] = [];
  let activeTool = "";
  let draftTimer: NodeJS.Timeout | null = null;
  let typingTimer: NodeJS.Timeout | null = null;
  let firstEditDone = false;

  const buildDisplay = (): string => {
    if (latestContent.length > 0) return latestContent;
    const lines = [...toolLog];
    if (activeTool) lines.push(activeTool);
    return lines.join("\n");
  };

  await setReaction(chatId, userMsgId, "⌛");
  activeMsgId = await sendPlaceholder(chatId, userMsgId);
  typingTimer = setInterval(() => void sendTyping(chatId), 4_000);
  await sendTyping(chatId);

  const flushEdit = async () => {
    const hasText = latestContent.length > 0;
    if (showingToolStatus && hasText) {
      showingToolStatus = false;
      lastEditedText = "";
      committedChars = 0;
    }
    const display = buildDisplay();
    if (!display) return;
    if (!hasText) showingToolStatus = true;

    const chunk = display.slice(committedChars);
    if (!chunk || chunk === lastEditedText) return;

    if (!firstEditDone) {
      firstEditDone = true;
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    }

    if (chunk.length <= NEAR_MAX) {
      await editMessage(chatId, activeMsgId!, chunk);
      lastEditedText = chunk;
    } else {
      await editMessage(chatId, activeMsgId!, chunk.slice(0, NEAR_MAX));
      committedChars += NEAR_MAX;
      activeMsgId = await sendPlaceholder(chatId);
      lastEditedText = "";
    }
  };

  draftTimer = setInterval(() => void flushEdit(), EDIT_INTERVAL_MS);

  try {
    const { text: response } = await runMessage(
      text, ts,
      { chatId, replyToMsgId: userMsgId },
      (accumulated) => { latestContent = accumulated; },
      (toolName, args) => { activeTool = formatToolCall(toolName, args); },
      (toolName, args, result) => { toolLog.push(formatToolResult(toolName, args, result)); activeTool = ""; },
    );

    clearInterval(draftTimer); draftTimer = null;
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }

    if (!response) {
      await editMessage(chatId, activeMsgId!, "\u200b"); // zero-width space
      await setReaction(chatId, userMsgId, null);
      return;
    }

    const finalCommitted = showingToolStatus ? 0 : committedChars;
    const remaining = response.slice(finalCommitted);

    try {
      if (remaining.length <= NEAR_MAX) {
        await editMessage(chatId, activeMsgId!, remaining, { reply_markup: copyButton(response) });
      } else {
        await editMessage(chatId, activeMsgId!, remaining.slice(0, NEAR_MAX));
        let rest = remaining.slice(NEAR_MAX);
        while (rest.length > NEAR_MAX) {
          await sendMessage(chatId, rest.slice(0, NEAR_MAX));
          rest = rest.slice(NEAR_MAX);
        }
        await sendMessage(chatId, rest, { reply_markup: copyButton(response) });
      }
    } catch (editErr) {
      // Final edit failed — send fresh so response is never lost
      console.error("[bot] Final edit failed, fallback send:", (editErr as Error).message);
      await sendMessage(chatId, remaining.slice(0, NEAR_MAX)).catch(() => {});
    }

    await setReaction(chatId, userMsgId, "✅");
    const now = Date.now();
    await appendLog({ date: new Date(now).toISOString(), ts: now, role: "bot", text: response });
    console.log(`[bot] Replied (${response.length} chars)`);

  } catch (err) {
    if (draftTimer) clearInterval(draftTimer);
    if (typingTimer) clearInterval(typingTimer);
    console.error("[bot] Agent error:", err);
    await setReaction(chatId, userMsgId, "⚠️").catch(() => {});
    await sendMessage(chatId, "⚠️ Something went wrong.").catch(() => {});
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────────

let polling = false;

export async function startBot(): Promise<void> {
  if (polling) return;
  polling = true;

  let backoffMs = 1_000;
  let wasOffline = false;
  let offlineSince = 0;

  while (polling) {
    try {
      const updates = await getUpdates(readState().offset, TG.pollTimeoutSecs);
      backoffMs = 1_000;

      if (wasOffline) {
        wasOffline = false;
        const down = Math.round((Date.now() - offlineSince) / 1000);
        const downStr = down < 60 ? `${down}s` : `${Math.round(down / 60)}m`;
        console.log("[bot] Back online.");
        await notifyOwner(`🟢 Back online. (down ${downStr})`).catch(() => {});
      }

      for (const update of updates) {
        updateState(s => { s.offset = update.update_id + 1; });
        await handleUpdate(update);
      }
    } catch (err) {
      if (err instanceof TgApiError && err.isConflict()) {
        console.warn(`[bot] Conflict: backing off ${backoffMs}ms…`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      } else {
        if (!wasOffline) { wasOffline = true; offlineSince = Date.now(); console.warn("[bot] Offline:", (err as Error).message?.slice(0, 80)); }
        await sleep(Math.min(backoffMs, 15_000));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }
}

export function stopBot(): void { polling = false; }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
