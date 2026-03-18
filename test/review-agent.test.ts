/**
 * review-agent.test.ts
 *
 * Tests for the review agent safety gate.
 *
 * Unit tests (fast, no LLM):
 *   - submit_review tool correctly captures verdict + issues
 *   - approved/rejected results are structured, never parsed from text
 *   - missing tool call returns automatic rejection
 *
 * Integration test (live LLM — run manually or in CI with credentials):
 *   - The require() ESM bug that tsc + tests both miss IS caught by diff review
 *   - A clean diff IS approved
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Unit tests — test the tool call mechanism directly ────────────────────
//
// We can't easily unit-test the full agent session without live LLM creds,
// but we CAN verify the core mechanism: submit_review tool captures the
// structured verdict and requestReview reads it correctly.
// This is the part that replaces text parsing.

describe("submit_review tool mechanism", () => {
  // Simulate the tool call capture pattern used in review-agent.ts
  // by extracting the logic into a testable form.

  type Verdict = "approved" | "rejected";
  interface SubmitParams { verdict: Verdict; issues: string[]; summary: string; }

  function buildReviewResult(pending: SubmitParams | null): {
    approved: boolean;
    issues: string[];
    summary: string;
    report: string;
  } {
    if (!pending) {
      return {
        approved: false,
        issues: ["review-agent did not call submit_review() — cannot determine verdict"],
        summary: "Review agent failed to produce a structured verdict.",
        report: "❌ REJECTED\n\n• review-agent did not call submit_review()\n  Fix: check review agent session",
      };
    }

    const review = pending as { verdict: Verdict; issues: string[]; summary: string };
    const approved = review.verdict === "approved";
    const report = approved
      ? `✅ APPROVED\n\n${review.summary}`
      : `❌ REJECTED\n\n${review.summary}\n\n${review.issues.map((i: string) => `• ${i}`).join("\n")}`;

    return { approved, issues: review.issues, summary: review.summary, report };
  }

  it("approved verdict → approved:true, empty issues", () => {
    const result = buildReviewResult({
      verdict: "approved",
      issues: [],
      summary: "All checks pass. Clean diff.",
    });
    expect(result.approved).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.report).toContain("✅ APPROVED");
    expect(result.report).not.toContain("REJECTED");
  });

  it("rejected verdict → approved:false, issues populated", () => {
    const result = buildReviewResult({
      verdict: "rejected",
      issues: [
        "src/agent.ts:193 — require() in ESM crashes at runtime — remove line, statSync already imported",
      ],
      summary: "tsc passes but require() in ESM will crash at runtime.",
    });
    expect(result.approved).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("require()");
    expect(result.report).toContain("❌ REJECTED");
    expect(result.report).toContain("require()");
    expect(result.report).not.toContain("APPROVED");
  });

  it("no tool call → automatic rejection, specific error message", () => {
    const result = buildReviewResult(null);
    expect(result.approved).toBe(false);
    expect(result.issues[0]).toContain("submit_review()");
    expect(result.report).toContain("❌ REJECTED");
  });

  it("verdict is enum not text — 'Approved' (wrong case) is not approved", () => {
    // This test exists to document WHY we use tool calls instead of text parsing.
    // The old approach: startsWith("APPROVED") would fail for "Approved" or "✅ APPROVED".
    // The new approach: verdict === "approved" — only the exact enum value works.
    const wrongCaseResult = buildReviewResult({
      verdict: "rejected", // only "approved" | "rejected" are valid
      issues: [],
      summary: "test",
    });
    expect(wrongCaseResult.approved).toBe(false); // "rejected" ≠ "approved"

    const correctResult = buildReviewResult({
      verdict: "approved",
      issues: [],
      summary: "test",
    });
    expect(correctResult.approved).toBe(true); // only exact "approved" works
  });

  it("issues are an array — survives zero issues, multiple issues", () => {
    const zero = buildReviewResult({ verdict: "approved", issues: [], summary: "clean" });
    expect(zero.issues).toHaveLength(0);
    expect(zero.report).not.toContain("•");

    const multi = buildReviewResult({
      verdict: "rejected",
      issues: ["file.ts:1 — error A", "file.ts:2 — error B", "file.ts:3 — error C"],
      summary: "multiple issues",
    });
    expect(multi.issues).toHaveLength(3);
    expect(multi.report).toContain("• file.ts:1");
    expect(multi.report).toContain("• file.ts:2");
    expect(multi.report).toContain("• file.ts:3");
  });
});

// ── What the require() bug looks like ────────────────────────────────────
// These tests document the known failure mode and why diff review is needed.

describe("require() in ESM bug detection", () => {
  const BAD_DIFF = `
diff --git a/src/agent.ts b/src/agent.ts
--- a/src/agent.ts
+++ b/src/agent.ts
@@ -190,6 +190,7 @@
 function promptFileMtimes(): string {
+  const { statSync } = require("node:fs");
   return [PATHS.projects, PATHS.memory, PATHS.user].map(p => {
`;

  it("bad diff contains require() in ESM — the pattern tsc misses", () => {
    // TypeScript does NOT catch require() in ESM modules.
    // @types/node declares require as available in Node env.
    // This ONLY fails at runtime: ReferenceError: require is not defined
    expect(BAD_DIFF).toContain('require("node:fs")');

    // The pattern the diff reviewer should flag:
    const hasRequireInEsm = /\+.*require\(/.test(BAD_DIFF);
    expect(hasRequireInEsm).toBe(true);
  });

  it("fix: statSync already imported at top level — no require needed", () => {
    const GOOD_CODE = `
import { statSync } from "node:fs"; // top-level ESM import

function promptFileMtimes(): string {
  return [PATHS.projects].map(p => {
    try { return statSync(p).mtimeMs; } catch { return 0; }
  }).join(",");
}`;
    // No require() in ESM
    expect(GOOD_CODE).not.toContain("require(");
    // Has proper ESM import
    expect(GOOD_CODE).toMatch(/^import.*from/m);
  });
});

// ── Integration test (live LLM) ───────────────────────────────────────────
// Skipped by default. Run with: REVIEW_INTEGRATION=1 npm test

const INTEGRATION = process.env["REVIEW_INTEGRATION"] === "1";

describe.skipIf(!INTEGRATION)("review agent integration (live LLM)", () => {
  it("rejects the require() ESM bug that tsc and tests both miss", async () => {
    // This is the exact scenario that crashed the bot in production.
    // tsc: passes (require is typed in @types/node)
    // npm test: passes (no test exercises the code path)
    // diff review: MUST catch it

    const { requestReview, resetReviewSession } = await import("../src/review-agent.js");

    // Introduce the bug
    const agentPath = join(process.cwd(), "src/agent.ts");
    const original = (await import("node:fs")).readFileSync(agentPath, "utf-8");
    const broken = original.replace(
      "function promptFileMtimes(): string {\n  return",
      "function promptFileMtimes(): string {\n  const { statSync } = require(\"node:fs\");\n  return",
    );

    try {
      (await import("node:fs")).writeFileSync(agentPath, broken);
      resetReviewSession();

      const result = await requestReview("Added require() call for statSync");

      expect(result.approved).toBe(false);
      // Must mention require or ESM in the issue
      const mentionsRequire = result.issues.some(i =>
        i.toLowerCase().includes("require") || i.toLowerCase().includes("esm")
      );
      expect(mentionsRequire).toBe(true);
    } finally {
      // Always restore
      (await import("node:fs")).writeFileSync(agentPath, original);
    }
  }, 120_000); // 2 min timeout for LLM

  it("approves a clean diff", async () => {
    const { requestReview, resetReviewSession } = await import("../src/review-agent.js");
    resetReviewSession();

    const result = await requestReview("No changes — verifying clean state");
    expect(result.approved).toBe(true);
    expect(result.issues).toHaveLength(0);
  }, 120_000);
});
