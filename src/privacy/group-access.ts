/**
 * group-access.ts — group access control and privacy policies.
 *
 * Implements OpenClaw-style group policies:
 * - open: anyone can interact
 * - allowlist: only specific senders can interact
 * - disabled: group interactions disabled
 */

import type { SenderIdentity } from "./sender-identity.js";
import { getAllIdentifiers } from "./sender-identity.js";

export type GroupPolicy = "open" | "allowlist" | "disabled";

export type SenderGroupAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "sender_not_allowlisted";

export interface SenderGroupAccessDecision {
  allowed: boolean;
  policy: GroupPolicy;
  reason: SenderGroupAccessReason;
}

export type MentionMode = "always" | "require_in_group" | "never";

export interface GroupAccessConfig {
  /** Group policy mode */
  policy: GroupPolicy;
  /** Allowlist of sender identifiers */
  allowlist: string[];
  /** Whether to allow all if allowlist is empty */
  allowWhenEmpty: boolean;
  /** Mention requirement mode */
  mentionMode: MentionMode;
  /** Bot's username/identifier for mention detection */
  botUsername?: string;
  /** Whether sender must be in the group's participant list (WhatsApp) */
  requireParticipant: boolean;
}

export const DEFAULT_GROUP_CONFIG: GroupAccessConfig = {
  policy: "open",
  allowlist: [],
  allowWhenEmpty: true,
  mentionMode: "require_in_group",
  requireParticipant: false,
};

/**
 * Check if an allowlist entry matches a sender identifier.
 * Supports wildcards (*) at end of string.
 */
function matchesAllowlistEntry(entry: string, senderId: string): boolean {
  const trimmed = entry.trim();

  // Wildcard support
  if (trimmed === "*") return true;
  if (trimmed.endsWith("*")) {
    const prefix = trimmed.slice(0, -1);
    return senderId.startsWith(prefix);
  }

  return trimmed === senderId;
}

/**
 * Check if a sender is in the allowlist.
 */
export function isSenderAllowlisted(
  identity: SenderIdentity,
  allowlist: string[],
): boolean {
  if (allowlist.length === 0) return false;

  const senderIds = getAllIdentifiers(identity);

  for (const entry of allowlist) {
    for (const senderId of senderIds) {
      if (matchesAllowlistEntry(entry, senderId)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluate group access for a sender.
 */
export function evaluateGroupAccess(
  identity: SenderIdentity,
  config: GroupAccessConfig,
): SenderGroupAccessDecision {
  // Disabled policy
  if (config.policy === "disabled") {
    return {
      allowed: false,
      policy: config.policy,
      reason: "disabled",
    };
  }

  // Allowlist policy
  if (config.policy === "allowlist") {
    const hasEntries = config.allowlist.length > 0;

    if (!hasEntries) {
      return {
        allowed: config.allowWhenEmpty,
        policy: config.policy,
        reason: "empty_allowlist",
      };
    }

    if (!isSenderAllowlisted(identity, config.allowlist)) {
      return {
        allowed: false,
        policy: config.policy,
        reason: "sender_not_allowlisted",
      };
    }
  }

  // Open policy or passed allowlist check
  return {
    allowed: true,
    policy: config.policy,
    reason: "allowed",
  };
}

/**
 * Check if a message text contains a mention of the bot.
 */
export function containsMention(text: string, botUsername?: string): boolean {
  if (!botUsername) return false;

  const normalizedText = text.toLowerCase();
  const normalizedBot = botUsername.toLowerCase();

  // Check for @mention
  if (normalizedText.includes(`@${normalizedBot}`)) return true;

  // Check for quoted name mention (WhatsApp style)
  if (normalizedText.includes(`@${normalizedBot}`)) return true;

  return false;
}

/**
 * Determine if the bot should respond based on mention mode.
 */
export function shouldRespondToMention(
  text: string,
  isGroup: boolean,
  config: GroupAccessConfig,
): boolean {
  // Not a group - always respond
  if (!isGroup) return true;

  switch (config.mentionMode) {
    case "always":
      return true;
    case "never":
      return true; // Mention mode doesn't affect response, just the check
    case "require_in_group":
      return containsMention(text, config.botUsername);
    default:
      return true;
  }
}

/**
 * Strip mention from message text.
 */
export function stripMention(text: string, botUsername?: string): string {
  if (!botUsername) return text;

  const normalizedBot = botUsername.toLowerCase();
  const mentionPattern = new RegExp(`@${normalizedBot}\\b`, "gi");

  return text.replace(mentionPattern, "").trim();
}
