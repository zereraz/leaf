/**
 * main.ts — entry point.
 *
 * Creates the transport and injects it into the bot.
 * Set TRANSPORT env var: telegram (default) or whatsapp
 */
import { initStore } from "./store.js";
import { createBot } from "./bot.js";
import { startScheduler, stopScheduler, forceMode } from "./scheduler.js";
import { TelegramTransport } from "./telegram.js";
import { WhatsAppTransport, clearWhatsAppAuth } from "./whatsapp.js";
import { warmupSession } from "./agent.js";
import { TG, WA } from "./config.js";
import type { SchedulerMode } from "./config.js";
import type { Transport } from "./transport.js";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const forceModeArg = args.find(a => a.startsWith("--force="))?.slice("--force=".length);

// Handle --clear-whatsapp-auth flag
if (args.includes("--clear-whatsapp-auth")) {
  console.log("[leaf] Clearing WhatsApp auth...");
  await clearWhatsAppAuth();
  process.exit(0);
}

// ── Transport selection ────────────────────────────────────────────────────
const transportType = process.env["TRANSPORT"] ?? "telegram";
let transport: Transport;

if (transportType === "whatsapp") {
  if (!WA.ownerPhone) {
    console.error("[leaf] WA_OWNER_PHONE env var required for WhatsApp transport");
    process.exit(1);
  }
  console.log("[leaf] Using WhatsApp (Baileys) transport");
  transport = new WhatsAppTransport(WA.ownerPhone);
} else {
  console.log("[leaf] Using Telegram transport");
  transport = new TelegramTransport(TG.ownerChatId);
}

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

// ── Bot + scheduler ─────────────────────────────────────────────────────────
const bot = createBot(transport);

startScheduler();
void bot.start();

// Warm session — first message pays no init cost
void warmupSession();
transport.notifyOwner("👋 leaf online").catch(() => {});

// ── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`[leaf] ${signal}. Shutting down.`);
  await transport.notifyOwner(`🔴 going down (${signal})`).catch(() => {});
  stopScheduler();
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("uncaughtException", async (err: Error) => {
  console.error("[leaf] Uncaught exception:", err);
  await transport.notifyOwner(`⚠️ leaf crashed: ${err.message}`).catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[leaf] Unhandled rejection:", reason);
});
