/**
 * config.ts — single source of truth for all configuration.
 * Env vars override defaults where applicable.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

const PI_TG_HOME = join(HOME, "pi-tg");

export const TG = {
  botToken: process.env["TG_BOT_TOKEN"] ?? "REDACTED",
  ownerChatId: Number(process.env["TG_CHAT_ID"] ?? REDACTED_CHAT_ID),
  get apiBase() { return `https://api.telegram.org/bot${this.botToken}`; },
  pollTimeoutSecs: 30,
  maxMessageLen: 4000,
} as const;

export const PATHS = {
  home: HOME,
  piTgHome: PI_TG_HOME,
  data: join(PI_TG_HOME, "data"),
  agentDir: join(HOME, ".pi", "agent"),       // auth/models — shared with pi coding agent
  projects: join(PI_TG_HOME, "memory", "projects.md"),
  memory: join(PI_TG_HOME, "MEMORY.md"),
  user: join(PI_TG_HOME, "USER.md"),
  dailyLogs: join(PI_TG_HOME, "memory"),
  igne: join(HOME, "Library/Mobile Documents/com~apple~CloudDocs/igne/cloud-v1"),
  codeDirs: [join(HOME, "Code/Zereraz"), join(HOME, "Code/Juspay")],
} as const;

export const SCHEDULER = {
  intervalMs: 90 * 60 * 1000,
  tz: "Asia/Calcutta",
  activeHours: { start: 8, end: 23 },
  // Minimum seconds between each mode firing
  cooldowns: {
    morning_brief: 20 * 3600,
    pulse: 2 * 3600,
    igne_surface: 22 * 3600,
    evening_wrap: 20 * 3600,
    stale_review: 6 * 24 * 3600,
  } as Record<SchedulerMode, number>,
} as const;

export const SILENT_TOKEN = "PI_SILENT";
export const MAIN_CONVERSATION = "main";

export type SchedulerMode =
  | "morning_brief"
  | "pulse"
  | "igne_surface"
  | "evening_wrap"
  | "stale_review";
