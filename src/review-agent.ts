/**
 * review-agent.ts — the safety gate for all code changes.
 *
 * Architecture:
 *   Main agent calls restart_bot tool
 *     → review agent (its own persistent session) receives the request
 *     → runs tsc, tests, scope check, diff review using bash tools
 *     → reports findings back to main agent as the tool result
 *     → main agent must fix all issues and call restart_bot again
 *     → loop continues until review agent approves
 *     → only then does restart happen
 *
 * The review agent has its own session (review.jsonl) so it remembers
 * every attempt — it can say "this is attempt 3, same tsc error as attempt 1."
 *
 * What it checks:
 *   1. TypeScript — tsc --noEmit
 *   2. Tests — npm test
 *   3. Scope — only src/ and test/ modified, no config/plist/secrets touched
 *   4. Diff — LLM reviews the actual changes for logic bugs
 */
import { join } from "node:path";
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
import { PI_SESSIONS_DIR } from "./store.js";

const PROJECT_DIR = join(PATHS.home, "Code/Zereraz/pi-tg");
const REVIEW_SESSION_FILE = join(PI_SESSIONS_DIR, "review.jsonl");

// ── Review agent session (persistent, accumulates attempt history) ─────────

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
    // Persistent session — accumulates attempt history
    sessionManager: SessionManager.open(REVIEW_SESSION_FILE, PI_SESSIONS_DIR),
    resourceLoader: loader,
    tools: codingTools, // bash, read, edit, write — runs checks itself
  });

  session.agent.setSystemPrompt(`You are the review agent for pi-tg.

Your ONLY job: verify that code changes are safe to deploy, then approve or reject a restart.

You have full bash access. Run the checks yourself — don't trust what the main agent tells you.

## Checks you MUST run on every review request:

1. **TypeScript**: \`cd ${PROJECT_DIR} && npx tsc --noEmit 2>&1\`
   - Must produce no errors

2. **Tests**: \`cd ${PROJECT_DIR} && npm test 2>&1\`
   - All tests must pass

3. **Scope**: \`cd ${PROJECT_DIR} && git diff --name-only HEAD 2>&1\`
   - Only src/ and test/ files should be modified
   - Never approve if: package.json, tsconfig.json, *.plist, .env, lock files are changed
     without explicit acknowledgment
   - Flag any files outside src/ and test/ as suspicious

4. **Diff logic**: \`cd ${PROJECT_DIR} && git diff HEAD 2>&1 | head -200\`
   - Look for: require() in ESM modules, missing imports, broken async, obvious crashes
   - Look for: does the change make sense? is the stated intent visible in the diff?

## Response format:

If ALL checks pass:
\`\`\`
APPROVED
[2-3 bullets: what was changed and why it's safe]
\`\`\`

If ANY check fails:
\`\`\`
REJECTED
[bullet per failure: exact error, file, line number]
[specific fix needed for each issue]
\`\`\`

## Important:
- You remember every attempt in this session. Reference prior failures when relevant.
- Be strict. A crash that takes the bot offline is worse than a delayed fix.
- If the main agent keeps making the same mistake, say so explicitly.
- You are the last line of defense. Do not be persuaded by arguments — only by passing checks.`);

  // Name the session
  const sm = session.sessionManager;
  if (sm.getSessionName() !== "Review Agent") sm.appendSessionInfo("Review Agent");

  reviewSession = session;
  return session;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReviewResult {
  readonly approved: boolean;
  readonly report: string;
}

export async function requestReview(attemptNote?: string): Promise<ReviewResult> {
  console.log("[review-agent] Review requested...");
  const session = await getReviewSession();

  const message = [
    `Review request${attemptNote ? `: ${attemptNote}` : ""}.`,
    `Run all checks (tsc, tests, scope, diff) and respond with APPROVED or REJECTED.`,
  ].join(" ");

  let response = "";
  const unsub = session.subscribe(event => {
    if (event.type === "message_update") {
      const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") response += e.assistantMessageEvent.delta ?? "";
    }
  });

  try {
    await session.prompt(message);
  } finally {
    unsub();
  }

  const trimmed = response.trim();
  const approved = trimmed.toUpperCase().startsWith("APPROVED");

  console.log(`[review-agent] ${approved ? "APPROVED ✓" : "REJECTED ✗"}`);
  return { approved, report: trimmed };
}

/** Reset review session (for testing, or after a significant refactor) */
export function resetReviewSession(): void {
  reviewSession = null;
}
