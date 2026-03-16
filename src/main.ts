/**
 * main.ts — entry point.
 * Starts the Telegram bot + proactive scheduler in one process.
 * Managed by launchd (KeepAlive: true).
 */
import { initStore } from "./store.js";
import { startBot, stopBot } from "./bot.js";
import { startScheduler, stopScheduler, forceMode } from "./scheduler.js";
import { notifyOwner } from "./telegram.js";
import type { SchedulerMode } from "./config.js";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const forceModeArg = args.find(a => a.startsWith("--force="))?.slice("--force=".length);

// ── Init ────────────────────────────────────────────────────────────────────
initStore();
console.log("[pi-tg] Starting…");

// ── Force mode (manual trigger + exit) ─────────────────────────────────────
if (forceModeArg) {
  const valid: SchedulerMode[] = ["morning_brief", "pulse", "igne_surface", "evening_wrap", "stale_review"];
  if (!valid.includes(forceModeArg as SchedulerMode)) {
    console.error(`Unknown mode: ${forceModeArg}. Valid: ${valid.join(", ")}`);
    process.exit(1);
  }
  console.log(`[pi-tg] Force mode: ${forceModeArg}`);
  await forceMode(forceModeArg as SchedulerMode);
  process.exit(0);
}

// ── Start both systems ──────────────────────────────────────────────────────
startScheduler();
void startBot(); // long-polls forever — returns only when stopBot() is called

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`[pi-tg] ${signal}. Shutting down.`);
  stopScheduler();
  stopBot();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", async (err: Error) => {
  console.error("[pi-tg] Uncaught exception:", err);
  await notifyOwner(`⚠️ pi-tg crashed: ${err.message}`).catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[pi-tg] Unhandled rejection:", reason);
});
