/**
 * main.ts — entry point.
 *
 * Creates the transport and injects it into the bot.
 * Set TRANSPORT env var: telegram (default) or whatsapp
 */
import { initStore } from "./store.js";
import { createBot, type BotPrivacyConfig } from "./bot.js";
import { startScheduler, stopScheduler, forceMode } from "./scheduler.js";
import { TelegramTransport } from "./telegram.js";
import { WhatsAppTransport, clearWhatsAppAuth } from "./whatsapp.js";
import { warmupSession } from "./agent.js";
import { TG, WA } from "./config.js";
import type { SchedulerMode } from "./config.js";
import type { Transport } from "./transport.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

// ── Load privacy config ────────────────────────────────────────────────────
async function loadPrivacyConfig(): Promise<BotPrivacyConfig | undefined> {
  const configPath = resolve(process.cwd(), "privacy.config.ts");
  const jsPath = resolve(process.cwd(), "privacy.config.js");

  try {
    if (existsSync(configPath)) {
      const module = await import(pathToFileURL(configPath).href);
      console.log("[leaf] Loaded privacy config from privacy.config.ts");
      return module.privacyConfig ?? module.default;
    }
    if (existsSync(jsPath)) {
      const module = await import(pathToFileURL(jsPath).href);
      console.log("[leaf] Loaded privacy config from privacy.config.js");
      return module.privacyConfig ?? module.default;
    }
  } catch (err) {
    console.warn("[leaf] Failed to load privacy config:", (err as Error).message);
  }

  console.log("[leaf] No privacy.config.ts found - using defaults (open access)");
  return undefined;
}

const privacyConfig = await loadPrivacyConfig();

// ── Bot + scheduler ─────────────────────────────────────────────────────────
const bot = createBot(transport, privacyConfig);

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
