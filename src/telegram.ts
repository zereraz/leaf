/**
 * telegram.ts — typed Telegram Bot API wrapper.
 * Zero dependencies beyond fetch (Node 18+).
 * Bot API v9.5 features: sendMessageDraft, HTML formatting, reactions, copy_text button, message effects.
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
  readonly reply_to_message?: TgMessage;
}

export interface TgUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
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

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly copy_text?: { text: string };        // v7.3 — no callback, instant clipboard
  readonly url?: string;
}

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface SendMessageOptions {
  readonly parse_mode?: "HTML" | "MarkdownV2";
  readonly reply_markup?: InlineKeyboardMarkup;
  readonly message_effect_id?: string;           // v7.4 — fire/heart/party etc.
  readonly disable_notification?: boolean;
  readonly reply_parameters?: {
    readonly message_id: number;
    readonly quote?: string;
  };
}

// Message effect IDs (v7.4 — all free, no Premium required)
export const EFFECT = {
  fire:       "5104841245755180586",
  thumbsUp:   "5107584321108051014",
  heart:      "5044134455711629726",
  party:      "5046509860389126442",
  thumbsDown: "5104858069142078462",
} as const;

// ── API client ─────────────────────────────────────────────────────────────

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG.apiBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
  if (!json.ok) {
    throw new TgApiError(method, json.error_code ?? res.status, json.description ?? "unknown");
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
  isConflict(): boolean { return this.code === 409; }
  isRateLimit(): boolean { return this.code === 429; }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Long-poll for updates. */
export async function getUpdates(offset: number, timeoutSecs = TG.pollTimeoutSecs): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSecs,
    allowed_updates: ["message", "message_reaction"],
  });
}

/** Send text message with optional HTML formatting, inline keyboard, effect. Splits if needed. */
export async function sendMessage(
  chatId: number,
  text: string,
  opts: SendMessageOptions = {},
): Promise<TgSentMessage> {
  const chunks = splitText(text, TG.maxMessageLen);
  let last!: TgSentMessage;
  for (let i = 0; i < chunks.length; i++) {
    // Only attach keyboard/effect to last chunk
    const isLast = i === chunks.length - 1;
    last = await call<TgSentMessage>("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      ...(isLast && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      ...(isLast && opts.message_effect_id ? { message_effect_id: opts.message_effect_id } : {}),
      ...(opts.disable_notification ? { disable_notification: true } : {}),
      ...(opts.reply_parameters ? { reply_parameters: opts.reply_parameters } : {}),
    });
  }
  return last;
}

/**
 * Send a "…" placeholder that subsequent edits stream into.
 * Linked to the user's message via reply_parameters so it's always
 * clear which question this response is answering — even if delivered hours late.
 */
export async function sendPlaceholder(chatId: number, replyToMessageId?: number): Promise<number> {
  const msg = await call<TgSentMessage>("sendMessage", {
    chat_id: chatId,
    text: "…",
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
  });
  return msg.message_id;
}

/** Edit an existing message in-place (streaming updates). */
export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  opts: Pick<SendMessageOptions, "parse_mode" | "reply_markup"> = {},
): Promise<void> {
  try {
    await call<unknown>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    });
  } catch (err) {
    if (err instanceof TgApiError && err.description.includes("message is not modified")) return;
    throw err;
  }
}

/** Delete a message (best-effort). */
export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  await call<unknown>("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
}

/** Delete multiple messages in one call (v7.0, up to 100). */
export async function deleteMessages(chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  await call<unknown>("deleteMessages", { chat_id: chatId, message_ids: messageIds }).catch(() => {});
}

/** Show typing / other action indicator. Auto-expires in 5s so call in a loop. */
export async function sendTyping(chatId: number): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/**
 * Set a reaction on a message (v7.0).
 * Pass empty array to remove all reactions.
 */
export async function setReaction(chatId: number, messageId: number, emoji: string | null): Promise<void> {
  await call<unknown>("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: "emoji", emoji }] : [],
    is_big: false,
  }).catch(() => {});
}

/** Convenience: send to owner. */
export async function notifyOwner(text: string, opts?: SendMessageOptions): Promise<TgSentMessage> {
  return sendMessage(TG.ownerChatId, text, opts);
}

// ── HTML helpers ───────────────────────────────────────────────────────────

/** Escape text for HTML parse_mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Wrap text in an expandable blockquote (v7.4).
 * Great for tool status or chain-of-thought — collapsed by default.
 */
export function expandableQuote(text: string): string {
  return `<blockquote expandable>${escapeHtml(text)}</blockquote>`;
}

/**
 * Build a "📋 Copy" inline keyboard button.
 * copy_text.text has a 256 char limit — truncate to be safe.
 */
export function copyButton(text: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "📋 Copy", copy_text: { text: text.slice(0, 256) } },
    ]],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = maxLen;
    const para = remaining.lastIndexOf("\n\n", maxLen);
    if (para > maxLen * 0.6) cut = para + 2;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

// ── TelegramTransport — implements Transport interface ─────────────────────

import type {
  Transport, TransportConfig, MessageContext,
  IncomingMessage as TransportMessage, SentMessage, SendOptions,
} from "./transport.js";
import { formatForTelegram } from "./markdown.js";

const STATUS_EMOJI: Record<"working" | "done" | "error", string> = {
  working: "⌛",
  done: "✅",
  error: "⚠️",
};

class TelegramMessageContext implements MessageContext {
  readonly source: TransportMessage;
  private readonly chatId: number;

  constructor(msg: TransportMessage) {
    this.source = msg;
    this.chatId = msg.chatId;
  }

  async send(text: string, opts?: SendOptions): Promise<SentMessage> {
    const fmt = formatForTelegram(text);
    const tgOpts: SendMessageOptions = {
      ...(fmt.parseMode ? { parse_mode: fmt.parseMode } : {}),
      ...(opts?.replyToId ? { reply_parameters: { message_id: opts.replyToId } } : {}),
      ...(opts?.copyable ? { reply_markup: copyButton(opts.copyText ?? text) } : {}),
    };
    const sent = await sendMessage(this.chatId, fmt.text, tgOpts);
    return { id: sent.message_id, chatId: this.chatId };
  }

  async placeholder(): Promise<SentMessage> {
    const id = await sendPlaceholder(this.chatId, this.source.id);
    return { id, chatId: this.chatId };
  }

  async update(msgId: number, text: string): Promise<void> {
    const fmt = formatForTelegram(text);
    await editMessage(this.chatId, msgId, fmt.text, {
      ...(fmt.parseMode ? { parse_mode: fmt.parseMode } : {}),
    });
  }

  async finish(msgId: number, text: string, opts?: SendOptions): Promise<void> {
    const fmt = formatForTelegram(text);
    await editMessage(this.chatId, msgId, fmt.text, {
      ...(fmt.parseMode ? { parse_mode: fmt.parseMode } : {}),
      ...(opts?.copyable ? { reply_markup: copyButton(opts.copyText ?? text) } : {}),
    });
  }

  async typing(): Promise<void> {
    await sendTyping(this.chatId);
  }

  async setStatus(status: "working" | "done" | "error" | null): Promise<void> {
    await setReaction(this.chatId, this.source.id, status ? (STATUS_EMOJI[status] ?? null) : null);
  }
}

export class TelegramTransport implements Transport {
  readonly config: TransportConfig;
  private _polling = false;

  constructor(ownerChatId: number) {
    this.config = { ownerChatId };
  }

  contextFor(msg: TransportMessage): MessageContext {
    return new TelegramMessageContext(msg);
  }

  async notifyOwner(text: string): Promise<SentMessage> {
    const sent = await sendMessage(this.config.ownerChatId, text);
    return { id: sent.message_id, chatId: this.config.ownerChatId };
  }

  async start(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
    this._polling = true;
    let offset = 0;
    let backoffMs = 1_000;
    let wasOffline = false;
    let offlineSince = 0;

    // Load persisted offset
    try {
      const { readState } = await import("./store.js");
      offset = readState().offset;
    } catch { /* ok — fresh start */ }

    while (this._polling) {
      try {
        const updates = await getUpdates(offset, TG.pollTimeoutSecs);
        backoffMs = 1_000;

        if (wasOffline) {
          wasOffline = false;
          const down = Math.round((Date.now() - offlineSince) / 1000);
          const label = down < 60 ? `${down}s` : `${Math.round(down / 60)}m`;
          console.log("[transport:tg] Back online.");
          await this.notifyOwner(`🟢 Back online. (down ${label})`).catch(() => {});
        }

        for (const update of updates) {
          offset = update.update_id + 1;
          // Persist offset immediately
          try {
            const { updateState } = await import("./store.js");
            updateState(s => { s.offset = offset; });
          } catch { /* ok */ }

          const msg = update.message;
          if (!msg?.text) continue;
          if (msg.chat.id !== this.config.ownerChatId) continue;

          const chatType = msg.chat.type;
          const isGroup = chatType === "group" || chatType === "supergroup";

          await onMessage({
            id: msg.message_id,
            chatId: msg.chat.id,
            text: msg.text.trim(),
            fromId: msg.from?.id ?? 0,
            timestamp: msg.date * 1000,
            replyToText: msg.reply_to_message?.text?.trim(),
            senderName: msg.from?.first_name
              ? `${msg.from.first_name}${msg.from.last_name ? ` ${msg.from.last_name}` : ""}`
              : msg.from?.username,
            username: msg.from?.username,
            isGroup,
            groupId: isGroup ? String(msg.chat.id) : undefined,
          });
        }
      } catch (err) {
        if (err instanceof TgApiError && err.isConflict()) {
          console.warn(`[transport:tg] Conflict — backing off ${backoffMs}ms…`);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 60_000);
        } else {
          if (!wasOffline) {
            wasOffline = true;
            offlineSince = Date.now();
            console.warn("[transport:tg] Offline:", (err as Error).message?.slice(0, 80));
          }
          await sleep(Math.min(backoffMs, 15_000));
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      }
    }
  }

  stop(): void { this._polling = false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
