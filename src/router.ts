/**
 * router.ts — parse incoming messages and route to the right conversation.
 *
 * Bot commands (start with /):
 *   /new <name> [description]   — create & switch to a new conversation
 *   /switch <name>              — switch active conversation
 *   /list                       — list all conversations
 *   /back                       — switch back to main
 *   /kill <name>                — delete a conversation
 *   /who                        — show active conversation
 *
 * Any non-command message routes to the active conversation.
 */
import { rmSync } from "node:fs";
import { MAIN_CONVERSATION } from "./config.js";
import {
  readState, updateState, conversationDir, ensureDirs,
  type ConversationMeta,
} from "./store.js";
import { evictSession } from "./agent.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RouteResult =
  | { kind: "message"; conversation: ConversationMeta; allConversations: string[] }
  | { kind: "command_reply"; text: string };

// ── Router ─────────────────────────────────────────────────────────────────

export function route(text: string): RouteResult {
  const trimmed = text.trim();

  if (trimmed.startsWith("/")) {
    return handleCommand(trimmed);
  }

  // Regular message — route to active conversation
  const state = readState();
  const meta = state.conversations[state.activeConversation];
  if (!meta) {
    // Fallback: main
    updateState(s => { s.activeConversation = MAIN_CONVERSATION; });
    const mainMeta = readState().conversations[MAIN_CONVERSATION];
    if (!mainMeta) throw new Error("main conversation not found");
    return { kind: "message", conversation: mainMeta, allConversations: Object.keys(state.conversations) };
  }

  return {
    kind: "message",
    conversation: meta,
    allConversations: Object.keys(state.conversations),
  };
}

// ── Command handlers ───────────────────────────────────────────────────────

function handleCommand(text: string): RouteResult {
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd?.toLowerCase()) {
    case "/new":     return cmdNew(args);
    case "/switch":  return cmdSwitch(args);
    case "/list":    return cmdList();
    case "/back":    return cmdSwitch(MAIN_CONVERSATION);
    case "/kill":    return cmdKill(args);
    case "/who":     return cmdWho();
    default:
      return { kind: "command_reply", text: `Unknown command: ${cmd}\n\n${helpText()}` };
  }
}

function cmdNew(args: string): RouteResult {
  const [name, ...descParts] = args.split(/\s+/);
  if (!name) return { kind: "command_reply", text: "Usage: /new <name> [description]" };

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const description = descParts.join(" ") || `Agent: ${slug}`;

  const meta: ConversationMeta = {
    name: slug,
    description,
    createdAt: new Date().toISOString(),
  };

  updateState(s => {
    s.conversations[slug] = meta;
    s.activeConversation = slug;
  });
  ensureDirs(slug);

  return {
    kind: "command_reply",
    text: `✅ Created conversation "${slug}"\n${description}\n\nNow active. Send your first message.`,
  };
}

function cmdSwitch(args: string): RouteResult {
  const name = args.trim().toLowerCase();
  if (!name) return { kind: "command_reply", text: "Usage: /switch <name>" };

  const state = readState();
  if (!state.conversations[name]) {
    const list = Object.keys(state.conversations).join(", ");
    return { kind: "command_reply", text: `No conversation "${name}". Available: ${list}` };
  }

  updateState(s => { s.activeConversation = name; });
  const meta = state.conversations[name]!;
  return { kind: "command_reply", text: `🔀 Switched to "${name}"\n${meta.description}` };
}

function cmdList(): RouteResult {
  const state = readState();
  const lines = Object.entries(state.conversations).map(([name, meta]) => {
    const active = name === state.activeConversation ? " ◀ active" : "";
    return `• ${name}${active}\n  ${meta.description}`;
  });
  return {
    kind: "command_reply",
    text: lines.length > 0
      ? `Conversations:\n\n${lines.join("\n\n")}`
      : "No conversations yet. Use /new to create one.",
  };
}

function cmdKill(args: string): RouteResult {
  const name = args.trim().toLowerCase();
  if (!name) return { kind: "command_reply", text: "Usage: /kill <name>" };
  if (name === MAIN_CONVERSATION) return { kind: "command_reply", text: "Cannot kill main conversation." };

  const state = readState();
  if (!state.conversations[name]) {
    return { kind: "command_reply", text: `No conversation "${name}".` };
  }

  try { rmSync(conversationDir(name), { recursive: true, force: true }); } catch { /* ok */ }
  evictSession(name);

  updateState(s => {
    delete s.conversations[name];
    if (s.activeConversation === name) s.activeConversation = MAIN_CONVERSATION;
  });

  return { kind: "command_reply", text: `🗑 Deleted conversation "${name}".` };
}

function cmdWho(): RouteResult {
  const state = readState();
  const meta = state.conversations[state.activeConversation];
  return {
    kind: "command_reply",
    text: meta
      ? `Active: "${state.activeConversation}"\n${meta.description}`
      : `Active: ${state.activeConversation}`,
  };
}

function helpText(): string {
  return `/new <name> [desc]  — create conversation
/switch <name>      — switch conversation  
/list               — list all
/back               — back to main
/kill <name>        — delete conversation
/who                — show active`;
}
