/**
 * transport.ts — channel-agnostic messaging interface.
 *
 * Inspired by mom's SlackContext pattern and nama's protocol separation.
 * Bot logic (bot.ts) works against this interface — zero platform imports.
 *
 * Telegram, WhatsApp, Discord etc each implement Transport + MessageContext.
 *
 * Key design decisions:
 *  - MessageContext is created per inbound message — it knows the reply target
 *  - update() supports streaming (editMessage on Telegram, buffered send on others)
 *  - setStatus() is best-effort (reactions on Telegram, prefix on others)
 *  - Transport.start() owns the poll/webhook loop
 */

// ── Incoming ──────────────────────────────────────────────────────────────

export interface IncomingMessage {
  readonly id: number;       // platform message ID (for reply threading)
  readonly chatId: number;   // chat/channel/thread identifier
  readonly text: string;
  readonly fromId: number;   // sender platform ID
  readonly timestamp: number; // unix ms
  readonly replyToText?: string | undefined;  // text of the message being replied to (if any)
  readonly phone?: string | undefined;   // sender phone number (E.164 format, WhatsApp only)
  readonly senderName?: string | undefined;  // sender display name
  readonly username?: string | undefined;    // sender username/handle
  readonly isGroup: boolean;                 // whether this is a group message
  readonly groupId?: string | undefined;     // group identifier (if isGroup)
}

// ── Response context (per message) ───────────────────────────────────────

export interface SentMessage {
  readonly id: number;
  readonly chatId: number;
}

export interface SendOptions {
  /** Thread/reply to a specific message */
  readonly replyToId?: number;
  /** Attach a copy-to-clipboard affordance (if platform supports it) */
  readonly copyable?: boolean;
  /** The text to put in clipboard (defaults to the sent text) */
  readonly copyText?: string;
}

/**
 * MessageContext — how the bot responds to a specific inbound message.
 * Created by Transport.contextFor(msg).
 *
 * Streaming pattern:
 *   const { id } = await ctx.placeholder();
 *   await ctx.update(id, chunk1);   // edit in place
 *   await ctx.update(id, chunk2);   // edit in place
 *   await ctx.finish(id, fullText); // final, with copy button etc
 */
export interface MessageContext {
  /** The message this context is responding to */
  readonly source: IncomingMessage;

  /** Send a new message (optionally as reply to source) */
  send(text: string, opts?: SendOptions): Promise<SentMessage>;

  /** Send a placeholder to stream into ("…") */
  placeholder(): Promise<SentMessage>;

  /** Update a sent message in-place (streaming chunks) */
  update(msgId: number, text: string): Promise<void>;

  /** Finalize a streamed message (may add copy button, mark complete) */
  finish(msgId: number, text: string, opts?: SendOptions): Promise<void>;

  /** Show typing / working indicator */
  typing(): Promise<void>;

  /**
   * Set a status indicator on the source message.
   * "working" = ⌛, "done" = ✅, "error" = ⚠️, null = clear
   * Best-effort — platforms that don't support reactions may no-op.
   */
  setStatus(status: "working" | "done" | "error" | null): Promise<void>;
}

// ── Transport ─────────────────────────────────────────────────────────────

export interface TransportConfig {
  /** The chat ID of the owner (only messages from this ID are processed) */
  readonly ownerChatId: number;
}

export interface Transport {
  readonly config: TransportConfig;

  /**
   * Start receiving messages. Calls onMessage for each inbound message
   * from the owner. Runs until stop() is called.
   */
  start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void>;

  /** Stop receiving messages */
  stop(): void;

  /**
   * Create a response context for an incoming message.
   * The context is bound to the source message for reply threading.
   */
  contextFor(msg: IncomingMessage): MessageContext;

  /**
   * Send a proactive message to the owner outside of a message context.
   * Used by scheduler, error handlers, etc.
   */
  notifyOwner(text: string): Promise<SentMessage>;
}
