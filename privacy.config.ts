/**
 * privacy.config.ts — simple data isolation config.
 *
 * Rules:
 * - Everyone can use the bot (DMs and groups)
 * - Everyone can use all tools
 * - User data is isolated (User A cannot access User B's data)
 */

import type { BotPrivacyConfig } from "./src/bot.js";

export const privacyConfig: BotPrivacyConfig = {
  // No owners - everyone treated equally
  ownerIds: [],

  // Not strict - allow by default
  strictMode: false,

  // Groups: Everyone can chat, but must @mention the bot
  groupAccess: {
    policy: "open",                 // Anyone can use
    allowlist: [],                  // Not needed with "open"
    mentionMode: "require_in_group", // Must type @botname to trigger response
    botUsername: "leafbot",          // CHANGE THIS: Your bot's actual name
    requireParticipant: false,
    allowWhenEmpty: true,
  },

  // Tools: Everyone can use all tools
  toolScope: {
    globalDefault: "allow",
    dangerousTools: [],    // Don't flag any tools as dangerous
    senderScopes: [],      // No per-user restrictions
  },
};
