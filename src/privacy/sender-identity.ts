/**
 * sender-identity.ts — sender identification and normalization.
 *
 * Supports multiple identifier formats:
 * - E.164 phone numbers (WhatsApp): "919876543210"
 * - Username handles: "@username" or "username"
 * - Display names: "name:John Doe"
 * - Platform IDs: "id:123456789"
 */

export type SenderIdType = "e164" | "username" | "name" | "id";

export interface SenderIdentity {
  /** E.164 phone number (WhatsApp only) */
  e164?: string | undefined;
  /** Platform-specific username/handle */
  username?: string | undefined;
  /** Display name */
  name?: string | undefined;
  /** Platform-specific numeric ID */
  id: string;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Group JID/ID (if isGroup is true) */
  groupId?: string | undefined;
}

export interface NormalizedSenderId {
  type: SenderIdType;
  value: string;
  original: string;
}

/**
 * Normalize a sender identifier string to its typed form.
 * Supports prefixes: e164:, username:, name:, id:
 * Falls back to auto-detection if no prefix.
 */
export function normalizeSenderId(input: string): NormalizedSenderId {
  const trimmed = input.trim();

  // Check for explicit prefix
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const prefix = trimmed.slice(0, colonIndex).toLowerCase();
    const value = trimmed.slice(colonIndex + 1);

    if (["e164", "username", "name", "id"].includes(prefix)) {
      return {
        type: prefix as SenderIdType,
        value: value.trim(),
        original: trimmed,
      };
    }
  }

  // Auto-detect type
  // E.164: starts with country code, all digits, 10-15 digits
  if (/^\d{10,15}$/.test(trimmed)) {
    return { type: "e164", value: trimmed, original: trimmed };
  }

  // Username: starts with @ or alphanumeric with underscores
  if (/^@?[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) {
    const value = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    return { type: "username", value, original: trimmed };
  }

  // Default to ID
  return { type: "id", value: trimmed, original: trimmed };
}

/**
 * Build a SenderIdentity from message components.
 */
export function buildSenderIdentity(params: {
  id: string;
  e164?: string;
  username?: string;
  name?: string;
  isGroup: boolean;
  groupId?: string;
}): SenderIdentity {
  const identity: SenderIdentity = {
    id: params.id,
    isGroup: params.isGroup,
  };
  if (params.e164 !== undefined) identity.e164 = params.e164;
  if (params.username !== undefined) identity.username = params.username;
  if (params.name !== undefined) identity.name = params.name;
  if (params.groupId !== undefined) identity.groupId = params.groupId;
  return identity;
}

/**
 * Get the primary identifier for a sender (best available).
 * Priority: e164 > username > name > id
 */
export function getPrimaryIdentifier(identity: SenderIdentity): string {
  return identity.e164 ?? identity.username ?? identity.name ?? identity.id;
}

/**
 * Get all possible identifier strings for a sender.
 * Useful for allowlist matching.
 */
export function getAllIdentifiers(identity: SenderIdentity): string[] {
  const ids: string[] = [];

  if (identity.e164) {
    ids.push(identity.e164);
    ids.push(`e164:${identity.e164}`);
  }
  if (identity.username) {
    ids.push(identity.username);
    ids.push(`username:${identity.username}`);
  }
  if (identity.name) {
    ids.push(identity.name);
    ids.push(`name:${identity.name}`);
  }
  ids.push(identity.id);
  ids.push(`id:${identity.id}`);

  return [...new Set(ids)]; // dedupe
}

/**
 * Format sender identity for display/logging.
 */
export function formatSenderIdentity(identity: SenderIdentity): string {
  const parts: string[] = [];

  if (identity.name) parts.push(identity.name);
  if (identity.e164) parts.push(`(+${identity.e164})`);
  if (identity.username && !identity.name) parts.push(`@${identity.username}`);

  const display = parts.join(" ") || identity.id;

  if (identity.isGroup && identity.groupId) {
    return `${display} (group: ${identity.groupId})`;
  }

  return display;
}
