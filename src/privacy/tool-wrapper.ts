/**
 * tool-wrapper.ts — privacy-aware tool wrapper for cross-user data access prevention.
 *
 * Wraps tool executions to enforce:
 * - User-scoped file paths (data isolation)
 * - Cross-user data access denial
 * - Audit logging of sensitive operations
 */

import type { SenderIdentity } from "./sender-identity.js";
import { getPrimaryIdentifier } from "./sender-identity.js";
import { isDataAccessConsented } from "./consent.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolExecutionContext {
  identity: SenderIdentity;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface PrivacyGuardResult {
  allowed: boolean;
  reason?: string;
  sanitizedArgs?: Record<string, unknown>;
}

export type ToolGuard = (ctx: ToolExecutionContext) => PrivacyGuardResult;

// ── Path Sanitization ──────────────────────────────────────────────────────

/**
 * Get user-scoped path prefix.
 */
function getUserPathPrefix(userId: string): string {
  // Sanitize for filesystem
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `users/${sanitized}`;
}

/**
 * Check if a path contains user data markers.
 */
function containsUserDataMarker(path: string): boolean {
  const markers = [
    "/users/",
    "/user_data/",
    "/personal/",
    "/private/",
    "/data/users/",
  ];
  return markers.some(marker => path.toLowerCase().includes(marker));
}

/**
 * Extract user ID from a path if it contains user data.
 */
function extractUserFromPath(path: string): string | null {
  const match = path.match(/\/users\/([^/]+)/);
  return match?.[1] ?? null;
}

// ── Guards ─────────────────────────────────────────────────────────────────

/**
 * Guard for read/edit/write operations - prevents cross-user file access.
 */
export function fileAccessGuard(ctx: ToolExecutionContext): PrivacyGuardResult {
  const { identity, args } = ctx;
  const userId = getPrimaryIdentifier(identity);
  const path = String(args["path"] ?? args["file"] ?? "");

  if (!path) return { allowed: true };

  // If path contains user data markers, verify ownership
  if (containsUserDataMarker(path)) {
    const pathUserId = extractUserFromPath(path);

    if (pathUserId && pathUserId !== userId) {
      return {
        allowed: false,
        reason: `Access denied: Cannot access data belonging to user ${pathUserId}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Guard for bash operations - prevents reading other users' data.
 */
export function bashGuard(ctx: ToolExecutionContext): PrivacyGuardResult {
  const { identity, args } = ctx;
  const userId = getPrimaryIdentifier(identity);
  const command = String(args["command"] ?? "");

  if (!command) return { allowed: true };

  // Block commands that try to access other users' data directories
  const blockedPatterns = [
    /cat\s+.*\/users\/([^/\s]+)/,
    /less\s+.*\/users\/([^/\s]+)/,
    /more\s+.*\/users\/([^/\s]+)/,
    /head\s+.*\/users\/([^/\s]+)/,
    /tail\s+.*\/users\/([^/\s]+)/,
    /grep\s+.*\/users\/([^/\s]+)/,
    /find\s+.*\/users\/([^/\s]+)/,
    /ls\s+.*\/users\/([^/\s]+)/,
  ];

  for (const pattern of blockedPatterns) {
    const match = command.match(pattern);
    if (match) {
      const targetUser = match[1];
      if (targetUser !== userId) {
        return {
          allowed: false,
          reason: `Command blocked: Cannot access data belonging to user ${targetUser}`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Guard for MCP tools - prevents cross-user data access with consent flow.
 * This is used for external MCP tools like Garmin, Spotify, etc.
 */
export function mcpToolGuard(ctx: ToolExecutionContext): PrivacyGuardResult {
  const { identity, toolName, args } = ctx;
  const userId = getPrimaryIdentifier(identity);

  // Check if this is accessing user-scoped data
  const dataOwnerId = String(args["_dataOwnerId"] ?? args["ownerId"] ?? "");
  const dataDescription = String(args["_dataDescription"] ?? toolName);

  if (!dataOwnerId || dataOwnerId === userId) {
    // Accessing own data - allow
    return { allowed: true };
  }

  // Cross-user data access - check consent
  if (isDataAccessConsented(userId, dataOwnerId, dataDescription)) {
    return { allowed: true };
  }

  // No consent - block and suggest consent flow
  return {
    allowed: false,
    reason: `Cannot access ${dataOwnerId}'s ${dataDescription} without consent. The owner must approve this access first.`,
  };
}

/**
 * Guard for spawn_agent - prevents cross-user delegation.
 */
export function spawnAgentGuard(ctx: ToolExecutionContext): PrivacyGuardResult {
  const { args } = ctx;
  const task = String(args["task"] ?? "");

  // Block tasks that explicitly ask for other users' data
  const suspiciousPatterns = [
    /(?:show|get|read|fetch|access)\s+(?:data|files|info).*user/i,
    /(?:other|another)\s+user/i,
    /(?:someone else's|their)\s+(?:data|files|info)/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(task)) {
      return {
        allowed: true, // Allow but flag for audit
        reason: "Cross-user data request detected - will be audited",
      };
    }
  }

  return { allowed: true };
}

// ── Registry ───────────────────────────────────────────────────────────────

const GUARD_REGISTRY: Map<string, ToolGuard> = new Map([
  ["read", fileAccessGuard],
  ["edit", fileAccessGuard],
  ["write", fileAccessGuard],
  ["bash", bashGuard],
  ["spawn_agent", spawnAgentGuard],
]);

/**
 * Register a guard for a tool.
 */
export function registerToolGuard(toolName: string, guard: ToolGuard): void {
  GUARD_REGISTRY.set(toolName, guard);
}

/**
 * Get guard for a tool.
 */
export function getToolGuard(toolName: string): ToolGuard | undefined {
  return GUARD_REGISTRY.get(toolName);
}

// ── Wrapper ────────────────────────────────────────────────────────────────

/**
 * Wrap a tool function with privacy guards.
 */
export function wrapToolWithPrivacy<T extends (...args: any[]) => any>(
  toolName: string,
  toolFn: T,
  getCurrentIdentity: () => SenderIdentity | undefined,
): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const identity = getCurrentIdentity();
    if (!identity) {
      // No identity - allow (backward compatibility)
      return toolFn(...args);
    }

    const guard = getToolGuard(toolName);
    if (!guard) {
      // No guard registered - allow
      return toolFn(...args);
    }

    const ctx: ToolExecutionContext = {
      identity,
      toolName,
      args: args[0] ?? {},
      timestamp: Date.now(),
    };

    const result = guard(ctx);

    if (!result.allowed) {
      // Return error instead of executing
      const error = new Error(result.reason || `Tool '${toolName}' blocked by privacy policy`);
      throw error;
    }

    // Execute with sanitized args if provided
    if (result.sanitizedArgs) {
      return toolFn(result.sanitizedArgs as Parameters<T>[0]);
    }

    return toolFn(...args);
  }) as T;
}

// ── Audit Logging ───────────────────────────────────────────────────────────

interface AuditEntry {
  timestamp: number;
  userId: string;
  toolName: string;
  allowed: boolean;
  reason?: string | undefined;
  argsSummary: string;
}

const auditLog: AuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 1000;

/**
 * Log a tool execution attempt for auditing.
 */
export function auditToolExecution(
  identity: SenderIdentity,
  toolName: string,
  allowed: boolean,
  reason?: string,
  args?: Record<string, unknown>,
): void {
  const entry: AuditEntry = {
    timestamp: Date.now(),
    userId: getPrimaryIdentifier(identity),
    toolName,
    allowed,
    reason,
    argsSummary: summarizeArgs(args),
  };

  auditLog.push(entry);

  // Trim old entries
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.shift();
  }

  // Log to console for visibility
  const status = allowed ? "✓" : "⛔";
  console.log(`[privacy:audit] ${status} ${toolName} for ${entry.userId}${reason ? `: ${reason}` : ""}`);
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return "(none)";

  const keys = Object.keys(args);
  if (keys.length === 0) return "(none)";

  // For paths, show just the filename
  if (args["path"] || args["file"]) {
    const path = String(args["path"] ?? args["file"]);
    const basename = path.split("/").pop() ?? path;
    return `path=${basename}`;
  }

  // For commands, show first 30 chars
  if (args["command"]) {
    const cmd = String(args["command"]).slice(0, 30);
    return `command=${cmd}${String(args["command"]).length > 30 ? "..." : ""}`;
  }

  return keys.slice(0, 3).join(", ");
}

/**
 * Get audit log entries (optionally filtered by user).
 */
export function getAuditLog(userId?: string): AuditEntry[] {
  if (userId) {
    return auditLog.filter(e => e.userId === userId);
  }
  return [...auditLog];
}

/**
 * Clear audit log.
 */
export function clearAuditLog(): void {
  auditLog.length = 0;
}
