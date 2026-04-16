/**
 * context.ts — sync log.jsonl into pi SessionManager (mom pattern).
 *
 * On each agent run we sync any log messages not yet in context so
 * messages sent while the bot was offline are never lost.
 */
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readLog } from "./store.js";

interface SessionEntry {
  type: string;
  message?: AgentMessage & { role: string; content: unknown };
}

export interface SyncOptions {
  excludeTs?: number;
  isGroup?: boolean;
  senderPhone?: string;
}

export function syncLogToContext(
  sessionManager: SessionManager,
  options?: SyncOptions,
): number {
  const entries = readLog();
  if (entries.length === 0) return 0;

  const known = buildKnownSet(sessionManager);
  let synced = 0;

  const excludeTs = options?.excludeTs;
  const isGroup = options?.isGroup;
  const senderPhone = options?.senderPhone;

  for (const entry of entries) {
    if (entry.role === "bot") continue;
    if (excludeTs !== undefined && entry.ts === excludeTs) continue;

    // Label messages with sender in group contexts
    const label = isGroup && senderPhone
      ? `[${senderPhone}]: ${entry.text}`
      : isGroup
        ? `[user]: ${entry.text}`
        : `[user]: ${entry.text}`;

    if (known.has(normalizeText(label))) continue;

    (sessionManager as unknown as { appendMessage: (m: unknown) => void }).appendMessage({
      role: "user",
      content: [{ type: "text", text: label }],
      timestamp: entry.ts,
    });
    known.add(normalizeText(label));
    synced++;
  }

  return synced;
}

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

function normalizeText(text: string): string {
  return text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "").trim();
}
