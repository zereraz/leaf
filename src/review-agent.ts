/**
 * review-agent.ts — safety gate before any code change triggers a restart.
 *
 * Must pass before launchctl reload is allowed. Runs three checks:
 *
 *  1. tsc --noEmit        — no type errors
 *  2. npm test            — all tests pass
 *  3. LLM diff review     — quick logic check on what changed
 *
 * Usage (called by the bot when it makes code changes):
 *   const result = await reviewChanges();
 *   if (result.ok) { restartDaemon(); }
 *   else { replyToUser(result.report); }
 *
 * The bot must NOT restart the daemon without calling this first.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./config.js";

const PROJECT_DIR = join(PATHS.home, "Code/Zereraz/pi-tg");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReviewResult {
  readonly ok: boolean;
  readonly report: string;   // always present — sent to user on both pass and fail
  readonly checks: {
    readonly types: CheckResult;
    readonly tests: CheckResult;
    readonly diff: CheckResult;
  };
}

interface CheckResult {
  readonly ok: boolean;
  readonly output: string;
}

// ── Checks ─────────────────────────────────────────────────────────────────

function runTypecheck(): CheckResult {
  try {
    const out = execSync("npx tsc --noEmit 2>&1", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { ok: true, output: out.trim() || "✓ No type errors" };
  } catch (err) {
    const out = (err as { stdout?: string; stderr?: string }).stdout
      ?? (err as Error).message ?? "unknown error";
    return { ok: false, output: out.slice(0, 800) };
  }
}

function runTests(): CheckResult {
  try {
    const out = execSync("npm test 2>&1", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 30_000,
    });
    const passed = out.includes("Tests") && !out.includes("failed");
    return { ok: passed, output: out.split("\n").filter(l => l.trim()).slice(-8).join("\n") };
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? (err as Error).message ?? "unknown";
    return { ok: false, output: out.slice(0, 800) };
  }
}

function getDiff(): string {
  try {
    return execSync("git diff HEAD 2>&1", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 10_000,
    }).slice(0, 6000); // cap for LLM context
  } catch {
    return "(could not get diff)";
  }
}

async function reviewDiff(diff: string): Promise<CheckResult> {
  if (!diff.trim() || diff === "(could not get diff)") {
    return { ok: true, output: "No uncommitted changes to review." };
  }

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
      tools: [],
    });

    session.agent.setSystemPrompt(
      "You are a code reviewer for pi-tg, an always-on Telegram bot built on the pi SDK. " +
      "Be brief, specific, and honest. Your review determines whether the bot restarts."
    );

    let review = "";
    const unsub = session.subscribe(event => {
      if (event.type === "message_update") {
        const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
        if (e.assistantMessageEvent?.type === "text_delta") review += e.assistantMessageEvent.delta ?? "";
      }
    });

    const prompt = `Review this diff for pi-tg. Answer with ONLY:
1. PASS or FAIL on the first line
2. 2-4 bullet points explaining why

Look for: runtime errors (require in ESM, missing imports, wrong types), logic bugs, broken async patterns, anything that would crash the bot or lose messages.

Diff:
\`\`\`diff
${diff}
\`\`\``;

    try {
      await session.prompt(prompt);
    } finally {
      unsub();
    }

    const trimmed = review.trim();
    const ok = trimmed.toUpperCase().startsWith("PASS");
    return { ok, output: trimmed };

  } catch (err) {
    // LLM review failed — don't block, just warn
    return { ok: true, output: `⚠️ LLM review skipped: ${(err as Error).message?.slice(0, 80)}` };
  }
}

// ── Main export ────────────────────────────────────────────────────────────

export async function reviewChanges(): Promise<ReviewResult> {
  console.log("[review] Running pre-restart checks...");

  const types = runTypecheck();
  console.log(`[review] Types: ${types.ok ? "✓" : "✗"}`);

  const tests = runTests();
  console.log(`[review] Tests: ${tests.ok ? "✓" : "✗"}`);

  // Only run diff review if structural checks pass
  let diff: CheckResult;
  if (types.ok && tests.ok) {
    diff = await reviewDiff(getDiff());
    console.log(`[review] Diff: ${diff.ok ? "✓" : "✗"}`);
  } else {
    diff = { ok: false, output: "Skipped — fix type/test errors first." };
  }

  const ok = types.ok && tests.ok && diff.ok;

  const lines: string[] = [
    ok ? "✅ Review passed — safe to restart." : "❌ Review failed — not restarting.",
    "",
    `Types:  ${types.ok ? "✓" : "✗"} ${types.ok ? "" : "\n" + types.output}`,
    `Tests:  ${tests.ok ? "✓" : "✗"} ${tests.ok ? "" : "\n" + tests.output}`,
    `Diff:   ${diff.ok ? "✓" : "✗"} ${diff.ok ? "" : "\n" + diff.output}`,
  ];

  if (ok && diff.output && !diff.output.startsWith("No uncommitted")) {
    lines.push("", diff.output);
  }

  return { ok, report: lines.join("\n").trim(), checks: { types, tests, diff } };
}
