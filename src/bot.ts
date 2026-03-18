/**
 * bot.ts — transport-agnostic message handling.
 *
 * Works against the Transport interface — no Telegram imports.
 * Swap TelegramTransport for WhatsAppTransport in main.ts and nothing here changes.
 *
 * Responsibilities:
 *  - Dedup by update_id (persisted in log)
 *  - Route commands (instant reply) vs messages (agent)
 *  - Streaming: placeholder → edit every 400ms → finish with copy button
 *  - setStatus ⌛/✅/⚠️ via MessageContext
 */
import { TG } from "./config.js";
import type { Transport, IncomingMessage } from "./transport.js";
import { appendLog, seenUpdateIds } from "./store.js";
import { route } from "./router.js";
import { runMessage, formatToolCall, formatToolResult } from "./agent.js";

// ── Bot ───────────────────────────────────────────────────────────────────

export function createBot(transport: Transport) {
  const EDIT_INTERVAL_MS = 400;
  const NEAR_MAX = 3700;

  async function handleMessage(msg: IncomingMessage): Promise<void> {
    // Only owner
    if (msg.fromId !== TG.ownerChatId && msg.chatId !== TG.ownerChatId) return;

    const { id: userMsgId, chatId, text, timestamp: ts } = msg;

    // Route — commands get instant reply, no agent
    const routed = route(text);
    const ctx = transport.contextFor(msg);

    if (routed.kind === "command_reply") {
      await ctx.send(routed.text, { replyToId: userMsgId });
      return;
    }

    // Dedup
    if (seenUpdateIds().has(userMsgId)) {
      console.log(`[bot] Dedup: msg ${userMsgId}`);
      return;
    }

    // Persist immediately — dedup source
    await appendLog({ date: new Date(ts).toISOString(), ts, role: "user", text, updateId: userMsgId, messageId: userMsgId });

    // Streaming run
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

    // Start: status + placeholder + typing
    await ctx.setStatus("working");
    const placeholder = await ctx.placeholder();
    activeMsgId = placeholder.id;
    typingTimer = setInterval(() => void ctx.typing(), 3_000);
    await ctx.typing();

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
        await ctx.update(activeMsgId!, chunk);
        lastEditedText = chunk;
      } else {
        await ctx.update(activeMsgId!, chunk.slice(0, NEAR_MAX));
        committedChars += NEAR_MAX;
        const next = await ctx.placeholder();
        activeMsgId = next.id;
        lastEditedText = "";
      }
    };

    draftTimer = setInterval(() => void flushEdit(), EDIT_INTERVAL_MS);

    try {
      const { text: response } = await runMessage(
        text, ts,
        { chatId, replyToMsgId: userMsgId },
        (acc) => { latestContent = acc; },
        (name, args) => { activeTool = formatToolCall(name, args); },
        (name, args, result) => { toolLog.push(formatToolResult(name, args, result)); activeTool = ""; },
      );

      clearInterval(draftTimer); draftTimer = null;
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }

      if (!response) {
        await ctx.update(activeMsgId!, "\u200b"); // zero-width space
        await ctx.setStatus(null);
        return;
      }

      const finalCommitted = showingToolStatus ? 0 : committedChars;
      const remaining = response.slice(finalCommitted);

      try {
        if (remaining.length <= NEAR_MAX) {
          await ctx.finish(activeMsgId!, remaining, { copyable: true, copyText: response });
        } else {
          await ctx.update(activeMsgId!, remaining.slice(0, NEAR_MAX));
          let rest = remaining.slice(NEAR_MAX);
          while (rest.length > NEAR_MAX) {
            await ctx.send(rest.slice(0, NEAR_MAX));
            rest = rest.slice(NEAR_MAX);
          }
          await ctx.send(rest, { copyable: true, copyText: response });
        }
      } catch (editErr) {
        // Final edit failed — send fresh so response is never lost
        console.error("[bot] Final edit failed, fallback:", (editErr as Error).message);
        await ctx.send(remaining.slice(0, NEAR_MAX)).catch(() => {});
      }

      await ctx.setStatus("done");

      const now = Date.now();
      await appendLog({ date: new Date(now).toISOString(), ts: now, role: "bot", text: response });
      console.log(`[bot] Replied (${response.length} chars)`);

    } catch (err) {
      if (draftTimer) clearInterval(draftTimer);
      if (typingTimer) clearInterval(typingTimer);
      console.error("[bot] Agent error:", err);
      await ctx.setStatus("error").catch(() => {});
      await ctx.send("⚠️ Something went wrong.").catch(() => {});
    }
  }

  return {
    start: () => transport.start(handleMessage),
    stop:  () => transport.stop(),
  };
}
