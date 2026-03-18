/**
 * store.ts — persistence: state.json + log.jsonl
 *
 * Layout:
 *   ~/.pi/tg/
 *     state.json               — Telegram offset + scheduler state
 *     log.jsonl                — all messages (user + bot), append-only
 *
 *   ~/.pi/agent/sessions/leaf/
 *     main.jsonl               — pi SDK session (standard format, visible in `pi -r`)
 *     subagent-<id>.jsonl      — sub-agent sessions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LogEntry {
  readonly date: string;        // ISO 8601
  readonly ts: number;          // unix ms
  readonly role: "user" | "bot";
  readonly text: string;
  readonly sentText?: string;   // what telegram actually received (bot only — for debugging delivery)
  readonly updateId?: number;   // Telegram update_id — for dedup
  readonly messageId?: number;  // Telegram message_id — for reply_parameters
}

export interface State {
  offset: number;                          // next Telegram update_id to fetch
  schedulerLastRun: Record<string, number>; // mode → unix ms of last run
}

// ── Paths ──────────────────────────────────────────────────────────────────

const STATE_FILE = join(PATHS.data, "state.json");
const LOG_FILE   = join(PATHS.data, "log.jsonl");

/** Standard pi sessions dir — all sessions visible in `pi -r` */
export const PI_SESSIONS_DIR = join(PATHS.agentDir, "sessions", "leaf");

/** pi SDK session file for a named session (main or sub-agent) */
export function sessionFile(name: string): string {
  return join(PI_SESSIONS_DIR, `${name}.jsonl`);
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initStore(): void {
  mkdirSync(PATHS.data, { recursive: true });
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
}

// ── State ──────────────────────────────────────────────────────────────────

function defaultState(): State {
  return { offset: 0, schedulerLastRun: {} };
}

export function readState(): State {
  if (!existsSync(STATE_FILE)) return defaultState();
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State; }
  catch { return defaultState(); }
}

export function writeState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function updateState(fn: (s: State) => void): State {
  const s = readState();
  fn(s);
  writeState(s);
  return s;
}

// ── Log ────────────────────────────────────────────────────────────────────

export async function appendLog(entry: LogEntry): Promise<void> {
  await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

export function readLog(): LogEntry[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as LogEntry]; }
      catch { return []; }
    });
}

/** update_ids already processed — for dedup */
export function seenUpdateIds(): Set<number> {
  return new Set(
    readLog()
      .filter(e => e.role === "user" && e.updateId != null)
      .map(e => e.updateId as number),
  );
}
