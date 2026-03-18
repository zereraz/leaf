/**
 * debug-client-agent.ts — auto-diagnoses client delivery issues.
 *
 * Triggers when bot.ts detects a mismatch between what the agent produced
 * and what telegram received. Also powers /debug with full diagnostics.
 *
 * Ephemeral sessions — no history needed, each diagnosis is standalone.
 */
import { join } from "node:path";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./config.js";
import { readLog, type LogEntry } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DeliveryReport {
  readonly agentText: string;
  readonly sentText: string;
  readonly streamingMeta: StreamingMeta;
}

export interface StreamingMeta {
  readonly committedChars: number;
  readonly editCount: number;
  readonly rateLimitHits: number;
  readonly editErrors: string[];
  readonly durationMs: number;
}

export interface DiagnosisResult {
  readonly summary: string;
  readonly issue: string;
  readonly suggestion: string;
}

// ── Recent delivery reports (in-memory ring buffer) ────────────────────────

const MAX_REPORTS = 20;
const recentReports: Array<{ ts: number; report: DeliveryReport; diagnosis?: DiagnosisResult }> = [];

export function recordDeliveryReport(report: DeliveryReport): void {
  recentReports.push({ ts: Date.now(), report });
  if (recentReports.length > MAX_REPORTS) recentReports.shift();
}

// ── Diagnose a mismatch ────────────────────────────────────────────────────

export async function diagnoseMismatch(report: DeliveryReport): Promise<DiagnosisResult> {
  const { agentText, sentText, streamingMeta } = report;

  // Quick heuristic diagnosis — no LLM needed for obvious cases
  const quick = quickDiagnosis(agentText, sentText, streamingMeta);
  if (quick) {
    const entry = recentReports[recentReports.length - 1];
    if (entry) entry.diagnosis = quick;
    return quick;
  }

  // Fall back to LLM for non-obvious cases
  try {
    return await llmDiagnosis(report);
  } catch (err) {
    const fallback: DiagnosisResult = {
      summary: `Mismatch: agent=${agentText.length} chars, sent=${sentText.length} chars`,
      issue: `Diagnosis failed: ${(err as Error).message}`,
      suggestion: "Check /debug for raw data",
    };
    const entry = recentReports[recentReports.length - 1];
    if (entry) entry.diagnosis = fallback;
    return fallback;
  }
}

function quickDiagnosis(agent: string, sent: string, meta: StreamingMeta): DiagnosisResult | null {
  // Case 1: sent is a suffix of agent — streaming committed early chars then overwrote
  if (agent.endsWith(sent) && sent.length < agent.length) {
    const lostChars = agent.length - sent.length;
    return {
      summary: `Lost first ${lostChars} chars — sent only the tail`,
      issue: `committedChars=${meta.committedChars} during streaming, final send started from offset. Earlier edits were overwrites that got lost.`,
      suggestion: "The streaming edit cycle committed partial content, then final send only sent the remainder. The user's message was an edit-in-place, so earlier content was replaced, not appended.",
    };
  }

  // Case 2: rate limit errors
  if (meta.rateLimitHits > 0) {
    return {
      summary: `Rate limited ${meta.rateLimitHits}x — edits were dropped`,
      issue: `Telegram returned 429 during streaming. ${meta.editErrors.length} edit(s) failed.`,
      suggestion: "Increase EDIT_INTERVAL_MS or MIN_DELTA_CHARS to reduce API calls.",
    };
  }

  // Case 3: sent is empty or nearly empty
  if (sent.length < 10 && agent.length > 100) {
    return {
      summary: `Almost nothing delivered — agent had ${agent.length} chars, sent ${sent.length}`,
      issue: "Final edit/send likely failed entirely.",
      suggestion: "Check telegram API errors in console logs.",
    };
  }

  // Case 4: truncated at a chunk boundary
  if (agent.startsWith(sent) && sent.length < agent.length) {
    return {
      summary: `Truncated at ${sent.length} chars (agent had ${agent.length})`,
      issue: "Content was cut off — likely hit NEAR_MAX boundary and the follow-up message failed.",
      suggestion: "Check if ctx.send() for overflow chunk threw an error.",
    };
  }

  return null; // non-obvious — needs LLM
}

async function llmDiagnosis(report: DeliveryReport): Promise<DiagnosisResult> {
  const { agentText, sentText, streamingMeta } = report;

  const prompt = `You are a debug agent diagnosing a message delivery issue in a Telegram bot.

## Agent's full response (${agentText.length} chars)
${agentText.slice(0, 2000)}${agentText.length > 2000 ? "\n...[truncated]" : ""}

## What telegram received (${sentText.length} chars)  
${sentText.slice(0, 2000)}${sentText.length > 2000 ? "\n...[truncated]" : ""}

## Streaming metadata
- committedChars: ${streamingMeta.committedChars}
- editCount: ${streamingMeta.editCount}
- rateLimitHits: ${streamingMeta.rateLimitHits}
- editErrors: ${JSON.stringify(streamingMeta.editErrors)}
- durationMs: ${streamingMeta.durationMs}

Diagnose: what exactly went wrong? Why is the sent text different from the agent text?
Reply in exactly this format:
SUMMARY: one line
ISSUE: what went wrong technically
SUGGESTION: how to fix it`;

  const authStorage = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
  const settingsManager = SettingsManager.create(PATHS.data, PATHS.agentDir);
  const loader = new DefaultResourceLoader({ cwd: PATHS.data, agentDir: PATHS.agentDir, settingsManager });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: PATHS.data,
    agentDir: PATHS.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: [],
  });

  session.agent.setSystemPrompt("You are a concise debug agent. Diagnose delivery issues. No fluff.");

  let output = "";
  const unsub = session.subscribe(event => {
    if (event.type === "message_update") {
      const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") {
        output += e.assistantMessageEvent.delta ?? "";
      }
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    unsub();
  }

  // Parse structured response
  const lines = output.trim().split("\n");
  const get = (prefix: string) => lines.find(l => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";

  const result: DiagnosisResult = {
    summary: get("SUMMARY:") || output.slice(0, 100),
    issue: get("ISSUE:") || "Could not parse",
    suggestion: get("SUGGESTION:") || "Check raw logs",
  };

  const entry = recentReports[recentReports.length - 1];
  if (entry) entry.diagnosis = result;

  return result;
}

// ── /debug command data ────────────────────────────────────────────────────

export interface DebugSnapshot {
  readonly lastMessages: Array<{
    ts: number;
    agentLen: number;
    sentLen: number | null;
    mismatch: boolean;
    diagnosis?: DiagnosisResult | undefined;
    preview: string;
  }>;
  readonly recentMismatches: number;
  readonly botState: {
    uptime: number;
    reportsTracked: number;
  };
}

export function getDebugSnapshot(n: number): DebugSnapshot {
  const log = readLog();
  const botMsgs = log.filter(e => e.role === "bot").slice(-n);

  const lastMessages = botMsgs.map(entry => {
    const matchingReport = recentReports.find(r =>
      Math.abs(r.ts - entry.ts) < 5000
    );

    return {
      ts: entry.ts,
      agentLen: entry.text.length,
      sentLen: entry.sentText?.length ?? null,
      mismatch: entry.sentText != null,
      diagnosis: matchingReport?.diagnosis,
      preview: entry.text.slice(0, 500),
    };
  });

  return {
    lastMessages,
    recentMismatches: recentReports.filter(r => r.diagnosis).length,
    botState: {
      uptime: process.uptime(),
      reportsTracked: recentReports.length,
    },
  };
}

export function formatDebugSnapshot(snap: DebugSnapshot): string {
  const lines: string[] = [];
  
  lines.push(`🔍 Debug — ${snap.botState.reportsTracked} reports tracked, ${snap.recentMismatches} mismatches, uptime ${Math.round(snap.botState.uptime / 60)}m`);
  lines.push("");

  for (const msg of snap.lastMessages) {
    const time = new Date(msg.ts).toLocaleString("en-IN", { timeZone: "Asia/Calcutta" });
    const status = msg.mismatch ? "⚠️ MISMATCH" : "✅ OK";
    lines.push(`--- ${time} (${msg.agentLen} chars) ${status} ---`);

    if (msg.mismatch && msg.sentLen != null) {
      lines.push(`  agent=${msg.agentLen}, sent=${msg.sentLen}, lost=${msg.agentLen - msg.sentLen}`);
    }

    if (msg.diagnosis) {
      lines.push(`  📋 ${msg.diagnosis.summary}`);
      lines.push(`  🔧 ${msg.diagnosis.suggestion}`);
    }

    lines.push(msg.preview.slice(0, 300));
    if (msg.preview.length > 300) lines.push("…[truncated]");
    lines.push("");
  }

  return lines.join("\n").trim();
}
