/**
 * context-agent.ts — dedicated context synthesis agent.
 *
 * Runs an ephemeral pi session whose only job is to understand what saheb
 * is currently focused on — from real artifacts, not memory files.
 *
 * Reads:
 *  - Recent git commits (actual messages — they tell the story)
 *  - Most recent pi session (last conversation topics)
 *  - Most recent nama session (recent research)
 *  - Recent file modifications in active repos
 *
 * Outputs a "focus brief" written to ~/leaf/data/context-brief.md
 * Cached for CACHE_TTL_MS so it doesn't run on every scheduler tick.
 *
 * Used by: scheduler.ts (before crafting proactive messages)
 *          agent.ts buildSystemPrompt() (always-fresh context for main agent)
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  codingTools,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./config.js";

// ── Config ─────────────────────────────────────────────────────────────────

const BRIEF_FILE = join(PATHS.data, "context-brief.md");
const CACHE_TTL_MS = 25 * 60 * 1000; // 25 min — refresh before each 90min scheduler tick

// ── Cache ──────────────────────────────────────────────────────────────────

function isFresh(): boolean {
  if (!existsSync(BRIEF_FILE)) return false;
  try {
    const age = Date.now() - statSync(BRIEF_FILE).mtimeMs;
    return age < CACHE_TTL_MS;
  } catch { return false; }
}

export function readContextBrief(): string {
  if (!existsSync(BRIEF_FILE)) return "(no context brief yet)";
  try { return readFileSync(BRIEF_FILE, "utf-8"); }
  catch { return "(could not read context brief)"; }
}

// ── Signal gathering (fast bash, no LLM) ──────────────────────────────────

function recentCommits(): string {
  // Discover code dirs dynamically from ~/Code
  const codeBase = join(PATHS.home, "Code");
  if (!existsSync(codeBase)) return "(no ~/Code directory)";

  const lines: string[] = [];
  try {
    const gitDirs = execSync(
      `fd -t d -d 4 --hidden "^\\.git$" "${codeBase}"`,
      { encoding: "utf-8", timeout: 8000 }
    ).trim().split("\n").filter(Boolean);

    for (const gd of gitDirs) {
      const repo = gd.replace(/\/\.git$/, "");
      try {
        const log = execSync(
          `git -C "${repo}" log --oneline --since="48 hours ago" --format="%ar | %s" 2>/dev/null`,
          { encoding: "utf-8", timeout: 4000 }
        ).trim();
        if (!log) continue;
        const name = repo.split("/").pop() ?? repo;
        lines.push(`${name}:\n${log.split("\n").slice(0, 6).map(l => `  ${l}`).join("\n")}`);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return lines.join("\n\n") || "(no recent commits)";
}

function recentSessionTopics(): string {
  const results: string[] = [];

  // Most recent pi session — find dynamically
  const piSessionBase = join(PATHS.agentDir, "sessions");
  if (existsSync(piSessionBase)) {
    try {
      const sessionDirs = execSync(`ls -t "${piSessionBase}"`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean).slice(0, 3);
      for (const sd of sessionDirs) {
        const piSessionDir = join(piSessionBase, sd);
        try {
          const files = execSync(`ls -t "${piSessionDir}"`, { encoding: "utf-8" })
            .trim().split("\n").filter(f => f.endsWith(".jsonl")).slice(0, 1);
          for (const f of files) {
            const path = join(piSessionDir, f);
            const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
            const userMsgs: string[] = [];
            for (const line of lines.slice(-60)) {
              try {
                const e = JSON.parse(line);
                if (e?.type === "message" && e?.message?.role === "user") {
                  const content = e.message.content;
                  const text = typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content.find((c: { type: string }) => c.type === "text")?.text ?? ""
                      : "";
                  if (text && !text.startsWith("[SCHEDULER]")) {
                    userMsgs.push(text.slice(0, 80));
                  }
                }
              } catch { /* skip */ }
            }
            if (userMsgs.length > 0) {
              results.push(`Recent pi session topics:\n${userMsgs.slice(-5).map(m => `  - ${m}`).join("\n")}`);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Most recent nama session
  const namaSessions = join(PATHS.home, ".nama/agent/sessions");
  if (existsSync(namaSessions)) {
    try {
      const files = execSync(`ls -t "${namaSessions}"`, { encoding: "utf-8" })
        .trim().split("\n").filter(f => f.endsWith(".jsonl")).slice(0, 1);
      for (const f of files) {
        const path = join(namaSessions, f);
        const mtime = statSync(path).mtimeMs;
        const ageHours = (Date.now() - mtime) / 3600000;
        if (ageHours > 48) continue; // skip if older than 48h
        const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
        const userMsgs: string[] = [];
        for (const line of lines.slice(0, 10)) {
          try {
            const e = JSON.parse(line);
            if (e?.type === "message" && e?.message?.role === "user") {
              const content = e.message.content;
              const text = typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content.find((c: { type: string }) => c.type === "text")?.text ?? ""
                  : "";
              if (text) userMsgs.push(text.slice(0, 120));
            }
          } catch { /* skip */ }
        }
        if (userMsgs.length > 0) {
          const age = ageHours < 1 ? "< 1h ago" : `${Math.round(ageHours)}h ago`;
          results.push(`Recent nama session (${age}):\n${userMsgs.slice(0, 3).map(m => `  - ${m}`).join("\n")}`);
        }
      }
    } catch { /* skip */ }
  }

  return results.join("\n\n") || "(no recent sessions)";
}

// ── Context agent (ephemeral pi session) ───────────────────────────────────

const TASK_PROMPT = `You are a context synthesis agent. Your ONLY job: understand what saheb is currently focused on and why, from real artifacts.

## Signals

### Recent git commits (last 48h)
{COMMITS}

### Recent conversations
{SESSIONS}

## Your task

Synthesize what saheb is in the middle of right now. Think about:
- What problem is he solving? What decision might be live in his head?
- What did he just finish? What's the obvious next step?
- Is there anything that looks stuck, abandoned, or needs a decision?
- What would be genuinely interesting or useful to surface to him?

Be SPECIFIC. Not "working on nama-agent" but "removing SmartTurn — probably deciding between audio-based and semantic turn detection approaches."

Write a focus brief of 5-8 bullet points. Each bullet should be a synthesized insight, not a raw fact.
Start with: ## Current Focus

Be concise. No fluff. This is internal context for an AI companion, not a report for a human.`;

export async function gatherContext(force = false): Promise<string> {
  if (!force && isFresh()) {
    console.log("[context-agent] Using cached brief");
    return readContextBrief();
  }

  console.log("[context-agent] Gathering context...");
  const startedAt = Date.now();

  // Gather raw signals (fast, no LLM)
  const commits = recentCommits();
  const sessions = recentSessionTopics();

  const prompt = TASK_PROMPT
    .replace("{COMMITS}", commits)
    .replace("{SESSIONS}", sessions);

  // If no signals, skip LLM call
  if (commits === "(no recent commits)" && sessions === "(no recent sessions)") {
    const brief = "## Current Focus\n- No recent activity detected.";
    writeFileSync(BRIEF_FILE, brief);
    return brief;
  }

  // Run ephemeral pi session — no history, just this task
  try {
    const authStorage = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
    const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
    const settingsManager = SettingsManager.create(PATHS.data, PATHS.agentDir);
    const loader = new DefaultResourceLoader({ cwd: PATHS.data, agentDir: PATHS.agentDir, settingsManager });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: PATHS.data,
      agentDir: PATHS.agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: loader,
      tools: [], // no tools — just reasoning over provided signals
    });

    session.agent.setSystemPrompt(
      "You are a context synthesis agent. Be concise, specific, and insightful. No fluff."
    );

    let brief = "";
    const unsub = session.subscribe(event => {
      if (event.type === "message_update") {
        const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
        if (e.assistantMessageEvent?.type === "text_delta") {
          brief += e.assistantMessageEvent.delta ?? "";
        }
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsub();
    }

    const result = brief.trim() || "## Current Focus\n- (no synthesis)";
    writeFileSync(BRIEF_FILE, result);
    console.log(`[context-agent] Done in ${Date.now() - startedAt}ms`);
    return result;

  } catch (err) {
    console.error("[context-agent] Failed:", err);
    // Return whatever signals we have as a raw brief
    const fallback = `## Current Focus\n\n### Recent commits\n${commits}\n\n### Recent sessions\n${sessions}`;
    writeFileSync(BRIEF_FILE, fallback);
    return fallback;
  }
}
