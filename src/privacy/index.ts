/**
 * privacy/index.ts — privacy and access control exports.
 */

// Sender Identity
export {
  type SenderIdType,
  type SenderIdentity,
  type NormalizedSenderId,
  normalizeSenderId,
  buildSenderIdentity,
  getPrimaryIdentifier,
  getAllIdentifiers,
  formatSenderIdentity,
} from "./sender-identity.js";

// Group Access
export {
  type GroupPolicy,
  type SenderGroupAccessReason,
  type SenderGroupAccessDecision,
  type MentionMode,
  type GroupAccessConfig,
  DEFAULT_GROUP_CONFIG,
  isSenderAllowlisted,
  evaluateGroupAccess,
  containsMention,
  shouldRespondToMention,
  stripMention,
} from "./group-access.js";

// Tool Scope
export {
  type ToolAccess,
  type ToolScopeRule,
  type SenderToolScope,
  type ToolScopeConfig,
  DEFAULT_TOOL_SCOPE_CONFIG,
  evaluateToolAccess,
  isToolAllowed,
  getAllowedTools,
  createToolFilter,
  buildToolScopeDescription,
} from "./tool-scope.js";

// User Data Store
export {
  type DataItem,
  type UserDataStoreConfig,
  type StorageStats,
  DEFAULT_STORE_CONFIG,
  CrossUserAccessError,
  StorageQuotaError,
  UserDataStore,
} from "./user-data-store.js";

// Tool Wrapper
export {
  type ToolExecutionContext,
  type PrivacyGuardResult,
  type ToolGuard,
  fileAccessGuard,
  bashGuard,
  spawnAgentGuard,
  mcpToolGuard,
  registerToolGuard,
  getToolGuard,
  wrapToolWithPrivacy,
  auditToolExecution,
  getAuditLog,
  clearAuditLog,
} from "./tool-wrapper.js";

// Consent
export {
  type ConsentStatus,
  type ConsentRequest,
  type ConsentConfig,
  ConsentError,
  getConsentManager,
  requestDataAccessConsent,
  isDataAccessConsented,
  formatConsentRequest,
} from "./consent.js";

// MCP Wrapper
export {
  type McpTool,
  type McpToolResult,
  type McpWrapperOptions,
  wrapMcpTool,
  wrapMcpTools,
  extractDataOwner,
  withPrivacySchema,
} from "./mcp-wrapper.js";
