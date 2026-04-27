/**
 * subagent.ts — spawn focused background agents for tasks.
 *
 * Sub-agents run independently, send updates directly to the user,
 * and don't block the main conversation thread.
 */
import { join } from "node:path";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  codingTools,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./config.js";
import { PI_SESSIONS_DIR } from "./store.js";
import { sendMessage } from "./telegram.js";

export interface SubAgentOptions {
  id: string;
  task: string;
  chatId: number;
  replyToMsgId: number;
  cwd?: string;
  context?: string;
}

interface ActiveAgent {
  id: string;
  task: string;
  startedAt: number;
}

const active = new Map<string, ActiveAgent>();

export function activeSubAgents(): ActiveAgent[] {
  return Array.from(active.values());
}

export async function spawnSubAgent(opts: SubAgentOptions): Promise<void> {
  const { id, task, chatId, replyToMsgId, context } = opts;
  const cwd = opts.cwd ?? PATHS.data;

  active.set(id, { id, task, startedAt: Date.now() });

  // Run fully in background — caller does not await
  void (async () => {
    const reply = (text: string) =>
      sendMessage(chatId, text, {
        reply_parameters: { message_id: replyToMsgId },
      }).catch(() => {});

    await reply(`🚀 [${id}] Starting: ${task}`);

    try {
      const authStorage = AuthStorage.create(join(PATHS.agentDir, "auth.json"));
      const modelRegistry = new ModelRegistry(authStorage, join(PATHS.agentDir, "models.json"));
      const settingsManager = SettingsManager.create(cwd, PATHS.agentDir);
      // Sub-agent sessions live alongside the main session — visible in `pi -r`
      const subSessionFile = join(PI_SESSIONS_DIR, `${id}.jsonl`);
      const sessionManager = SessionManager.open(subSessionFile, PI_SESSIONS_DIR);
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: PATHS.agentDir, settingsManager });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir: PATHS.agentDir,
        authStorage,
        modelRegistry,
        settingsManager,
        sessionManager,
        resourceLoader,
        tools: codingTools,
      });

      session.agent.setSystemPrompt(buildPrompt(id, task, context));

      // Send progress on tool completions (throttled)
      let lastUpdate = 0;
      const UPDATE_MS = 10_000;
      session.subscribe(event => {
        if (event.type === "tool_execution_end") {
          const now = Date.now();
          if (now - lastUpdate > UPDATE_MS) {
            lastUpdate = now;
            const e = event as unknown as { toolName: string };
            void reply(`[${id}] ✓ ${e.toolName}`);
          }
        }
      });

      let output = "";
      session.subscribe(event => {
        if (event.type === "message_update") {
          const e = event as unknown as { assistantMessageEvent?: { type: string; delta?: string } };
          if (e.assistantMessageEvent?.type === "text_delta") {
            output += e.assistantMessageEvent.delta ?? "";
          }
        }
      });

      await session.prompt(task + (context ? `\n\nContext:\n${context}` : ""));

      const summary = output.trim().slice(0, 1000);
      await reply(`[${id}] ✅ Done\n\n${summary || "(no output)"}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply(`[${id}] ❌ Failed: ${msg.slice(0, 300)}`);
      console.error(`[subagent:${id}]`, err);
    } finally {
      active.delete(id);
    }
  })();
}

function buildPrompt(id: string, task: string, context?: string): string {
  return `You are a focused sub-agent [${id}].
Task: "${task}"
${context ? `\nContext:\n${context}` : ""}

Rules:
- Work autonomously with bash, read, edit, write tools
- Do not ask clarifying questions — make reasonable decisions
- Use rg/fd not grep/find
- When done, summarize what you did in 2-3 lines`;
}
