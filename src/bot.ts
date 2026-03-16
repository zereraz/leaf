/**
 * bot.ts — Telegram long-polling loop.
 *
 * - Only accepts messages from the owner chat ID
 * - Deduplicates by update_id (persisted in log)
 * - Per-conversation mutex: queues concurrent messages, runs serially
 * - Exponential backoff on conflict errors (another poller running)
 * - Typing indicator kept alive during long runs
 */
import { TG } from "./config.js";
import { getUpdates, sendMessage, sendTyping, notifyOwner, TgApiError, type TgUpdate } from "./telegram.js";
import { appendLog, seenUpdateIds, updateState, readState } from "./store.js";
import { route } from "./router.js";
import { runMessage } from "./agent.js";

// ── Mutex: one run per conversation at a time ──────────────────────────────

const running = new Map<string, boolean>();
const queue = new Map<string, Array<() => Promise<void>>>();

async function withMutex(conversation: string, fn: () => Promise<void>): Promise<void> {
  const q = queue.get(conversation) ?? [];
  queue.set(conversation, q);

  q.push(fn);

  if (running.get(conversation)) return; // will be picked up when current run ends

  running.set(conversation, true);
  while (q.length > 0) {
    const next = q.shift()!;
    try { await next(); } catch (err) { console.error(`[bot:${conversation}] run error:`, err); }
  }
  running.set(conversation, false);
}

// ── Update handler ─────────────────────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  if (msg.chat.id !== TG.ownerChatId) {
    console.log(`[bot] Ignored message from chat ${msg.chat.id}`);
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const ts = msg.date * 1000;
  const updateId = update.update_id;

  // Route first (commands don't need dedup or agent)
  const result = route(text);

  if (result.kind === "command_reply") {
    await sendMessage(chatId, result.text);
    return;
  }

  const { conversation, allConversations } = result;

  // Dedup: skip if we've already processed this update
  const seen = seenUpdateIds(conversation.name);
  if (seen.has(updateId)) {
    console.log(`[bot] Dedup: update ${updateId} already processed`);
    return;
  }

  // Log immediately so dedup works even if agent crashes
  await appendLog(conversation.name, { date: new Date(ts).toISOString(), ts, role: "user", text, updateId });

  await withMutex(conversation.name, async () => {
    let typingTimer: NodeJS.Timeout | null = null;
    typingTimer = setInterval(() => void sendTyping(chatId), 4_000);
    await sendTyping(chatId);

    try {
      const { text: response } = await runMessage(conversation, allConversations, text, ts);
      clearInterval(typingTimer);
      typingTimer = null;

      if (!response) return;

      const now = Date.now();
      await appendLog(conversation.name, { date: new Date(now).toISOString(), ts: now, role: "bot", text: response });
      await sendMessage(chatId, response);

      console.log(`[bot:${conversation.name}] Replied (${response.length} chars)`);
    } catch (err) {
      if (typingTimer) clearInterval(typingTimer);
      console.error(`[bot:${conversation.name}] Agent error:`, err);
      await sendMessage(chatId, "⚠️ Something went wrong. Check logs.").catch(() => {});
    }
  });
}

// ── Poll loop ──────────────────────────────────────────────────────────────

let polling = false;

export async function startBot(): Promise<void> {
  if (polling) return;
  polling = true;

  let backoffMs = 1_000;

  while (polling) {
    const state = readState();
    try {
      const updates = await getUpdates(state.offset, TG.pollTimeoutSecs);
      backoffMs = 1_000; // reset on success

      for (const update of updates) {
        // Advance offset before processing — safe on restart
        updateState(s => { s.offset = update.update_id + 1; });
        await handleUpdate(update);
      }
    } catch (err) {
      if (err instanceof TgApiError && err.isConflict()) {
        // Another poller is running. Back off.
        console.warn(`[bot] Conflict: another poller detected. Backing off ${backoffMs}ms…`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      } else {
        console.error("[bot] Poll error:", err);
        await sleep(5_000);
      }
    }
  }
}

export function stopBot(): void { polling = false; }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
