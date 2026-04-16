/**
 * mcp-wrapper.ts — MCP tool wrappers with privacy controls.
 *
 * Wraps external MCP tools (Garmin, Spotify, etc.) with privacy controls
 * to prevent cross-user data access without consent.
 */

import type { SenderIdentity } from "./sender-identity.js";
import { getPrimaryIdentifier } from "./sender-identity.js";
import { isDataAccessConsented, requestDataAccessConsent, getConsentManager } from "./consent.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: unknown) => Promise<McpToolResult>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpWrapperOptions {
  /** Function to get current user identity */
  getCurrentUser: () => SenderIdentity | undefined;
  /** Function to notify owner of consent request */
  notifyConsentRequest?: (ownerId: string, request: unknown) => Promise<void>;
  /** Auto-request consent on cross-user access (vs block and ask user to request) */
  autoRequestConsent?: boolean;
}

// ── Wrapper ────────────────────────────────────────────────────────────────

/**
 * Wrap an MCP tool with privacy controls.
 *
 * The MCP tool should include `_dataOwnerId` and `_dataDescription` parameters
 * to identify whose data is being accessed.
 */
export function wrapMcpTool(
  tool: McpTool,
  options: McpWrapperOptions,
): McpTool {
  const { getCurrentUser, notifyConsentRequest, autoRequestConsent = false } = options;

  return {
    ...tool,
    execute: async (args: unknown): Promise<McpToolResult> => {
      const user = getCurrentUser();
      if (!user) {
        return {
          content: [{ type: "text", text: "Error: Unable to identify user for privacy check" }],
          isError: true,
        };
      }

      const userId = getPrimaryIdentifier(user);
      const argsRecord = (args as Record<string, unknown>) || {};

      // Extract data ownership info from args
      const dataOwnerId = String(argsRecord["_dataOwnerId"] ?? argsRecord["ownerId"] ?? "");
      const dataDescription = String(argsRecord["_dataDescription"] ?? tool.name);

      // If accessing own data (or no owner specified), allow directly
      if (!dataOwnerId || dataOwnerId === userId) {
        // Clean up internal parameters before passing to tool
        const cleanArgs = { ...argsRecord };
        delete cleanArgs["_dataOwnerId"];
        delete cleanArgs["_dataDescription"];
        return tool.execute(cleanArgs);
      }

      // Cross-user data access - check consent
      if (isDataAccessConsented(userId, dataOwnerId, dataDescription)) {
        const cleanArgs = { ...argsRecord };
        delete cleanArgs["_dataOwnerId"];
        delete cleanArgs["_dataDescription"];
        return tool.execute(cleanArgs);
      }

      // No consent - either auto-request or block
      if (autoRequestConsent && notifyConsentRequest) {
        // Create consent request
        const manager = getConsentManager();

        // Build owner identity from dataOwnerId
        const ownerIdentity: SenderIdentity = {
          id: dataOwnerId,
          e164: dataOwnerId.startsWith("+") ? dataOwnerId : undefined,
          isGroup: false,
        };

        try {
          const request = await manager.requestConsent(user, ownerIdentity, dataDescription);

          // Notify owner
          await notifyConsentRequest(dataOwnerId, request).catch(() => {});

          return {
            content: [{
              type: "text",
              text: `Requested consent from ${dataOwnerId} to access their ${dataDescription}. ` +
                    `Request ID: ${request.id}. The owner must approve before access is granted.`,
            }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to request consent: ${msg}` }],
            isError: true,
          };
        }
      }

      // Block access
      return {
        content: [{
          type: "text",
          text: `Cannot access ${dataOwnerId}'s ${dataDescription} without consent. ` +
                `Ask the owner to reply "approve <request-id>" after requesting access.`,
        }],
        isError: true,
      };
    },
  };
}

/**
 * Register multiple MCP tools with privacy wrappers.
 */
export function wrapMcpTools(
  tools: McpTool[],
  options: McpWrapperOptions,
): McpTool[] {
  return tools.map(tool => wrapMcpTool(tool, options));
}

/**
 * Helper to extract data owner from MCP tool arguments.
 * This can be used when building tool definitions.
 */
export function extractDataOwner(args: unknown): { ownerId?: string; description: string } | null {
  const argsRecord = (args as Record<string, unknown>) || {};

  const ownerId = String(argsRecord["_dataOwnerId"] ?? argsRecord["ownerId"] ?? "");
  const description = String(argsRecord["_dataDescription"] ?? "data");

  if (!ownerId) return null;

  return { ownerId, description };
}

/**
 * Build MCP tool parameter schema with privacy fields.
 * Adds _dataOwnerId and _dataDescription to the base schema.
 */
export function withPrivacySchema<T extends Record<string, unknown>>(baseSchema: T): T & {
  _dataOwnerId: { type: "string"; description: string };
  _dataDescription: { type: "string"; description: string };
} {
  return {
    ...baseSchema,
    _dataOwnerId: {
      type: "string" as const,
      description: "Optional: User ID of the data owner (for cross-user access with consent)",
    },
    _dataDescription: {
      type: "string" as const,
      description: "Description of data being accessed (for consent requests)",
    },
  };
}
