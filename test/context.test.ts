/**
 * context.test.ts — tests for log→context sync logic
 */
import { describe, it, expect } from "vitest";

// Pure function extracted for testing
function normalizeText(text: string): string {
  return text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as { type?: string }).type === "text") {
      return (part as { type: string; text?: string }).text ?? "";
    }
  }
  return "";
}

describe("normalizeText", () => {
  it("strips timestamp prefix", () => {
    expect(normalizeText("[2026-03-15 10:00:00+05:30] hello")).toBe("hello");
  });
  it("leaves text without prefix untouched", () => {
    expect(normalizeText("hello world")).toBe("hello world");
  });
  it("trims whitespace", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });
});

describe("extractText", () => {
  it("returns string content directly", () => {
    expect(extractText("hello")).toBe("hello");
  });
  it("extracts text from content array", () => {
    expect(extractText([{ type: "text", text: "world" }])).toBe("world");
  });
  it("returns empty string for unknown format", () => {
    expect(extractText({ foo: "bar" })).toBe("");
  });
  it("returns empty string for null", () => {
    expect(extractText(null)).toBe("");
  });
});

describe("dedup logic", () => {
  it("treats same message as duplicate when normalized", () => {
    const known = new Set<string>();
    const msg = "[saheb]: check on nama";
    const normalized = normalizeText(msg);
    known.add(normalized);
    expect(known.has(normalizeText("[saheb]: check on nama"))).toBe(true);
    expect(known.has(normalizeText("[saheb]: different message"))).toBe(false);
  });
});
