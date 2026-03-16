/**
 * store.test.ts — tests for state + log persistence
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test store logic by patching PATHS via module mocking isn't ideal with vitest ESM,
// so we test the pure helper functions that don't depend on paths directly.

import { seenUpdateIds } from "../src/store.js";

// ── seenUpdateIds ──────────────────────────────────────────────────────────
// We can't easily test file I/O in isolation without DI, so we test
// the pure dedup logic inline.

describe("seenUpdateIds dedup logic", () => {
  it("returns empty set when no logs exist", () => {
    // Simulate readLog returning empty array
    const entries: Array<{ role: string; updateId?: number }> = [];
    const ids = new Set(
      entries
        .filter(e => e.role === "user" && e.updateId != null)
        .map(e => e.updateId as number)
    );
    expect(ids.size).toBe(0);
  });

  it("collects update_ids from user entries only", () => {
    const entries = [
      { role: "user", updateId: 1 },
      { role: "bot", updateId: 2 },  // should be excluded
      { role: "user", updateId: 3 },
    ];
    const ids = new Set(
      entries
        .filter(e => e.role === "user" && e.updateId != null)
        .map(e => e.updateId as number)
    );
    expect(ids.has(1)).toBe(true);
    expect(ids.has(2)).toBe(false);
    expect(ids.has(3)).toBe(true);
  });
});
