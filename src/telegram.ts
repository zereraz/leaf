/**
 * telegram.ts — typed Telegram Bot API wrapper.
 * Zero dependencies beyond fetch (Node 18+).
 */
import { TG } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TgUpdate {
  readonly update_id: number;
  readonly message?: TgMessage;
}

export interface TgMessage {
  readonly message_id: number;
  readonly from?: TgUser;
  readonly chat: TgChat;
  readonly date: number; // unix seconds
  readonly text?: string;
}

export interface TgUser {
  readonly id: number;
  readonly first_name?: string;
  readonly username?: string;
}

export interface TgChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
}

export interface TgSentMessage {
  readonly message_id: number;
  readonly chat: TgChat;
}

// ── API client ─────────────────────────────────────────────────────────────

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG.apiBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
  if (!json.ok) {
    const err = new TgApiError(method, json.error_code ?? res.status, json.description ?? "unknown");
    throw err;
  }
  return json.result;
}

export class TgApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly description: string,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = "TgApiError";
  }
  /** True when another bot instance is already polling. */
  isConflict(): boolean { return this.code === 409; }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Long-poll for updates. Blocks up to timeoutSecs. */
export async function getUpdates(offset: number, timeoutSecs = TG.pollTimeoutSecs): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSecs,
    allowed_updates: ["message"],
  });
}

/** Send text message, splitting if needed. Returns last sent message. */
export async function sendMessage(chatId: number, text: string): Promise<TgSentMessage> {
  const chunks = splitText(text, TG.maxMessageLen);
  let last!: TgSentMessage;
  for (const chunk of chunks) {
    last = await call<TgSentMessage>("sendMessage", { chat_id: chatId, text: chunk });
  }
  return last;
}

/** Show typing indicator (best-effort). */
export async function sendTyping(chatId: number): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/** Convenience: send to owner. */
export async function notifyOwner(text: string): Promise<TgSentMessage> {
  return sendMessage(TG.ownerChatId, text);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = maxLen;
    // Prefer splitting at paragraph boundary
    const para = remaining.lastIndexOf("\n\n", maxLen);
    if (para > maxLen * 0.6) cut = para + 2;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}
