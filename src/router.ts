/**
 * router.ts — parse incoming Telegram messages.
 *
 * Non-command messages go straight to the agent.
 * Commands the bot handles itself (no agent needed):
 *   /help     — show commands
 *   /status   — uptime, model
 *   /reset    — clear session context
 *   /agents   — list active sub-agents
 */
import { MAIN_CONVERSATION } from "./config.js";
import { evictSession } from "./agent.js";
import { activeSubAgents } from "./subagent.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RouteResult =
  | { kind: "message" }
  | { kind: "command_reply"; text: string };

// ── Router ─────────────────────────────────────────────────────────────────

export function route(text: string): RouteResult {
  if (text.trim().startsWith("/")) return handleCommand(text.trim());
  return { kind: "message" };
}

// ── Commands ───────────────────────────────────────────────────────────────

function handleCommand(text: string): RouteResult {
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd?.toLowerCase()) {
    case "/help":   return { kind: "command_reply", text: helpText() };
    case "/status": return cmdStatus();
    case "/reset":  return cmdReset();
    case "/agents": return cmdAgents();
    default:
      return { kind: "command_reply", text: `Unknown: ${cmd}\n\n${helpText()}` };
  }
}

function cmdStatus(): RouteResult {
  const uptime = formatUptime(process.uptime());
  const agents = activeSubAgents();
  const lines = [
    `🤖 pi-tg`,
    `Uptime: ${uptime}`,
    agents.length > 0 ? `Sub-agents: ${agents.length} active` : null,
  ].filter((l): l is string => l !== null);
  return { kind: "command_reply", text: lines.join("\n") };
}

function cmdReset(): RouteResult {
  evictSession(MAIN_CONVERSATION);
  return { kind: "command_reply", text: "🔄 Session context cleared." };
}

function cmdAgents(): RouteResult {
  const agents = activeSubAgents();
  if (agents.length === 0) return { kind: "command_reply", text: "No active sub-agents." };
  const lines = agents.map(a => {
    const age = Math.round((Date.now() - a.startedAt) / 1000);
    return `• ${a.id} — ${a.task.slice(0, 50)} (${formatUptime(age)})`;
  });
  return { kind: "command_reply", text: `Active sub-agents:\n\n${lines.join("\n")}` };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function helpText(): string {
  return [
    "/status  — uptime & info",
    "/reset   — clear session context",
    "/agents  — list active sub-agents",
    "/help    — this",
  ].join("\n");
}
