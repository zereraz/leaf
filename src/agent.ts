/**
 * agent.ts — pi SDK session management.
 *
 * One persistent AgentSession for the main Telegram conversation.
 * Sub-agents use getOrCreateSession() directly with their own identity.
 *
 * Auth via pi's standard AuthStorage (env vars: AWS_BEARER_TOKEN_BEDROCK etc.)
 * System prompt rebuilt fresh on every run from memory files.
 */
import { join } from "node:path";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  codingTools,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { PATHS, MAIN_CONVERSATION, SILENT_TOKEN } from "./config.js";
import { sessionFile, PI_SESSIONS_DIR, initStore } from "./store.js";
import { syncLogToContext } from "./context.js";
import { readProjects, readMemory, readUser, readIgneIndex, readTodayLog } from "./memory.js";
import { notifyOwner } from "./telegram.js";
import { acquireFileLock } from "./lock.js";
import { spawnSubAgent, activeSubAgents } from "./subagent.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionIdentity {
  readonly name: string;       // e.g. "main" or "subagent-eidos"
  readonly description: string;
  readonly cwd?: string;       // project dir override
}

export interface RunResult {
  readonly text: string;
}

// The main conversation identity — always the same
export const MAIN: SessionIdentity = {
  name: MAIN_CONVERSATION,
  description: "Primary assistant",
};

// ── Session cache ──────────────────────────────────────────────────────────

interface CachedSession {
  session: AgentSession;
  sessionManager: SessionManager;
}

const cache = new Map<string, CachedSession>();

export function evictSession(name: string): void {
  cache.delete(name);
}

// ── In-process + file mutex ────────────────────────────────────────────────
// Both runMessage() and runProactive() go through this gate so they never
// call session.prompt() concurrently on the same AgentSession.

const inFlight = new Map<string, Promise<void>>();

async function withLock<T>(identity: SessionIdentity, fn: () => Promise<T>): Promise<T> {
  while (inFlight.has(identity.name)) {
    await inFlight.get(identity.name);
  }
  let resolve!: () => void;
  const gate = new Promise<void>(r => { resolve = r; });
  inFlight.set(identity.name, gate);

  const fileLock = await acquireFileLock(sessionFile(identity.name));
  try {
    return await fn();
  } finally {
    inFlight.delete(identity.name);
    resolve();
    await fileLock.release();
  }
}

// ── spawn_agent tool ───────────────────────────────────────────────────────

interface MsgContext { chatId: number; replyToMsgId: number }
const currentMsgCtx = new Map<string, MsgContext>();

let spawnCounter = 0;

const spawnAgentTool: ToolDefinition = {
  name: "spawn_agent",
  label: "Spawn Sub-Agent",
  description: [
    "Spawn a focused background agent for a task.",
    "It replies directly to the user on Telegram as it works — you stay free.",
    "Use for: coding, file changes, research, multi-step tasks.",
    "For quick answers or simple questions, just respond yourself.",
  ].join(" "),
  parameters: Type.Object({
    task:    Type.String({ description: "Clear task description" }),
    cwd:     Type.Optional(Type.String({ description: "Working directory (e.g. ~/Code/Zereraz/eidos)" })),
    context: Type.Optional(Type.String({ description: "Extra context to pass (file paths, notes)" })),
  }),
  execute: async (_id, params: Static<typeof spawnAgentTool.parameters>) => {
    const ctx = currentMsgCtx.get(MAIN_CONVERSATION);
    if (!ctx) return { content: [{ type: "text" as const, text: "Error: no message context" }], details: {} };

    spawnCounter++;
    const agentId = `agent-${spawnCounter}`;
    await spawnSubAgent({
      id: agentId,
      task: params.task,
      chatId: ctx.chatId,
      replyToMsgId: ctx.replyToMsgId,
      cwd: params.cwd,
      context: params.context,
    });

    return {
      content: [{ type: "text" as const, text: `Sub-agent "${agentId}" spawned — will reply directly to you.` }],
      details: {},
    };
  },
};

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(identity: SessionIdentity): string {
  const running = activeSubAgents();
  return `You are pi — saheb's always-on AI companion on Telegram.${identity.cwd ? `\nWorking directory: ${identity.cwd}` : ""}

## User
${readUser() || "Name: Sahebjot (saheb). Timezone: Asia/Calcutta."}

## Today
${readTodayLog()}

## Projects
${readProjects()}

## Memory
${readMemory()}

## Igne notes
${readIgneIndex()}

## Active sub-agents
${running.length > 0 ? running.map(a => `• ${a.id}: ${a.task.slice(0, 60)}`).join("\n") : "none"}

## Behavior
- Concise on Telegram — no markdown headers, readable on mobile
- Use rg for searching, fd for finding (not grep/find)
- For code, files, multi-step tasks: use spawn_agent — it runs in parallel and keeps you free
- For quick answers, lookups, memory updates: respond yourself
- When saheb shares thoughts about a project: save them to ~/pi-tg/memory/projects.md
- Scheduler prompts ([SCHEDULER:mode]): reply ${SILENT_TOKEN} if nothing worth saying`;
}

// ── Session factory ────────────────────────────────────────────────────────

export async function getOrCreateSession(identity: SessionIdentity): Promise<CachedSession> {
  const cached = cache.get(identity.name);
  if (cached) return cached;

  initStore();
  const cwd = identity.cwd ?? PATHS.data;

  const authStorage   = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
  const settingsManager = SettingsManager.create(cwd, PATHS.agentDir);

  // Fixed file per identity — grows forever, pi auto-compacts inline.
  // sessionDir = PI_SESSIONS_DIR so TUI /new, /fork, /resume land in the right place.
  const sm = SessionManager.open(sessionFile(identity.name), PI_SESSIONS_DIR);

  const loader = new DefaultResourceLoader({ cwd, agentDir: PATHS.agentDir, settingsManager });
  await loader.reload();

  const tools = identity.name === MAIN_CONVERSATION
    ? [...codingTools, spawnAgentTool]
    : codingTools;

  const { session } = await createAgentSession({
    cwd, agentDir: PATHS.agentDir,
    authStorage, modelRegistry, settingsManager,
    sessionManager: sm, resourceLoader: loader, tools,
  });

  session.agent.setSystemPrompt(buildSystemPrompt(identity));

  // Name the session so it shows correctly in `pi -r`
  const displayName = `Telegram — ${identity.name}`;
  if (sm.getSessionName() !== displayName) sm.appendSessionInfo(displayName);

  const result: CachedSession = { session, sessionManager: sm };
  cache.set(identity.name, result);
  console.log(`[agent:${identity.name}] Session ready. Messages: ${session.messages.length}`);
  return result;
}

// ── Main conversation helpers ──────────────────────────────────────────────

export async function runMessage(
  userMessage: string,
  messageTs: number,
  msgCtx?: MsgContext,
  onDelta?: (accumulated: string) => void,
  onToolCall?: (name: string, args: unknown) => void,
  onToolResult?: (name: string, args: unknown, result: unknown) => void,
): Promise<RunResult> {
  return withLock(MAIN, async () => {
    const { session, sessionManager } = await getOrCreateSession(MAIN);

    if (msgCtx) currentMsgCtx.set(MAIN_CONVERSATION, msgCtx);

    const synced = syncLogToContext(sessionManager, messageTs);
    if (synced > 0) {
      session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
      console.log(`[agent:main] Synced ${synced} messages from log`);
    }

    session.agent.setSystemPrompt(buildSystemPrompt(MAIN));

    let text = "";
    const unsub = session.subscribe(event => {
      if (event.type === "message_update") {
        const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
        if (e.assistantMessageEvent?.type === "text_delta") {
          text += e.assistantMessageEvent.delta ?? "";
          onDelta?.(text);
        }
      }
      if (event.type === "tool_execution_start") {
        const e = event as unknown as { toolName: string; args: unknown };
        onToolCall?.(e.toolName, e.args);
      }
      if (event.type === "tool_execution_end") {
        const e = event as unknown as { toolName: string; args: unknown; result: unknown };
        onToolResult?.(e.toolName, e.args, e.result);
      }
    });

    try {
      await session.prompt(userMessage);
    } finally {
      unsub();
    }

    return { text: text.trim() };
  });
}

export async function runProactive(prompt: string): Promise<void> {
  await withLock(MAIN, async () => {
    const { session } = await getOrCreateSession(MAIN);
    session.agent.setSystemPrompt(buildSystemPrompt(MAIN));

    let text = "";
    const unsub = session.subscribe(event => {
      if (event.type === "message_update") {
        const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
        if (e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta ?? "";
      }
    });
    try {
      await session.prompt(`[SCHEDULER] ${prompt}`);
    } finally {
      unsub();
    }

    const trimmed = text.trim();
    if (!trimmed || trimmed.includes(SILENT_TOKEN)) {
      console.log("[agent:main] Scheduler: silent");
      return;
    }
    console.log(`[agent:main] Scheduler sending: ${trimmed.slice(0, 60)}…`);
    await notifyOwner(trimmed);
  });
}

// ── Tool formatting (used by bot.ts for streaming status) ─────────────────

export function formatToolCall(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown>;
  const p = (s: string) => s.replace(process.env["HOME"] ?? "", "~");
  switch (toolName) {
    case "bash":  return `⚙️ bash: ${String(a["command"] ?? "").replace(/\n/g, " ").slice(0, 60)}`;
    case "read":  return `📖 read: ${p(String(a["path"] ?? ""))}`;
    case "edit":  return `✏️ edit: ${p(String(a["path"] ?? ""))}`;
    case "write": return `📝 write: ${p(String(a["path"] ?? ""))}`;
    case "spawn_agent": return `🤖 spawn: ${String(a["task"] ?? "").slice(0, 50)}`;
    default:      return `🔧 ${toolName}`;
  }
}

export function formatToolResult(toolName: string, args: unknown, result: unknown): string {
  const a = args as Record<string, unknown>;
  const p = (s: string) => s.replace(process.env["HOME"] ?? "", "~");
  const r = result as { content?: Array<{ type: string; text?: string }> } | null;
  const lines = r?.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("").split("\n").length ?? 0;
  const n = lines > 1 ? ` (${lines} lines)` : "";
  switch (toolName) {
    case "bash":  return `✓ bash: ${String(a["command"] ?? "").replace(/\n/g, " ").slice(0, 50)}${n}`;
    case "read":  return `✓ read: ${p(String(a["path"] ?? ""))}${n}`;
    case "edit":  return `✓ edit: ${p(String(a["path"] ?? ""))}`;
    case "write": return `✓ write: ${p(String(a["path"] ?? ""))}`;
    default:      return `✓ ${toolName}`;
  }
}
