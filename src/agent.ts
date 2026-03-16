/**
 * agent.ts — pi SDK session management.
 *
 * One AgentSession per conversation, each backed by its own context.jsonl.
 * Auth via pi's standard AuthStorage — reads ~/.pi/agent/auth.json
 * plus env vars (AWS_BEARER_TOKEN_BEDROCK, AWS_ACCESS_KEY_ID, etc.).
 * System prompt rebuilt fresh on every run from memory files.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  codingTools,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { PATHS, SILENT_TOKEN } from "./config.js";
import type { ConversationMeta } from "./store.js";
import { contextFile, ensureDirs } from "./store.js";
import { syncLogToContext } from "./context.js";
import {
  readProjects, readMemory, readUser, readIgneIndex, readTodayLog,
} from "./memory.js";
import { notifyOwner } from "./telegram.js";

// ── Session cache ──────────────────────────────────────────────────────────

interface CachedSession {
  session: AgentSession;
  sessionManager: SessionManager;
}

const cache = new Map<string, CachedSession>();

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(meta: ConversationMeta, allConversations: string[]): string {
  const user = readUser();
  const projects = readProjects();
  const memory = readMemory();
  const today = readTodayLog();
  const igne = readIgneIndex();
  const otherConvs = allConversations.filter(c => c !== meta.name);

  return `You are pi — saheb's always-on AI companion running as a Telegram bot.
Conversation: "${meta.name}" — ${meta.description}

## User
${user || "Name: Sahebjot (saheb). Timezone: Asia/Calcutta."}

## This session
You are running in conversation "${meta.name}".${meta.cwd ? `\nWorking directory: ${meta.cwd}` : ""}
${otherConvs.length > 0 ? `\nOther active conversations: ${otherConvs.join(", ")}` : ""}

## Today
${today}

## Projects
${projects}

## Long-term memory
${memory}

## Igne notes index
${igne}

## Behavior
- Concise on Telegram — no markdown headers, keep it readable on mobile
- Use rg (ripgrep) for searching files, fd for finding — not grep/find
- When saheb shares decisions or thoughts, write them to ~/clawd/memory/projects.md
- When the scheduler triggers you ([SCHEDULER:mode]), reply ${SILENT_TOKEN} if nothing worth saying
- You can run bash commands on saheb's machine
- To send a Telegram message: curl -s -X POST ${process.env["TG_API_BASE"] ?? "https://api.telegram.org/botREDACTED"}/sendMessage -d "chat_id=REDACTED_CHAT_ID&text=..."`;
}

// ── Session factory ────────────────────────────────────────────────────────

export async function getOrCreateSession(
  meta: ConversationMeta,
  allConversations: string[],
): Promise<CachedSession> {
  const cached = cache.get(meta.name);
  if (cached) return cached;

  ensureDirs(meta.name);
  const cwd = meta.cwd ?? PATHS.data;

  const authStorage = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
  const settingsManager = SettingsManager.create(cwd, PATHS.agentDir);
  const sessionManager = SessionManager.open(contextFile(meta.name), conversationDir(meta.name));

  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: PATHS.agentDir, settingsManager });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: PATHS.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: codingTools,
  });

  // Set initial system prompt
  session.agent.setSystemPrompt(buildSystemPrompt(meta, allConversations));

  const result: CachedSession = { session, sessionManager };
  cache.set(meta.name, result);

  console.log(`[agent:${meta.name}] Session ready. Messages: ${session.messages.length}`);
  return result;
}

// ── evict ──────────────────────────────────────────────────────────────────

export function evictSession(name: string): void {
  cache.delete(name);
}

// ── Run ────────────────────────────────────────────────────────────────────

export interface RunResult {
  readonly text: string;
}

export async function runMessage(
  meta: ConversationMeta,
  allConversations: string[],
  userMessage: string,
  messageTs: number,
): Promise<RunResult> {
  const { session, sessionManager } = await getOrCreateSession(meta, allConversations);

  // Sync any messages logged while we were offline
  const synced = syncLogToContext(sessionManager, meta.name, messageTs);
  if (synced > 0) {
    const ctx = sessionManager.buildSessionContext();
    session.agent.replaceMessages(ctx.messages);
    console.log(`[agent:${meta.name}] Synced ${synced} messages from log`);
  }

  // Refresh system prompt with latest memory
  session.agent.setSystemPrompt(buildSystemPrompt(meta, allConversations));

  let text = "";
  const unsub = session.subscribe(event => {
    if (event.type === "message_update") {
      const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") {
        text += e.assistantMessageEvent.delta ?? "";
      }
    }
  });

  try {
    await session.prompt(userMessage);
  } finally {
    unsub();
  }

  return { text: text.trim() };
}

/** Run a proactive scheduler prompt. Sends Telegram only if non-silent. */
export async function runProactive(
  meta: ConversationMeta,
  allConversations: string[],
  prompt: string,
): Promise<void> {
  const { session } = await getOrCreateSession(meta, allConversations);
  session.agent.setSystemPrompt(buildSystemPrompt(meta, allConversations));

  let text = "";
  const unsub = session.subscribe(event => {
    if (event.type === "message_update") {
      const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") {
        text += e.assistantMessageEvent.delta ?? "";
      }
    }
  });

  try {
    await session.prompt(`[SCHEDULER] ${prompt}`);
  } finally {
    unsub();
  }

  const trimmed = text.trim();
  if (!trimmed || trimmed.includes(SILENT_TOKEN)) {
    console.log(`[agent:${meta.name}] Scheduler: silent`);
    return;
  }

  console.log(`[agent:${meta.name}] Scheduler sending: ${trimmed.slice(0, 60)}…`);
  await notifyOwner(trimmed);
}

// ── Helpers re-exported ────────────────────────────────────────────────────

function conversationDir(name: string): string {
  return join(PATHS.data, "conversations", name);
}
