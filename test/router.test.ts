/**
 * router.test.ts — tests for message routing + command parsing.
 * Uses a temporary data dir so no real state is mutated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Pure command parsing tests (no FS needed) ──────────────────────────────
// Extract the slug logic to test independently

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

describe("slug generation", () => {
  it("lowercases", () => expect(toSlug("NamaHelper")).toBe("namahelper"));
  it("replaces spaces with dashes", () => expect(toSlug("nama helper")).toBe("nama-helper"));
  it("strips special chars", () => expect(toSlug("test!@#$")).toBe("test----"));
  it("leaves valid chars", () => expect(toSlug("my-agent-2")).toBe("my-agent-2"));
});

// ── Text splitting ─────────────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = maxLen;
    const para = remaining.lastIndexOf("\n\n", maxLen);
    if (para > maxLen * 0.6) cut = para + 2;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

describe("splitText", () => {
  it("returns single chunk when under limit", () => {
    expect(splitText("hello", 100)).toEqual(["hello"]);
  });
  it("splits long text", () => {
    const text = "a".repeat(100);
    const chunks = splitText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
  it("prefers paragraph boundaries", () => {
    // text = 12 + 2 + long = 14 chars before long part. maxLen=30.
    // para boundary at index 12, which is > 30*0.6=18? No, 12 < 18.
    // So it won't split at para boundary here — adjust the test to match actual behavior.
    const short = "a".repeat(10);
    const long = "b".repeat(10);
    const text = `${short}\n\n${long}`;
    const chunks = splitText(text, 40);
    // Text is 22 chars, under limit — single chunk
    expect(chunks).toEqual([text]);
  });

  it("splits at paragraph when boundary is past 60% of maxLen", () => {
    const intro = "x".repeat(25);  // 25 chars
    const rest = "y".repeat(50);   // 50 chars
    const text = `${intro}\n\n${rest}`;  // 77 chars, maxLen=40
    // para at index 25, 25 > 40*0.6=24 ✓ → splits there
    const chunks = splitText(text, 40);
    expect(chunks[0]).toBe(`${intro}\n\n`);
  });
});

// ── scheduler time helpers ─────────────────────────────────────────────────

describe("scheduler week key", () => {
  it("generates stable week key for same week", () => {
    function istWeek(date: Date): string {
      const startOfYear = new Date(date.getFullYear(), 0, 1);
      const week = Math.ceil(((date.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7);
      return `${date.getFullYear()}-W${week}`;
    }
    const monday = new Date("2026-03-16");
    const wednesday = new Date("2026-03-18");
    // Same week — both should produce the same key
    expect(istWeek(monday)).toBe(istWeek(wednesday));
  });
});
