/**
 * main.ts — entry point.
 *
 * Creates the transport (TelegramTransport) and injects it into the bot.
 * To switch to WhatsApp: replace TelegramTransport with WhatsAppTransport here.
 * Nothing else changes.
 */
import { initStore } from "./store.js";
import { createBot } from "./bot.js";
import { startScheduler, stopScheduler, forceMode } from "./scheduler.js";
import { TelegramTransport } from "./telegram.js";
import { notifyOwner } from "./telegram.js";
import { warmupSession } from "./agent.js";
import { TG } from "./config.js";
import type { SchedulerMode } from "./config.js";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const forceModeArg = args.find(a => a.startsWith("--force="))?.slice("--force=".length);

// ── Init ────────────────────────────────────────────────────────────────────
initStore();
console.log("[leaf] Starting…");

// ── Force mode (manual trigger + exit) ─────────────────────────────────────
if (forceModeArg) {
  const valid: SchedulerMode[] = ["morning_brief", "pulse", "evening_wrap", "stale_review"];
  if (!valid.includes(forceModeArg as SchedulerMode)) {
    console.error(`Unknown mode: ${forceModeArg}. Valid: ${valid.join(", ")}`);
    process.exit(1);
  }
  console.log(`[leaf] Force mode: ${forceModeArg}`);
  await forceMode(forceModeArg as SchedulerMode);
  process.exit(0);
}

// ── Transport — swap here for WhatsApp, Discord, etc. ──────────────────────
const transport = new TelegramTransport(TG.ownerChatId);

// ── Bot + scheduler ─────────────────────────────────────────────────────────
const bot = createBot(transport);

startScheduler();
void bot.start();

// Warm session — first message pays no init cost
void warmupSession();
notifyOwner("👋 leaf online").catch(() => {});

// ── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`[leaf] ${signal}. Shutting down.`);
  await notifyOwner(`🔴 going down (${signal})`).catch(() => {});
  stopScheduler();
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("uncaughtException", async (err: Error) => {
  console.error("[leaf] Uncaught exception:", err);
  await notifyOwner(`⚠️ leaf crashed: ${err.message}`).catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[leaf] Unhandled rejection:", reason);
});
