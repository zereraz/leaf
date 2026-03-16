/**
 * store.ts — all persistence: state.json + per-conversation log.jsonl
 *
 * Layout:
 *   ~/.pi/tg/
 *     state.json              — offset, activeConversation, conversation registry
 *     conversations/
 *       <name>/
 *         log.jsonl           — all messages (user + bot), append-only
 *         context.jsonl       — pi SDK session (managed by SessionManager)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, MAIN_CONVERSATION } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LogEntry {
  readonly date: string;       // ISO 8601
  readonly ts: number;         // unix ms
  readonly role: "user" | "bot";
  readonly text: string;
  readonly updateId?: number;  // Telegram update_id, for dedup
}

export interface ConversationMeta {
  readonly name: string;
  readonly description: string;
  readonly cwd?: string;       // working dir override (e.g. a specific project)
  readonly createdAt: string;  // ISO 8601
}

export interface State {
  offset: number;                                 // next Telegram update_id
  activeConversation: string;                     // current conversation name
  conversations: Record<string, ConversationMeta>; // all registered conversations
  schedulerLastRun: Record<string, number>;       // mode → unix ms
}

// ── Paths ──────────────────────────────────────────────────────────────────

const STATE_FILE = join(PATHS.data, "state.json");
const CONVS_DIR = join(PATHS.data, "conversations");

export function conversationDir(name: string): string {
  return join(CONVS_DIR, name);
}
export function logFile(name: string): string {
  return join(conversationDir(name), "log.jsonl");
}
export function contextFile(name: string): string {
  return join(conversationDir(name), "context.jsonl");
}

// ── Init ───────────────────────────────────────────────────────────────────

export function ensureDirs(name: string): void {
  mkdirSync(conversationDir(name), { recursive: true });
}

export function initStore(): void {
  mkdirSync(PATHS.data, { recursive: true });
  mkdirSync(CONVS_DIR, { recursive: true });
  // Ensure main conversation exists
  const state = readState();
  if (!state.conversations[MAIN_CONVERSATION]) {
    state.conversations[MAIN_CONVERSATION] = {
      name: MAIN_CONVERSATION,
      description: "Primary assistant",
      createdAt: new Date().toISOString(),
    };
    writeState(state);
  }
  ensureDirs(MAIN_CONVERSATION);
}

// ── State ──────────────────────────────────────────────────────────────────

function defaultState(): State {
  return {
    offset: 0,
    activeConversation: MAIN_CONVERSATION,
    conversations: {},
    schedulerLastRun: {},
  };
}

export function readState(): State {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
  } catch {
    return defaultState();
  }
}

export function writeState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function updateState(fn: (s: State) => void): State {
  const state = readState();
  fn(state);
  writeState(state);
  return state;
}

// ── Log ────────────────────────────────────────────────────────────────────

export async function appendLog(conversation: string, entry: LogEntry): Promise<void> {
  ensureDirs(conversation);
  await appendFile(logFile(conversation), JSON.stringify(entry) + "\n", "utf-8");
}

export function readLog(conversation: string): LogEntry[] {
  const file = logFile(conversation);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as LogEntry]; }
      catch { return []; }
    });
}

/** Returns the set of update_ids already in the log (for dedup). */
export function seenUpdateIds(conversation: string): Set<number> {
  return new Set(
    readLog(conversation)
      .filter(e => e.role === "user" && e.updateId != null)
      .map(e => e.updateId as number)
  );
}
