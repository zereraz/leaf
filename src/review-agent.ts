/**
 * review-agent.ts — the safety gate for all code changes.
 *
 * The review agent has ONE job and ONE way to finish it: call submit_review().
 * No text parsing. No regex. The verdict comes from the tool call.
 *
 * Flow:
 *   main agent calls restart_bot
 *     → review agent receives request
 *     → runs bash checks (tsc, tests, scope, diff) using its own tools
 *     → MUST call submit_review({ verdict, issues, summary }) when done
 *     → we read the tool call — approved or not, with structured issues
 *     → if approved: restart. if not: report exact issues to main agent.
 *
 * Persistent session (review.jsonl) accumulates history across attempts.
 * The review agent sees every prior attempt and can reference them.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  codingTools,
  DefaultResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./config.js";
import { PI_SESSIONS_DIR } from "./store.js";

const PROJECT_DIR = join(PATHS.home, "Code/Zereraz/pi-tg");
const REVIEW_SESSION_FILE = join(PI_SESSIONS_DIR, "review.jsonl");

// ── submit_review tool — the ONLY way the review agent completes ───────────

const submitReviewParams = Type.Object({
  verdict: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
  issues: Type.Array(Type.String(), {
    description: "Empty array if approved. Each string: 'file:line — what is wrong — how to fix it'.",
  }),
  summary: Type.String({
    description: "1-2 sentences: what was reviewed and the overall verdict.",
  }),
});

type SubmitReviewParams = {
  verdict: "approved" | "rejected";
  issues: string[];
  summary: string;
};

// Captured out-of-band — set by the tool execute, read after session.prompt() returns
let pendingReview: SubmitReviewParams | null = null;

const submitReviewTool: ToolDefinition = {
  name: "submit_review",
  label: "Submit Review",
  description: [
    "Submit your final review verdict. Call this ONCE after running all checks.",
    "You MUST call this tool — do not write a verdict in plain text.",
    "verdict: 'approved' or 'rejected'.",
    "issues: empty array if approved; specific issues with file:line and fix if rejected.",
    "summary: brief overall assessment.",
  ].join(" "),
  parameters: submitReviewParams,
  execute: async (_id, params: SubmitReviewParams) => {
    pendingReview = params;
    const status = params.verdict === "approved" ? "✅ APPROVED" : "❌ REJECTED";
    const body = params.issues.length > 0
      ? params.issues.map(i => `• ${i}`).join("\n")
      : "All checks passed.";
    return {
      content: [{ type: "text" as const, text: `${status}\n\n${body}` }],
      details: params,
    };
  },
};

// ── Review agent session ────────────────────────────────────────────────────

let reviewSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

async function getReviewSession() {
  if (reviewSession) return reviewSession;

  const authStorage = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
  const settingsManager = SettingsManager.create(PROJECT_DIR, PATHS.agentDir);
  const loader = new DefaultResourceLoader({ cwd: PROJECT_DIR, agentDir: PATHS.agentDir, settingsManager });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    agentDir: PATHS.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.open(REVIEW_SESSION_FILE, PI_SESSIONS_DIR),
    resourceLoader: loader,
    tools: codingTools,
    customTools: [submitReviewTool],
  });

  session.agent.setSystemPrompt(
    `You are the review agent for pi-tg — a safety gate before any restart.\n\n` +
    `## Your job\n` +
    `Run ALL four checks using bash tools, then call submit_review() with your structured verdict.\n` +
    `You MUST call submit_review() — never write a verdict in plain text.\n\n` +
    `## The four checks (run ALL of them, in order)\n\n` +
    `1. TypeScript: cd ${PROJECT_DIR} && npx tsc --noEmit 2>&1\n` +
    `   Any errors → reject immediately.\n\n` +
    `2. Tests: cd ${PROJECT_DIR} && npm test 2>&1\n` +
    `   Any failures → reject immediately.\n\n` +
    `3. Scope: cd ${PROJECT_DIR} && git diff --name-only HEAD 2>&1\n` +
    `   Files outside src/ and test/ are suspicious — flag them.\n` +
    `   package.json, tsconfig.json, *.plist, .env, lock files: reject unless justified.\n\n` +
    `4. Diff logic: cd ${PROJECT_DIR} && git diff HEAD -- src/ test/ 2>&1 | head -400\n` +
    `   Look for: require() in ESM, missing imports, broken async, undefined variables.\n` +
    `   Look for: does the change match the stated intent?\n` +
    `   Look for: anything that would crash the bot or silently lose messages.\n\n` +
    `## After all checks: call submit_review()\n` +
    `- verdict: "approved" only if ALL four checks pass cleanly\n` +
    `- issues: one string per problem — format: "file:line — what is wrong — how to fix"\n` +
    `- summary: what was reviewed and why\n\n` +
    `## Memory\n` +
    `This session is persistent. You see every previous attempt. When the same issue\n` +
    `reappears say so explicitly: "This is the same error from attempt N."\n\n` +
    `## Strictness\n` +
    `Be strict. Do not be persuaded by arguments — only by passing checks.\n` +
    `If the main agent argues with your rejection, run the checks again.`
  );

  const sm = session.sessionManager;
  if (sm.getSessionName() !== "Review Agent") sm.appendSessionInfo("Review Agent");

  reviewSession = session;
  return session;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReviewResult {
  readonly approved: boolean;
  readonly issues: string[];
  readonly summary: string;
  readonly report: string;
}

export async function requestReview(note?: string): Promise<ReviewResult> {
  console.log("[review-agent] Review requested...");
  pendingReview = null;

  const session = await getReviewSession();
  const message = `Review request${note ? `: ${note}` : ""}. Run all four checks then call submit_review().`;

  const unsub = session.subscribe(() => {});
  try {
    await session.prompt(message);
  } finally {
    unsub();
  }

  // Verdict from tool call — no text parsing
  if (!pendingReview) {
    return {
      approved: false,
      issues: ["review-agent did not call submit_review() — cannot determine verdict"],
      summary: "Review agent failed to produce a structured verdict.",
      report: "❌ REJECTED\n\n• review-agent did not call submit_review()\n  Fix: check review agent session",
    };
  }

  // Cast needed: TypeScript can't narrow a module-level mutable variable across async
  const review = pendingReview as { verdict: "approved" | "rejected"; issues: string[]; summary: string };
  const approved = review.verdict === "approved";

  console.log(`[review-agent] ${approved ? "APPROVED ✓" : `REJECTED ✗ (${review.issues.length} issue(s))`}`);

  const report = approved
    ? `✅ APPROVED\n\n${review.summary}`
    : `❌ REJECTED\n\n${review.summary}\n\n${review.issues.map((i: string) => `• ${i}`).join("\n")}`;

  return { approved, issues: review.issues, summary: review.summary, report };
}

export function resetReviewSession(): void {
  reviewSession = null;
  pendingReview = null;
  // Truncate session file so integration tests start with clean state
  try { writeFileSync(REVIEW_SESSION_FILE, "", "utf-8"); } catch { /* ok if missing */ }
}
