/**
 * agent.ts — pi SDK session management.
 *
 * Supports per-user sessions for WhatsApp multi-user scenarios.
 * Each user gets their own AgentSession with isolated conversation history.
 *
 * Auth via pi's standard AuthStorage (env vars: AWS_BEARER_TOKEN_BEDROCK etc.)
 * System prompt rebuilt fresh on every run from memory files.
 */
import { join } from "node:path";
import { statSync } from "node:fs";
import { execSync } from "node:child_process";
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
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// Dynamic system prompt extension - gets prompt from context
const systemPromptExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", async (_event, ctx) => {
    // Get the prompt from the session identity stored in context
    const sessionId = (ctx as unknown as { sessionId?: string }).sessionId ?? "main";
    const prompt = getSystemPromptForSession(sessionId);
    return { systemPrompt: prompt };
  });
};

// Store per-session system prompts
const sessionSystemPrompts = new Map<string, string>();

function setSystemPromptForSession(sessionId: string, prompt: string): void {
  sessionSystemPrompts.set(sessionId, prompt);
}

function getSystemPromptForSession(sessionId: string): string {
  return sessionSystemPrompts.get(sessionId) ?? buildSystemPrompt(MAIN);
}
import { PATHS, MAIN_CONVERSATION, SILENT_TOKEN } from "./config.js";
import { sessionFile, PI_SESSIONS_DIR, initStore } from "./store.js";
import { syncLogToContext } from "./context.js";
import { readProjects, readMemory, readUser, readTodayLog } from "./memory.js";
import { notifyOwner } from "./telegram.js";
import { acquireFileLock } from "./lock.js";
import { spawnSubAgent, activeSubAgents } from "./subagent.js";
import { requestReview } from "./review-agent.js";
import { webSearchTool } from "./tools/web-search.js";
import { webFetchTool } from "./tools/web-fetch.js";
import { todoTool } from "./tools/todo.js";

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

/** Pre-warm the main session at startup so first message is instant. */
export async function warmupSession(): Promise<void> {
  try {
    await getOrCreateSession(MAIN);
    console.log("[agent] Session warmed up.");
  } catch (err) {
    console.warn("[agent] Warmup failed (non-fatal):", (err as Error).message);
  }
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
    cwd:     Type.Optional(Type.String({ description: "Working directory (e.g. ~/Code/myproject)" })),
    context: Type.Optional(Type.String({ description: "Extra context to pass (file paths, notes)" })),
  }),
  execute: async (_id, params) => {
    const p = params as { task: string; cwd?: string; context?: string };
    const ctx = currentMsgCtx.get(MAIN_CONVERSATION);
    if (!ctx) return { content: [{ type: "text" as const, text: "Error: no message context" }], details: {} };

    spawnCounter++;
    const agentId = `agent-${spawnCounter}`;
    await spawnSubAgent({
      id: agentId,
      task: p.task,
      chatId: ctx.chatId,
      replyToMsgId: ctx.replyToMsgId,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(p.context ? { context: p.context } : {}),
    });

    return {
      content: [{ type: "text" as const, text: `Sub-agent "${agentId}" spawned — will reply directly to you.` }],
      details: {},
    };
  },
};

/**
 * restart_bot — review changes then reload the daemon.
 * MUST pass review-agent before launchctl reload is called.
 * The bot enforces this: it will not restart without a passing review.
 */
const restartBotTool: ToolDefinition = {
  name: "restart_bot",
  label: "Restart Bot (review gate)",
  description: [
    "Submit code changes for review. The review agent runs tsc, tests, scope check, and diff analysis.",
    "It has its own session and remembers all previous attempts.",
    "If checks fail, it tells you exactly what to fix — fix it and call this again.",
    "Only restarts when the review agent approves. You cannot bypass this.",
  ].join(" "),
  parameters: Type.Object({
    note: Type.Optional(Type.String({ description: "What you changed and why (helps the review agent)" })),
  }),
  execute: async (_id, params: { note?: string }) => {
    const result = await requestReview(params.note);
    if (result.approved) {
      setTimeout(() => {
        try {
          execSync(
            `launchctl unload ~/Library/LaunchAgents/ai.leaf.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/ai.leaf.plist`,
            { shell: "/bin/bash", timeout: 15_000, env: { ...process.env, HOME: PATHS.home } },
          );
        } catch { /* process exits on restart — expected */ }
      }, 2000);
    }
    return {
      content: [{ type: "text" as const, text: result.report }],
      details: { approved: result.approved },
    };
  },
};

import { readContextBrief } from "./context-agent.js";

// ── System prompt — cached per identity, rebuilds only when files change ───

interface PromptCache {
  prompt: string;
  builtAt: number;
  mtimes: string;
}

// Per-identity prompt cache to prevent Telegram/WhatsApp prompt mixing
const promptCaches = new Map<string, PromptCache>();
const PROMPT_TTL_MS = 60_000; // max 1 min stale

function promptFileMtimes(): string {
  return [PATHS.projects, PATHS.memory, PATHS.user].map(p => {
    try { return statSync(p).mtimeMs; } catch { return 0; }
  }).join(",");
}

function buildSystemPrompt(identity: SessionIdentity): string {
  const now = Date.now();
  const mtimes = promptFileMtimes();

  // Per-identity cache lookup
  const cached = promptCaches.get(identity.name);
  if (cached && (now - cached.builtAt < PROMPT_TTL_MS) && cached.mtimes === mtimes) {
    return cached.prompt;
  }

  const running = activeSubAgents();
  const prompt = `You are pi — saheb's always-on AI companion on Telegram.${identity.cwd ? `\nWorking directory: ${identity.cwd}` : ""}

## User
${readUser() || "Name: Sahebjot (saheb). Timezone: Asia/Calcutta."}

## What saheb is currently focused on
${readContextBrief()}

## Projects memory
${readProjects()}

## Long-term memory
${readMemory()}

## Active sub-agents
${running.length > 0 ? running.map(a => `• ${a.id}: ${a.task.slice(0, 60)}`).join("\n") : "none"}

## Behavior
- Concise on Telegram — readable on mobile, no markdown headers
- Use rg for searching, fd for finding (not grep/find)
- **Engage, don't just answer** — if you notice something relevant to what saheb is working on, say it. Connect dots. Ask questions that show you understand the work.
- When saheb sends a message after a long gap, acknowledge the gap naturally
- Scheduler prompts ([SCHEDULER:mode]): use the context brief above to say something SPECIFIC, not generic. Reply ${SILENT_TOKEN} if nothing genuine to say.
- When saheb shares decisions or thoughts: save them to ~/leaf/memory/projects.md
- For code, files, multi-step tasks: use spawn_agent — it runs in parallel and keeps you free
- **After making any code change to leaf: ALWAYS call restart_bot — never use launchctl directly**
  - restart_bot runs tsc + tests + LLM diff review before restarting
  - If review fails it reports what's wrong without restarting
  - This is the safety gate — never bypass it
- For quick answers, lookups, memory updates: respond yourself

## Web Search & Research
You have access to web search and research tools. Use them to answer questions:
- **web_search**: Search Google for information (news, scholar, patents, general)
- **web_fetch**: Fetch full content from URLs found in search results
- **todo**: Track multi-step research tasks
When asked a question, search for it first, then cite sources with URLs.`;

  promptCaches.set(identity.name, { prompt, builtAt: now, mtimes });
  return prompt;
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

  // Store system prompt for this session
  const systemPrompt = buildSystemPrompt(identity);
  setSystemPromptForSession(identity.name, systemPrompt);

  // Use extension factories to hook into pi's lifecycle (like nama does)
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: PATHS.agentDir,
    settingsManager,
    extensionFactories: [systemPromptExtension],
  });
  await loader.reload();

  // Core coding tools + agentic tools (web search, fetch, todo) + leaf-specific tools
  const agenticTools = [webSearchTool, webFetchTool, todoTool] as any[];

  const tools = identity.name === MAIN_CONVERSATION
    ? [...codingTools, ...agenticTools, spawnAgentTool as any, restartBotTool as any]
    : [...codingTools, ...agenticTools];

  const { session } = await createAgentSession({
    cwd, agentDir: PATHS.agentDir,
    authStorage, modelRegistry, settingsManager,
    sessionManager: sm, resourceLoader: loader, tools,
  });

  // Extension handles system prompt via before_agent_start hook

  // Name the session so it shows correctly in `pi -r`
  const displayName = `Telegram — ${identity.name}`;
  if (sm.getSessionName() !== displayName) sm.appendSessionInfo(displayName);

  const result: CachedSession = { session, sessionManager: sm };
  cache.set(identity.name, result);
  console.log(`[agent:${identity.name}] Session ready. Messages: ${session.messages.length}`);
  return result;
}

// ── Per-user session helpers ───────────────────────────────────────────────

interface UserMsgContext { chatId: number; replyToMsgId: number; userPhone: string }
const userMsgCtx = new Map<string, MsgContext>();

/**
 * Build a user-specific system prompt.
 * Similar to buildSystemPrompt but personalized per user.
 */
function buildUserSystemPrompt(identity: SessionIdentity, userPhone: string): string {
  const now = Date.now();
  const mtimes = promptFileMtimes();

  // Per-identity cache lookup (prevents mixing with Telegram prompts)
  const cached = promptCaches.get(identity.name);
  if (cached && (now - cached.builtAt < PROMPT_TTL_MS) && cached.mtimes === mtimes) {
    return cached.prompt;
  }

  const running = activeSubAgents();
  const prompt = `You are leaf — an AI assistant on WhatsApp.
You are chatting with user: ${userPhone}
${identity.cwd ? `\nWorking directory: ${identity.cwd}` : ""}

## User
Phone: ${userPhone}
${readUser() || "Timezone: Asia/Calcutta."}

## What user is currently focused on
${readContextBrief()}

## Projects memory
${readProjects()}

## Long-term memory
${readMemory()}

## Active sub-agents
${running.length > 0 ? running.map(a => `• ${a.id}: ${a.task.slice(0, 60)}`).join("\n") : "none"}

## Behavior
- Concise responses — readable on mobile, no markdown headers
- Use rg for searching, fd for finding (not grep/find)
- **DO NOT assume the user's name is "saheb"** — use generic greetings like "Hey!" or "Hi there!" unless you know their actual name
- **Engage, don't just answer** — if you notice something relevant to what the user is working on, say it. Connect dots. Ask questions that show you understand the work.
- When user sends a message after a long gap, acknowledge the gap naturally
- For code, files, multi-step tasks: use spawn_agent — it runs in parallel and keeps you free
- **After making any code change to leaf: ALWAYS call restart_bot — never use launchctl directly**
  - restart_bot runs tsc + tests + LLM diff review before restarting
  - If review fails it reports what's wrong without restarting
  - This is the safety gate — never bypass it
- For quick answers, lookups, memory updates: respond yourself

## Web Search & Research
You have access to web search and research tools. Use them aggressively to answer questions:

- **web_search**: Search Google for information. Supports news, scholar (academic papers), patents, and general search.
  - Use tbs="qdr:d" for past day, "qdr:w" for past week for recent info
  - Use gl="in" for India results, "us" for US results
  - Make multiple targeted searches rather than one broad one
- **web_fetch**: Fetch full content from URLs found in search results
- **todo**: Track multi-step research tasks with a todo list

When asked a question:
1. Search for it first (use web_search)
2. If you find promising URLs, fetch them for full context (use web_fetch)
3. Always cite sources with URLs in your answer
4. For complex research (3+ steps), create todos to track progress

Be thorough but concise. Prioritize actionable insights over exhaustive listing.`;

  promptCaches.set(identity.name, { prompt, builtAt: now, mtimes });
  return prompt;
}

/**
 * Run a message for a specific user (WhatsApp phone number).
 * Each user gets their own isolated AgentSession.
 */
export async function runMessageForUser(
  userPhone: string,
  userMessage: string,
  messageTs: number,
  msgCtx?: UserMsgContext,
  onDelta?: (accumulated: string) => void,
  onToolCall?: (name: string, args: unknown) => void,
  onToolResult?: (name: string, args: unknown, result: unknown) => void,
): Promise<RunResult> {
  const userIdentity: SessionIdentity = {
    name: `user-${userPhone}`,
    description: `Session for WhatsApp user ${userPhone}`,
  };

  return withLock(userIdentity, async () => {
    const { session, sessionManager } = await getOrCreateSession(userIdentity);

    if (msgCtx) {
      const baseCtx: MsgContext = { chatId: msgCtx.chatId, replyToMsgId: msgCtx.replyToMsgId };
      userMsgCtx.set(userIdentity.name, baseCtx);
      currentMsgCtx.set(userIdentity.name, baseCtx);
    }

    const synced = syncLogToContext(sessionManager, messageTs);
    if (synced > 0) {
      session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
      console.log(`[agent:${userIdentity.name}] Synced ${synced} messages from log`);
    }

    // Update system prompt for this user session (extension will use it via before_agent_start hook)
    setSystemPromptForSession(userIdentity.name, buildUserSystemPrompt(userIdentity, userPhone));

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

// ── Main conversation helpers (legacy - for Telegram) ───────────────────────

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

    // Update system prompt for main session (extension will use it via before_agent_start hook)
    setSystemPromptForSession(MAIN_CONVERSATION, buildSystemPrompt(MAIN));

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
    // Update system prompt for proactive session (extension will use it via before_agent_start hook)
    setSystemPromptForSession(MAIN_CONVERSATION, buildSystemPrompt(MAIN));

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
