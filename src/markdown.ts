/**
 * markdown.ts — convert agent markdown output to Telegram MarkdownV2.
 *
 * Telegram MarkdownV2 rules:
 * - Must escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * - BUT not inside formatting entities (bold, italic, code, etc.)
 * - Code blocks (``` ```) and inline code (` `) contents are NOT escaped
 *
 * Strategy: parse the markdown into segments (code blocks, inline code, plain text)
 * and only escape the plain text segments.
 */

const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Escape a plain text string for MarkdownV2 */
function escapeV2(text: string): string {
  return text.replace(ESCAPE_CHARS, "\\$1");
}

/**
 * Convert standard markdown to Telegram MarkdownV2.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```, [links](url)
 */
export function toMarkdownV2(input: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < input.length) {
    // ── Code block: ```...``` ──
    if (input.startsWith("```", i)) {
      const endIdx = input.indexOf("```", i + 3);
      if (endIdx !== -1) {
        // Preserve code block as-is (telegram handles it)
        result.push(input.slice(i, endIdx + 3));
        i = endIdx + 3;
        continue;
      }
    }

    // ── Inline code: `...` ──
    if (input[i] === "`") {
      const endIdx = input.indexOf("`", i + 1);
      if (endIdx !== -1) {
        result.push(input.slice(i, endIdx + 1));
        i = endIdx + 1;
        continue;
      }
    }

    // ── Bold: **...** → *...* in MarkdownV2 ──
    if (input.startsWith("**", i)) {
      const endIdx = input.indexOf("**", i + 2);
      if (endIdx !== -1) {
        const inner = input.slice(i + 2, endIdx);
        result.push(`*${escapeV2(inner)}*`);
        i = endIdx + 2;
        continue;
      }
    }

    // ── Link: [text](url) ──
    if (input[i] === "[") {
      const closeBracket = input.indexOf("](", i);
      if (closeBracket !== -1) {
        const closeParen = input.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = input.slice(i + 1, closeBracket);
          const url = input.slice(closeBracket + 2, closeParen);
          result.push(`[${escapeV2(linkText)}](${url})`);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // ── Plain text: collect until next special char ──
    let end = i + 1;
    while (end < input.length) {
      if (input[end] === "`" || input[end] === "[") break;
      if (input.startsWith("**", end)) break;
      end++;
    }
    result.push(escapeV2(input.slice(i, end)));
    i = end;
  }

  return result.join("");
}

/**
 * Try to send as MarkdownV2, fall back to plain text if it fails.
 * Returns { text, parseMode } ready for the telegram API.
 */
export function formatForTelegram(input: string): { text: string; parseMode: "MarkdownV2" | undefined } {
  try {
    const converted = toMarkdownV2(input);
    // Quick sanity check — unbalanced backticks will fail
    const backtickCount = (converted.match(/(?<!\\)`/g) ?? []).length;
    const tripleCount = (converted.match(/```/g) ?? []).length;
    const singleCount = backtickCount - (tripleCount * 3);
    if (singleCount % 2 !== 0) {
      // Unbalanced — fall back to plain text
      return { text: input, parseMode: undefined };
    }
    return { text: converted, parseMode: "MarkdownV2" };
  } catch {
    return { text: input, parseMode: undefined };
  }
}
