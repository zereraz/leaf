/**
 * bot.ts — transport-agnostic message handling with privacy controls.
 *
 * Responsibilities:
 *  - Dedup by update_id (persisted in log)
 *  - Privacy: group access control, mention requirements, tool scoping
 *  - Route commands (instant reply) vs messages (agent)
 *  - Streaming: placeholder → edit every 2s with 300-char buffer → finish with copy button
 *  - setStatus ⌛/✅/⚠️ via MessageContext
 *  - Track delivery: compare agent output vs what telegram received
 *  - Auto-diagnose mismatches via debug agent
 */
import type { Transport, IncomingMessage } from "./transport.js";
import { appendLog, seenUpdateIds } from "./store.js";
import { route } from "./router.js";
import { runMessage, runMessageForUser, runMessageForGroup, formatToolCall, formatToolResult } from "./agent.js";
import { recordDeliveryReport, diagnoseMismatch, setActiveState, type StreamingMeta, type ActiveMessageState } from "./debug-client-agent.js";
import {
  type SenderIdentity,
  type GroupAccessConfig,
  type ToolScopeConfig,
  buildSenderIdentity,
  getPrimaryIdentifier,
  evaluateGroupAccess,
  shouldRespondToMention,
  stripMention,
  DEFAULT_GROUP_CONFIG,
  DEFAULT_TOOL_SCOPE_CONFIG,
  isToolAllowed,
} from "./privacy/index.js";
import { getConsentManager, formatConsentRequest } from "./privacy/consent.js";

// ── Bot Configuration ─────────────────────────────────────────────────────

export interface BotPrivacyConfig {
  /** Group access configuration */
  groupAccess: GroupAccessConfig;
  /** Tool scoping configuration */
  toolScope: ToolScopeConfig;
  /** Owner identifiers (bypass all restrictions) */
  ownerIds: string[];
  /** Whether to enforce strict privacy (deny by default) */
  strictMode: boolean;
}

export const DEFAULT_PRIVACY_CONFIG: BotPrivacyConfig = {
  groupAccess: DEFAULT_GROUP_CONFIG,
  toolScope: DEFAULT_TOOL_SCOPE_CONFIG,
  ownerIds: [],
  strictMode: false,
};

// ── Bot State ─────────────────────────────────────────────────────────────

// In-flight message deduplication (prevents race conditions)
const handlingMessages = new Set<number>();

// Simple rate limiter: messages per user per hour
const RATE_LIMIT_MSGS_PER_HOUR = 30;
const userMessageCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const record = userMessageCounts.get(userId);

  if (!record || now > record.resetAt) {
    // New window
    userMessageCounts.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }

  if (record.count >= RATE_LIMIT_MSGS_PER_HOUR) {
    return false; // Rate limited
  }

  record.count++;
  return true;
}

// ── Privacy Utilities ─────────────────────────────────────────────────────

/**
 * Build SenderIdentity from incoming message.
 */
function buildIdentity(msg: IncomingMessage): SenderIdentity {
  const params: Parameters<typeof buildSenderIdentity>[0] = {
    id: String(msg.fromId),
    isGroup: msg.isGroup,
  };
  if (msg.phone !== undefined) params.e164 = msg.phone;
  if (msg.username !== undefined) params.username = msg.username;
  if (msg.senderName !== undefined) params.name = msg.senderName;
  if (msg.groupId !== undefined) params.groupId = msg.groupId;
  return buildSenderIdentity(params);
}

/**
 * Check if user is an owner (bypasses restrictions).
 * Returns false since owner feature is disabled.
 */
function isOwner(_identity: SenderIdentity, config: BotPrivacyConfig): boolean {
  return config.ownerIds.length > 0 && config.ownerIds[0] !== "";
}

/**
 * Filter tools based on sender scope.
 */
function filterToolsForSender(
  identity: SenderIdentity,
  config: ToolScopeConfig,
): string[] {
  // Get all available tool names from agent
  const allTools = ["bash", "read", "edit", "write", "spawn_agent", "web_search", "todo"];

  return allTools.filter(tool => isToolAllowed(identity, tool, config));
}

/**
 * Handle consent approval/denial from user.
 */
async function handleConsentResponse(
  identity: SenderIdentity,
  requestId: string,
  approved: boolean,
  ctx: ReturnType<Transport["contextFor"]>,
  replyToId: number,
): Promise<void> {
  try {
    const manager = getConsentManager();
    const request = manager.getRequest(requestId);

    if (!request) {
      await ctx.send(`❌ Consent request ${requestId} not found.`, { replyToId });
      return;
    }

    const result = await manager.respond(identity, requestId, approved);
    const status = result.status === "approved" ? "✅ Approved" : "❌ Denied";
    await ctx.send(`${status} access to your ${result.dataDescription}`, { replyToId });

    // Notify requester of the outcome
    console.log(`[consent] Notifying requester ${result.requesterId} of ${result.status} for ${requestId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.send(`⚠️ ${msg}`, { replyToId });
  }
}

// ── Bot Factory ────────────────────────────────────────────────────────────

export function createBot(
  transport: Transport,
  privacyConfig: Partial<BotPrivacyConfig> = {},
) {
  const EDIT_INTERVAL_MS = 2500;
  const MIN_DELTA_CHARS = 600;
  const NEAR_MAX = 3700;

  const config: BotPrivacyConfig = {
    ...DEFAULT_PRIVACY_CONFIG,
    ...privacyConfig,
    groupAccess: { ...DEFAULT_GROUP_CONFIG, ...privacyConfig.groupAccess },
    toolScope: { ...DEFAULT_TOOL_SCOPE_CONFIG, ...privacyConfig.toolScope },
  };

  async function handleMessage(msg: IncomingMessage): Promise<void> {
    // Strong dedup: reject if currently handling this message
    if (handlingMessages.has(msg.id)) {
      console.log(`[bot] Already handling msg ${msg.id}, skipping duplicate`);
      return;
    }
    handlingMessages.add(msg.id);
    setTimeout(() => handlingMessages.delete(msg.id), 5000);

    // Build sender identity
    const identity = buildIdentity(msg);
    const userId = msg.phone || String(msg.fromId);
    const primaryId = getPrimaryIdentifier(identity);

    console.log(`[bot] Message from ${primaryId} (group: ${msg.isGroup})`);

    // Rate limiting check
    if (!checkRateLimit(userId)) {
      console.log(`[bot] Rate limit exceeded for ${userId}`);
      const ctx = transport.contextFor(msg);
      await ctx.send("⚠️ Rate limit reached. Please try again later.");
      return;
    }

    // Owner bypass - allow owners even if not in allowlist
    const userIsOwner = isOwner(identity, config);

    // Only owner check for non-WhatsApp (Telegram mode)
    const isWhatsApp = process.env["TRANSPORT"] === "whatsapp";
    if (!isWhatsApp && !userIsOwner) {
      if (msg.fromId !== transport.config.ownerChatId && msg.chatId !== transport.config.ownerChatId) {
        console.log(`[bot] Ignored message from ${msg.fromId} (expected ${transport.config.ownerChatId})`);
        return;
      }
    }

    // ── Group Privacy Controls ─────────────────────────────────────────

    // Group access check
    if (msg.isGroup) {
      const accessDecision = evaluateGroupAccess(identity, config.groupAccess);

      if (!accessDecision.allowed && !userIsOwner) {
        console.log(`[bot] Group access denied for ${primaryId}: ${accessDecision.reason}`);
        // Silently drop the message (don't leak bot presence)
        return;
      }

      // Mention check for groups
      if (!shouldRespondToMention(msg.text, true, config.groupAccess) && !userIsOwner) {
        console.log(`[bot] Message ignored - mention required in groups`);
        return;
      }
    }

    // Prepare message text (strip mention if present)
    let text = msg.text;
    if (msg.isGroup && config.groupAccess.botUsername) {
      text = stripMention(msg.text, config.groupAccess.botUsername);
    }

    const { id: userMsgId, chatId, timestamp: ts, replyToText } = msg;

    // If replying to a message, prepend context
    const agentText = replyToText
      ? `[replying to: "${replyToText.slice(0, 500)}"]\n${text}`
      : text;

    // Route — commands get instant reply, no agent
    const routed = route(text);
    const ctx = transport.contextFor(msg);

    // Handle consent commands with identity context
    const trimmedText = text.trim();
    if (trimmedText.startsWith("/approve ") || trimmedText.startsWith("approve ")) {
      const requestId = trimmedText.split(/\s+/)[1];
      if (requestId) {
        await handleConsentResponse(identity, requestId, true, ctx, userMsgId);
        return;
      }
    }
    if (trimmedText.startsWith("/deny ") || trimmedText.startsWith("deny ")) {
      const requestId = trimmedText.split(/\s+/)[1];
      if (requestId) {
        await handleConsentResponse(identity, requestId, false, ctx, userMsgId);
        return;
      }
    }

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

    // ── Tool Scope Check ───────────────────────────────────────────────
    const allowedTools = filterToolsForSender(identity, config.toolScope);
    console.log(`[bot] Allowed tools for ${primaryId}: ${allowedTools.join(", ") || "none"}`);

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
      if (latestContent.length > 0) {
        if (activeTool) return `${latestContent}\n\n${activeTool}`;
        return latestContent;
      }
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
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; debugState.isTyping = false; }
      }

      const chunk = display.slice(committedChars);
      if (!chunk || chunk === lastEditedText) return;

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

      // Route to appropriate session handler:
      // - Group messages: shared group session
      // - WhatsApp DMs: per-user session
      // - Telegram DMs: legacy shared session
      const { text: response } = msg.isGroup
        ? await runMessageForGroup(
            msg.groupId!,
            userId,
            agentText, ts,
            { chatId, replyToMsgId: userMsgId, groupId: msg.groupId!, senderPhone: userId },
            (acc) => {
              latestContent = acc;
              debugState.latestContent = acc;
              debugState.phase = "streaming";
              console.log(`[bot] AI streaming: "${acc.slice(0, 50)}..."`);
              if (typingTimer) { clearInterval(typingTimer); typingTimer = null; debugState.isTyping = false; }
            },
            (name, args) => {
              // Check if tool is allowed
              if (!isToolAllowed(identity, name, config.toolScope) && !userIsOwner) {
                activeTool = `⛔ ${name}: not allowed`;
                debugState.activeTool = activeTool;
                return;
              }
              activeTool = formatToolCall(name, args);
              debugState.activeTool = activeTool;
            },
            (name, args, result) => {
              toolLog.push(formatToolResult(name, args, result));
              activeTool = "";
              debugState.activeTool = "";
            },
          )
        : isWhatsApp
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
              (name, args) => {
                // Check if tool is allowed
                if (!isToolAllowed(identity, name, config.toolScope) && !userIsOwner) {
                  activeTool = `⛔ ${name}: not allowed`;
                  debugState.activeTool = activeTool;
                  return;
                }
                activeTool = formatToolCall(name, args);
                debugState.activeTool = activeTool;
              },
              (name, args, result) => {
                toolLog.push(formatToolResult(name, args, result));
                activeTool = "";
                debugState.activeTool = "";
              },
            )
          : await runMessage(
              agentText, ts,
              { chatId, replyToMsgId: userMsgId },
              (acc) => {
                latestContent = acc;
                debugState.latestContent = acc;
                debugState.phase = "streaming";
                console.log(`[bot] AI streaming: "${acc.slice(0, 50)}..."`);
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
