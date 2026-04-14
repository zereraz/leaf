/**
 * tool-scope.ts — per-sender tool scoping and access control.
 *
 * Allows restricting which tools each sender can use based on their identity.
 * Supports wildcards and default policies.
 */

import type { SenderIdentity } from "./sender-identity.js";
import { getAllIdentifiers, normalizeSenderId } from "./sender-identity.js";

export type ToolAccess = "allow" | "deny" | "default";

export interface ToolScopeRule {
  /** Tool name pattern (supports wildcards: *) */
  tool: string;
  /** Access level */
  access: ToolAccess;
  /** Optional reason/description */
  reason?: string;
}

export interface SenderToolScope {
  /** Sender identifier (e164:, username:, name:, id:) */
  sender: string;
  /** List of tool rules (processed in order) */
  tools: ToolScopeRule[];
  /** Default access for tools not explicitly listed */
  defaultAccess: ToolAccess;
}

export interface ToolScopeConfig {
  /** Scopes for specific senders */
  senderScopes: SenderToolScope[];
  /** Global default when no sender scope matches */
  globalDefault: ToolAccess;
  /** List of dangerous tools that require explicit allow */
  dangerousTools: string[];
}

export const DEFAULT_TOOL_SCOPE_CONFIG: ToolScopeConfig = {
  senderScopes: [],
  globalDefault: "allow",
  dangerousTools: [
    "bash",
    "write",
    "edit",
    "spawn_agent",
  ],
};

/**
 * Match a tool name against a pattern (supports * wildcards).
 */
function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Convert glob-style pattern to regex
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*");

  try {
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
  } catch {
    return false;
  }
}

/**
 * Find the scope configuration for a sender.
 */
function findSenderScope(
  identity: SenderIdentity,
  scopes: SenderToolScope[],
): SenderToolScope | undefined {
  const senderIds = getAllIdentifiers(identity);

  for (const scope of scopes) {
    const normalizedScope = normalizeSenderId(scope.sender);

    for (const senderId of senderIds) {
      const normalizedSender = normalizeSenderId(senderId);

      if (
        normalizedScope.type === normalizedSender.type &&
        normalizedScope.value === normalizedSender.value
      ) {
        return scope;
      }
    }
  }

  return undefined;
}

/**
 * Evaluate tool access for a sender.
 */
export function evaluateToolAccess(
  identity: SenderIdentity,
  toolName: string,
  config: ToolScopeConfig,
): { access: ToolAccess; reason?: string | undefined } {
  // Find sender's scope
  const scope = findSenderScope(identity, config.senderScopes);

  if (scope) {
    // Process rules in order
    for (const rule of scope.tools) {
      if (matchesToolPattern(toolName, rule.tool)) {
        return { access: rule.access, reason: rule.reason };
      }
    }

    // No matching rule - use scope default
    return { access: scope.defaultAccess };
  }

  // No scope for this sender - use global default
  return { access: config.globalDefault };
}

/**
 * Check if a tool is allowed for a sender.
 */
export function isToolAllowed(
  identity: SenderIdentity,
  toolName: string,
  config: ToolScopeConfig,
): boolean {
  const { access } = evaluateToolAccess(identity, toolName, config);
  return access === "allow";
}

/**
 * Get the list of allowed tools for a sender.
 * Note: This is best-effort for wildcard patterns.
 */
export function getAllowedTools(
  identity: SenderIdentity,
  allTools: string[],
  config: ToolScopeConfig,
): string[] {
  return allTools.filter((tool) =>
    isToolAllowed(identity, tool, config),
  );
}

/**
 * Create a restricted tool set for a sender.
 * Returns a filter function to check tool access.
 */
export function createToolFilter(
  identity: SenderIdentity,
  config: ToolScopeConfig,
): {
  isAllowed: (toolName: string) => boolean;
  getDenialReason: (toolName: string) => string;
} {
  return {
    isAllowed: (toolName: string) =>
      isToolAllowed(identity, toolName, config),

    getDenialReason: (toolName: string) => {
      const { access, reason } = evaluateToolAccess(
        identity,
        toolName,
        config,
      );

      if (access === "allow") return "";

      return (
        reason ||
        `Tool '${toolName}' is not available to user ${getAllIdentifiers(identity)[0] || identity.id}`
      );
    },
  };
}

/**
 * Build a human-readable description of tool scope for a sender.
 */
export function buildToolScopeDescription(
  identity: SenderIdentity,
  config: ToolScopeConfig,
): string {
  const scope = findSenderScope(identity, config.senderScopes);

  if (!scope) {
    return `Default access (${config.globalDefault})`;
  }

  const allowed = scope.tools
    .filter((r) => r.access === "allow")
    .map((r) => r.tool);

  const denied = scope.tools
    .filter((r) => r.access === "deny")
    .map((r) => r.tool);

  const parts: string[] = [];
  if (allowed.length > 0) parts.push(`Allowed: ${allowed.join(", ")}`);
  if (denied.length > 0) parts.push(`Denied: ${denied.join(", ")}`);
  parts.push(`Default: ${scope.defaultAccess}`);

  return parts.join("; ");
}
