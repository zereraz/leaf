/**
 * config.ts — single source of truth for all configuration.
 * Env vars override defaults where applicable.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

const LEAF_HOME = join(HOME, "leaf");

export const TG = {
  botToken: process.env["TG_BOT_TOKEN"] ?? "",
  ownerChatId: Number(process.env["TG_CHAT_ID"] ?? ""),
  get apiBase() { return `https://api.telegram.org/bot${this.botToken}`; },
  pollTimeoutSecs: 30,
  maxMessageLen: 4000,
} as const;

export const PATHS = {
  home: HOME,
  leafHome: LEAF_HOME,
  data: join(LEAF_HOME, "data"),
  agentDir: join(HOME, ".pi", "agent"),       // auth/models — shared with pi coding agent
  projects: join(LEAF_HOME, "memory", "projects.md"),
  memory: join(LEAF_HOME, "MEMORY.md"),
  user: join(LEAF_HOME, "USER.md"),
  dailyLogs: join(LEAF_HOME, "memory"),
  /** User's writing/docs paths — one per line in this file. Pi reads these to know the user's voice. */
  writingPaths: join(LEAF_HOME, "writing-paths.txt"),
} as const;

export const SCHEDULER = {
  intervalMs: 90 * 60 * 1000,
  tz: "Asia/Calcutta",
  activeHours: { start: 8, end: 23 },
  // Minimum seconds between each mode firing
  cooldowns: {
    morning_brief: 20 * 3600,
    pulse: 2 * 3600,
    evening_wrap: 20 * 3600,
    stale_review: 6 * 24 * 3600,
  } as Record<SchedulerMode, number>,
} as const;

export const SILENT_TOKEN = "PI_SILENT";
export const MAIN_CONVERSATION = "main";

export type SchedulerMode =
  | "morning_brief"
  | "pulse"
  | "evening_wrap"
  | "stale_review";
