/**
 * memory.ts — reads all context files for system prompt building.
 * Uses fd (fast file finder) and rg (ripgrep) — never plain find/grep.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS, SCHEDULER } from "./config.js";

// ── File readers ───────────────────────────────────────────────────────────

export function readFileSafe(path: string, fallback = ""): string {
  try { return readFileSync(path, "utf-8"); } catch { return fallback; }
}

export function readProjects(): string {
  return readFileSafe(PATHS.projects, "(no projects.md)");
}
export function readMemory(): string {
  return readFileSafe(PATHS.memory, "(no MEMORY.md)");
}
export function readUser(): string {
  return readFileSafe(PATHS.user, "");
}
export function readTodayLog(): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: SCHEDULER.tz });
  return readFileSafe(join(PATHS.dailyLogs, `${today}.md`), "(no log today)");
}

/** Read user's writing/docs paths from ~/leaf/writing-paths.txt (one path per line) */
export function readWritingPaths(): string[] {
  const raw = readFileSafe(PATHS.writingPaths, "");
  return raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

/** Read contents of user's writing samples (first ~500 chars each) */
export function readWritingSamples(): string {
  const paths = readWritingPaths();
  if (paths.length === 0) return "(no writing paths configured — add to ~/leaf/writing-paths.txt)";
  const samples: string[] = [];
  for (const p of paths) {
    const resolved = p.startsWith("~") ? p.replace("~", PATHS.home) : p;
    const content = readFileSafe(resolved, "");
    if (content) {
      samples.push(`--- ${p} ---\n${content.slice(0, 500)}${content.length > 500 ? "\n…" : ""}`);
    }
  }
  return samples.join("\n\n") || "(writing paths configured but all empty)";
}

// ── Git activity (fd + git) ────────────────────────────────────────────────

export interface RepoActivity {
  readonly name: string;
  readonly path: string;
  readonly commitCount: number;
  readonly lastCommit: string;
}

/** Discover code dirs dynamically from ~/Code */
function getCodeDirs(): string[] {
  const codeBase = join(PATHS.home, "Code");
  if (!existsSync(codeBase)) return [];
  try {
    return readdirSync(codeBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(codeBase, d.name));
  } catch { return []; }
}

function findGitDirs(bases: readonly string[], maxDepth = 3): string[] {
  const results: string[] = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    try {
      const out = execSync(
        `fd -t d -d ${maxDepth} --hidden "^\\.git$" "${base}"`,
        { encoding: "utf-8", timeout: 10_000 },
      );
      results.push(...out.trim().split("\n").filter(Boolean).map(p => p.replace(/\/?\.git\/?$/, "")));
    } catch { /* skip unreadable bases */ }
  }
  return results;
}

function gitCount(repoPath: string, since: string): number {
  try {
    const out = execSync(
      `git -C "${repoPath}" log --oneline --since="${since}" 2>/dev/null | wc -l`,
      { encoding: "utf-8", timeout: 5_000 },
    );
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

function gitLastCommit(repoPath: string): string {
  try {
    return execSync(
      `git -C "${repoPath}" log --oneline -1 --format="%ar — %s" 2>/dev/null`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
  } catch { return ""; }
}

export function recentGitActivity(days = 7): RepoActivity[] {
  return findGitDirs(getCodeDirs())
    .map(path => {
      const count = gitCount(path, `${days} days ago`);
      if (count === 0) return null;
      return {
        name: path.split("/").pop() ?? path,
        path,
        commitCount: count,
        lastCommit: gitLastCommit(path),
      } satisfies RepoActivity;
    })
    .filter((r): r is RepoActivity => r !== null)
    .sort((a, b) => b.commitCount - a.commitCount);
}

export function hottestRepo(hours = 48): RepoActivity | null {
  const repos = findGitDirs(getCodeDirs()).map(path => {
    const count = gitCount(path, `${hours} hours ago`);
    return { name: path.split("/").pop() ?? path, path, commitCount: count, lastCommit: gitLastCommit(path) };
  }).filter(r => r.commitCount > 0).sort((a, b) => b.commitCount - a.commitCount);

  if (repos.length > 0) return repos[0] ?? null;
  // Fallback: 7-day window
  return findGitDirs(getCodeDirs())
    .map(path => ({ name: path.split("/").pop() ?? path, path, commitCount: gitCount(path, "7 days ago"), lastCommit: gitLastCommit(path) }))
    .filter(r => r.commitCount > 0)
    .sort((a, b) => b.commitCount - a.commitCount)[0] ?? null;
}

export function allRepoActivity(): string {
  return findGitDirs(getCodeDirs())
    .map(path => {
      const last = gitLastCommit(path);
      return last ? `${path.split("/").pop()}: ${last}` : null;
    })
    .filter((r): r is string => r !== null)
    .sort()
    .join("\n") || "(no repos)";
}

export function gitLog(repoPath: string, n = 10): string {
  try {
    return execSync(
      `git -C "${repoPath}" log --oneline -${n} --format="%ar: %s" 2>/dev/null`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
  } catch { return ""; }
}

export function gitDiffStat(repoPath: string): string {
  try {
    return execSync(
      `git -C "${repoPath}" diff --stat HEAD~3 HEAD 2>/dev/null | tail -1`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
  } catch { return ""; }
}
