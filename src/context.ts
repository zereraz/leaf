/**
 * context.ts — sync log.jsonl into pi SessionManager (mom pattern).
 *
 * Each conversation has:
 *   log.jsonl     — append-only source of truth (all messages)
 *   context.jsonl — pi SDK LLM context (synced from log before each run)
 *
 * On each agent run we sync any log messages not yet in context, so
 * messages sent while the bot was offline are never lost.
 */
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readLog } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionEntry {
  type: string;
  message?: AgentMessage & { role: string; content: unknown };
}

// ── Sync ───────────────────────────────────────────────────────────────────

/**
 * Sync user messages from log.jsonl into SessionManager.
 * Skips the current message (added via session.prompt()).
 * Returns count of newly synced messages.
 */
export function syncLogToContext(
  sessionManager: SessionManager,
  conversation: string,
  excludeTs?: number,
): number {
  const entries = readLog(conversation);
  if (entries.length === 0) return 0;

  const known = buildKnownSet(sessionManager);
  let synced = 0;

  for (const entry of entries) {
    if (entry.role === "bot") continue;
    if (excludeTs !== undefined && entry.ts === excludeTs) continue;

    const normalized = normalizeText(`[saheb]: ${entry.text}`);
    if (known.has(normalized)) continue;

    (sessionManager as unknown as { appendMessage: (m: unknown) => void }).appendMessage({
      role: "user",
      content: [{ type: "text", text: `[saheb]: ${entry.text}` }],
      timestamp: entry.ts,
    });
    known.add(normalized);
    synced++;
  }

  return synced;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildKnownSet(sessionManager: SessionManager): Set<string> {
  const known = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    const e = entry as SessionEntry;
    if (e.type !== "message" || !e.message) continue;
    if (e.message.role !== "user") continue;
    const text = extractText(e.message.content);
    if (text) known.add(normalizeText(text));
  }
  return known;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as { type?: string }).type === "text") {
      return (part as { type: string; text?: string }).text ?? "";
    }
  }
  return "";
}

/** Strip timestamp prefix added by some formats, then trim. */
function normalizeText(text: string): string {
  return text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "").trim();
}
