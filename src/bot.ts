/**
 * bot.ts — transport-agnostic message handling.
 *
 * Responsibilities:
 *  - Dedup by update_id (persisted in log)
 *  - Route commands (instant reply) vs messages (agent)
 *  - Streaming: placeholder → edit every 2s with 300-char buffer → finish with copy button
 *  - setStatus ⌛/✅/⚠️ via MessageContext
 *  - Track delivery: compare agent output vs what telegram received
 *  - Auto-diagnose mismatches via debug agent
 */
import { TG } from "./config.js";
import type { Transport, IncomingMessage } from "./transport.js";
import { appendLog, seenUpdateIds } from "./store.js";
import { route } from "./router.js";
import { runMessage, formatToolCall, formatToolResult } from "./agent.js";
import { recordDeliveryReport, diagnoseMismatch, type StreamingMeta } from "./debug-client-agent.js";

// ── Bot ───────────────────────────────────────────────────────────────────

export function createBot(transport: Transport) {
  const EDIT_INTERVAL_MS = 2000;       // telegram-safe: 0.5 edits/sec
  const MIN_DELTA_CHARS = 300;          // buffer ~10-15 tokens before editing
  const NEAR_MAX = 3700;

  async function handleMessage(msg: IncomingMessage): Promise<void> {
    // Only owner
    if (msg.fromId !== TG.ownerChatId && msg.chatId !== TG.ownerChatId) return;

    const { id: userMsgId, chatId, text, timestamp: ts, replyToText } = msg;

    // If replying to a message, prepend context so the agent sees it
    const agentText = replyToText
      ? `[replying to: "${replyToText.slice(0, 500)}"]\n${text}`
      : text;

    // Route — commands get instant reply, no agent
    const routed = route(text);  // route on raw text (commands don't need reply context)
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
    await appendLog({ date: new Date(ts).toISOString(), ts, role: "user", text: agentText, updateId: userMsgId, messageId: userMsgId });

    // ── Streaming state ────────────────────────────────────────────────
    let activeMsgId: number | null = null;
    let committedChars = 0;
    let latestContent = "";
    let lastEditedText = "";
    let showingToolStatus = false;
    const toolLog: string[] = [];
    let activeTool = "";
    let draftTimer: NodeJS.Timeout | null = null;
    let typingTimer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();

    // Streaming metadata for debug agent
    let editCount = 0;
    let rateLimitHits = 0;
    const editErrors: string[] = [];

    const buildDisplay = (): string => {
      // During text generation: show text + current tool at the bottom
      if (latestContent.length > 0) {
        if (activeTool) return `${latestContent}\n\n${activeTool}`;
        return latestContent;
      }
      // Before text: show last few completed tools + current active tool
      const recent = toolLog.slice(-3);
      if (activeTool) recent.push(activeTool);
      return recent.join("\n") || "";
    };

    // ── Cleanup helper — always stop timers ────────────────────────────
    const cleanup = () => {
      if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    };

    // Start: status + placeholder + typing
    await ctx.setStatus("working");
    const placeholder = await ctx.placeholder();
    activeMsgId = placeholder.id;
    typingTimer = setInterval(() => void ctx.typing(), 4_000);
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
      if (!hasText) {
        showingToolStatus = true;
        // Tool status changed — stop typing, show status
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      }

      const chunk = display.slice(committedChars);
      if (!chunk || chunk === lastEditedText) return;

      // Buffer small deltas — don't hit telegram for tiny changes
      const delta = chunk.length - lastEditedText.length;
      if (delta > 0 && delta < MIN_DELTA_CHARS && chunk.length < NEAR_MAX) return;

      try {
        editCount++;
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
      } catch (err) {
        const errMsg = (err as Error).message ?? "";
        if (errMsg.includes("429") || errMsg.includes("Too Many Requests")) {
          rateLimitHits++;
          editErrors.push(`429 at edit #${editCount}`);
          console.warn("[bot] Rate limited, backing off 3s");
          await new Promise(r => setTimeout(r, 3000));
        } else {
          editErrors.push(errMsg.slice(0, 80));
          console.warn("[bot] flushEdit error:", errMsg.slice(0, 80));
        }
      }
    };

    draftTimer = setInterval(() => void flushEdit(), EDIT_INTERVAL_MS);

    try {
      const { text: response } = await runMessage(
        agentText, ts,
        { chatId, replyToMsgId: userMsgId },
        (acc) => {
          latestContent = acc;
          // Stop typing when real text arrives
          if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
        },
        (name, args) => { activeTool = formatToolCall(name, args); },
        (name, args, result) => { toolLog.push(formatToolResult(name, args, result)); activeTool = ""; },
      );

      cleanup();

      if (!response) {
        await ctx.update(activeMsgId!, "\u200b"); // zero-width space
        await ctx.setStatus(null);
        return;
      }

      // ── Final delivery ─────────────────────────────────────────────────
      const finalCommitted = showingToolStatus ? 0 : committedChars;
      const remaining = response.slice(finalCommitted);
      const sentParts: string[] = [];

      try {
        if (remaining.length <= NEAR_MAX) {
          await ctx.finish(activeMsgId!, remaining, { copyable: true, copyText: response });
          sentParts.push(remaining);
        } else {
          await ctx.update(activeMsgId!, remaining.slice(0, NEAR_MAX));
          sentParts.push(remaining.slice(0, NEAR_MAX));
          let rest = remaining.slice(NEAR_MAX);
          while (rest.length > NEAR_MAX) {
            await ctx.send(rest.slice(0, NEAR_MAX));
            sentParts.push(rest.slice(0, NEAR_MAX));
            rest = rest.slice(NEAR_MAX);
          }
          await ctx.send(rest, { copyable: true, copyText: response });
          sentParts.push(rest);
        }
      } catch (editErr) {
        console.error("[bot] Final edit failed, fallback:", (editErr as Error).message);
        editErrors.push(`final: ${(editErr as Error).message.slice(0, 80)}`);
        const fallback = remaining.slice(0, NEAR_MAX);
        await ctx.send(fallback).catch(() => {});
        sentParts.push(fallback);
      }

      await ctx.setStatus("done");

      // ── Delivery tracking ──────────────────────────────────────────────
      const sentText = sentParts.join("");
      const now = Date.now();
      const mismatch = sentText !== response;
      const meta: StreamingMeta = {
        committedChars: finalCommitted,
        editCount,
        rateLimitHits,
        editErrors,
        durationMs: now - startedAt,
      };

      await appendLog({
        date: new Date(now).toISOString(), ts: now, role: "bot", text: response,
        ...(mismatch ? { sentText } : {}),
      });
      console.log(`[bot] Replied (${response.length} chars, ${editCount} edits, ${Math.round(meta.durationMs / 1000)}s${mismatch ? `, MISMATCH sent=${sentText.length}` : ""})`);

      // Auto-diagnose mismatch in background
      if (mismatch) {
        const report = { agentText: response, sentText, streamingMeta: meta };
        recordDeliveryReport(report);
        void diagnoseMismatch(report).then(diagnosis => {
          console.log(`[debug-client] ${diagnosis.summary}`);
          console.log(`[debug-client] Fix: ${diagnosis.suggestion}`);
        }).catch(err => {
          console.warn("[debug-client] Diagnosis failed:", (err as Error).message);
        });
      }

    } catch (err) {
      cleanup();
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
