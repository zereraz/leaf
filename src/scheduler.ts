/**
 * scheduler.ts — proactive engagement modes.
 * Runs inside the bot process on setInterval. Checks IST time + cooldowns.
 */
import { SCHEDULER, SILENT_TOKEN, type SchedulerMode } from "./config.js";
import { readState, updateState } from "./store.js";
import { runProactive } from "./agent.js";
import { gatherContext, readContextBrief } from "./context-agent.js";
import {
  readProjects, readTodayLog,
  recentGitActivity, hottestRepo, allRepoActivity, gitLog, gitDiffStat,
} from "./memory.js";

// ── Time helpers ───────────────────────────────────────────────────────────

function istHour(): number {
  return parseInt(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: SCHEDULER.tz }), 10);
}
function istDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: SCHEDULER.tz });
}
function istWeek(): string {
  const d = new Date();
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function cooldownOk(mode: SchedulerMode): boolean {
  const last = readState().schedulerLastRun[mode] ?? 0;
  return (Date.now() - last) >= SCHEDULER.cooldowns[mode] * 1000;
}

function lastKey(mode: SchedulerMode): string {
  return (readState().schedulerLastRun[`${mode}:key`] as unknown as string) ?? "";
}

function markRan(mode: SchedulerMode, key: string): void {
  updateState(s => {
    s.schedulerLastRun[mode] = Date.now();
    (s.schedulerLastRun as Record<string, unknown>)[`${mode}:key`] = key;
  });
}

// ── Mode selection ─────────────────────────────────────────────────────────

function pickMode(): SchedulerMode | null {
  const hour = istHour();
  const today = istDate();
  const week = istWeek();
  const { start, end } = SCHEDULER.activeHours;

  if (hour < start || hour >= end) return null;

  if (hour >= 8 && hour < 10 && lastKey("morning_brief") !== today && cooldownOk("morning_brief"))
    return "morning_brief";

  if (hour >= 20 && hour < 22 && lastKey("evening_wrap") !== today && cooldownOk("evening_wrap"))
    return "evening_wrap";

  const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: SCHEDULER.tz });
  if (dayName === "Sunday" && lastKey("stale_review") !== week && cooldownOk("stale_review"))
    return "stale_review";

  if (hour >= 10 && hour < 20 && cooldownOk("pulse"))
    return "pulse";

  return null;
}

// ── Prompts ────────────────────────────────────────────────────────────────

function promptFor(mode: SchedulerMode): string {
  // Context brief is always fresh (gathered just before this call in tick())
  const context = readContextBrief();

  switch (mode) {
    case "morning_brief":
      return `[SCHEDULER:morning_brief] Morning brief for saheb.

## What he's been working on
${context}

Pick the ONE thing with most momentum right now. Say what it is, why it matters today, one concrete next step. 3 lines max. Plain text. ${SILENT_TOKEN} if nothing genuine.`;

    case "pulse":
      return `[SCHEDULER:pulse] Check in on what saheb is currently building.

## Current focus synthesis
${context}

Surface the most interesting thing happening right now — the actual direction, an open question, or what the next decision probably is. 2-3 lines. ${SILENT_TOKEN} if nothing specific stands out.`;

    case "evening_wrap":
      return `[SCHEDULER:evening_wrap] Evening check-in.

## What happened today
${context}

Reflect on what was built or decided today. Something specific worth capturing, or a question about tomorrow. 2 lines. ${SILENT_TOKEN} if nothing.`;

    case "stale_review":
      return `[SCHEDULER:stale_review] Weekly: anything gone cold that saheb probably intended to continue?

## Current focus (what's active)
${context}

## All repos
${allRepoActivity()}

1-2 projects: cold (3+ weeks) but probably still relevant. Ask "still in play?" Specific, not generic. ${SILENT_TOKEN} if nothing concerning.`;
  }
}

// ── Tick + start/stop ──────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const mode = pickMode();
  if (!mode) {
    console.log(`[scheduler] Idle. Hour=${istHour()} IST`);
    return;
  }

  console.log(`[scheduler] Running: ${mode}`);

  // Refresh context brief before crafting proactive message
  // so the main agent has real synthesis of what saheb is doing
  await gatherContext().catch(err => console.warn("[scheduler] context gather failed:", err));

  try {
    await runProactive(promptFor(mode));
    markRan(mode, mode === "stale_review" ? istWeek() : istDate());
  } catch (err) {
    console.error(`[scheduler] ${mode} error:`, err);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  console.log(`[scheduler] Started. Interval=${SCHEDULER.intervalMs / 60_000}m`);
  void tick();
  timer = setInterval(() => void tick(), SCHEDULER.intervalMs);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export async function forceMode(mode: SchedulerMode): Promise<void> {
  await runProactive(promptFor(mode));
}
