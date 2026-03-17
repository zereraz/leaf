/**
 * scheduler.ts — proactive engagement modes.
 * Runs inside the bot process on setInterval. Checks IST time + cooldowns.
 */
import { SCHEDULER, SILENT_TOKEN, type SchedulerMode } from "./config.js";
import { readState, updateState } from "./store.js";
import { runProactive } from "./agent.js";
import {
  readProjects, readIgneIndex, readIgneFile, readTodayLog,
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

  if (hour >= 12 && hour < 18 && lastKey("igne_surface") !== today && cooldownOk("igne_surface"))
    return "igne_surface";

  const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: SCHEDULER.tz });
  if (dayName === "Sunday" && lastKey("stale_review") !== week && cooldownOk("stale_review"))
    return "stale_review";

  if (hour >= 10 && hour < 20 && cooldownOk("pulse"))
    return "pulse";

  return null;
}

// ── Prompts ────────────────────────────────────────────────────────────────

function promptFor(mode: SchedulerMode): string {
  switch (mode) {
    case "morning_brief": {
      const activity = recentGitActivity(7).map(r => `- ${r.name} (${r.commitCount}): ${r.lastCommit}`).join("\n");
      return `[SCHEDULER:morning_brief] Morning brief.

Git activity (7d):
${activity || "(none)"}

Projects:
${readProjects()}

3-4 lines: the one project with most momentum, one concrete thing worth doing today. Plain text. ${SILENT_TOKEN} if nothing.`;
    }

    case "pulse": {
      const repo = hottestRepo();
      if (!repo) return `[SCHEDULER:pulse] ${SILENT_TOKEN}`;
      const commits = gitLog(repo.path, 8);
      const diff = gitDiffStat(repo.path);
      return `[SCHEDULER:pulse] Project pulse: ${repo.name} (${repo.commitCount} recent commits)

Commits:
${commits}
${diff ? `\nChanges: ${diff}` : ""}

Context:
${readProjects().split("\n").filter(l => l.toLowerCase().includes(repo.name.toLowerCase())).slice(0, 8).join("\n") || "(no notes)"}

2-3 lines: what's the current direction, any open question or next step. Plain text. ${SILENT_TOKEN} if nothing specific.`;
    }

    case "igne_surface": {
      const activity = recentGitActivity(14).map(r => r.name).join(", ");
      return `[SCHEDULER:igne_surface] Surface one igne note relevant to current work.

Igne index:
${readIgneIndex()}

Ideas note:
${readIgneFile("ideas.md")}

Active projects: ${activity}

Pick ONE note. Quote its key line. 1-2 sentences connecting it to current work. 3-4 lines total. ${SILENT_TOKEN} if no genuine connection.`;
    }

    case "evening_wrap": {
      const activity = recentGitActivity(1).map(r => `${r.name}: ${r.lastCommit}`).join("\n");
      return `[SCHEDULER:evening_wrap] Evening check-in.

Today's git activity:
${activity || "(no commits today)"}

Today's log:
${readTodayLog()}

1-2 lines reflecting on today — what shipped, anything worth capturing, or a gentle nudge. ${SILENT_TOKEN} if nothing.`;
    }

    case "stale_review": {
      return `[SCHEDULER:stale_review] Weekly stale project review.

All repos:
${allRepoActivity()}

Projects brain:
${readProjects()}

1-2 projects: no commits in 3+ weeks but appear in projects brain as ongoing. Ask "still in play?" for each. ${SILENT_TOKEN} if all is intentional.`;
    }
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
