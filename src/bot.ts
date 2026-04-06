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
import type { Transport, IncomingMessage } from "./transport.js";
import { appendLog, seenUpdateIds } from "./store.js";
import { route } from "./router.js";
import { runMessage, runMessageForUser, formatToolCall, formatToolResult } from "./agent.js";
import { recordDeliveryReport, diagnoseMismatch, setActiveState, type StreamingMeta, type ActiveMessageState } from "./debug-client-agent.js";

// ── Bot ───────────────────────────────────────────────────────────────────

// In-flight message deduplication (prevents race conditions)
const handlingMessages = new Set<number>();

export function createBot(transport: Transport) {
  const EDIT_INTERVAL_MS = 2500;       // telegram-safe: ~0.4 edits/sec
  const MIN_DELTA_CHARS = 600;          // buffer ~15-20 tokens before editing (reduces rate limit hits)
  const NEAR_MAX = 3700;

  async function handleMessage(msg: IncomingMessage): Promise<void> {
    // Strong dedup: reject if currently handling this message
    if (handlingMessages.has(msg.id)) {
      console.log(`[bot] Already handling msg ${msg.id}, skipping duplicate`);
      return;
    }
    handlingMessages.add(msg.id);
    setTimeout(() => handlingMessages.delete(msg.id), 5000); // Release after 5s
    // Only owner - use transport's owner ID (works for Telegram, WhatsApp, etc.)
    // NOTE: Relaxed for WhatsApp self-testing - allow any WhatsApp user
    const isWhatsApp = process.env["TRANSPORT"] === "whatsapp";
    if (!isWhatsApp && msg.fromId !== transport.config.ownerChatId && msg.chatId !== transport.config.ownerChatId) {
      console.log(`[bot] Ignored message from ${msg.fromId} (expected ${transport.config.ownerChatId})`);
      return;
    }

    // For WhatsApp: use phone number as user identifier for per-user sessions
    const userId = msg.phone || String(msg.fromId);

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

    // Debug state — exposed via /debug
    const debugState: ActiveMessageState = {
      userMsgId,
      startedAt,
      activeMsgId: null,
      latestContent: "",
      lastEditedText: "",
      toolLog,
      activeTool: "",
      editCount: 0,
      rateLimitHits: 0,
      editErrors,
      isTyping: false,
      phase: "tools",
    };
    setActiveState(debugState);

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
      debugState.isTyping = false;
    };

    // Start: status + placeholder + typing
    await ctx.setStatus("working");
    const placeholder = await ctx.placeholder();
    activeMsgId = placeholder.id;
    debugState.activeMsgId = activeMsgId;
    typingTimer = setInterval(() => void ctx.typing(), 4_000);
    debugState.isTyping = true;
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
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; debugState.isTyping = false; }
      }

      const chunk = display.slice(committedChars);
      if (!chunk || chunk === lastEditedText) return;

      // Buffer small deltas — don't hit telegram for tiny changes
      const delta = chunk.length - lastEditedText.length;
      if (delta > 0 && delta < MIN_DELTA_CHARS && chunk.length < NEAR_MAX) return;

      try {
        editCount++;
        debugState.editCount = editCount;
        if (chunk.length <= NEAR_MAX) {
          await ctx.update(activeMsgId!, chunk);
          lastEditedText = chunk;
          debugState.lastEditedText = chunk;
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
          debugState.rateLimitHits = rateLimitHits;
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
      console.log(`[bot] Calling AI with: "${agentText.slice(0, 50)}..."`);

      // Use per-user session for WhatsApp, shared session for Telegram
      const { text: response } = isWhatsApp
        ? await runMessageForUser(
            userId,
            agentText, ts,
            { chatId, replyToMsgId: userMsgId, userPhone: userId },
            (acc) => {
              latestContent = acc;
              debugState.latestContent = acc;
              debugState.phase = "streaming";
              console.log(`[bot] AI streaming: "${acc.slice(0, 50)}..."`);
              if (typingTimer) { clearInterval(typingTimer); typingTimer = null; debugState.isTyping = false; }
            },
            (name, args) => { activeTool = formatToolCall(name, args); debugState.activeTool = activeTool; },
            (name, args, result) => { toolLog.push(formatToolResult(name, args, result)); activeTool = ""; debugState.activeTool = ""; },
          )
        : await runMessage(
            agentText, ts,
            { chatId, replyToMsgId: userMsgId },
            (acc) => {
              latestContent = acc;
              debugState.latestContent = acc;
              debugState.phase = "streaming";
              console.log(`[bot] AI streaming: "${acc.slice(0, 50)}..."`);
              // Stop typing when real text arrives
              if (typingTimer) { clearInterval(typingTimer); typingTimer = null; debugState.isTyping = false; }
            },
            (name, args) => { activeTool = formatToolCall(name, args); debugState.activeTool = activeTool; },
            (name, args, result) => { toolLog.push(formatToolResult(name, args, result)); activeTool = ""; debugState.activeTool = ""; },
          );

      cleanup();
      debugState.phase = "finalizing";
      console.log(`[bot] AI response: "${response?.slice(0, 50) || "EMPTY"}..." (${response?.length || 0} chars)`);

      if (!response) {
        console.log("[bot] Empty response, sending fallback");
        await ctx.finish(activeMsgId!, "No response", { copyable: false });
        await ctx.setStatus(null);
        debugState.phase = "done";
        setActiveState(null);
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
      debugState.phase = "done";
      setActiveState(null);

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
      debugState.phase = "error";
      setActiveState(null);
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
