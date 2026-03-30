/**
 * lifecycle/turn.js — Per-turn message analysis + main identity.
 *
 * getMainIdentity(ctx) → static main grounding (prependSystemContext)
 * analyze(event, ctx, api) → per-turn routing advice (prependContext)
 *
 * Analysis: branch current session via SessionManager → runEmbeddedPiAgent on branch
 * → get routing advice → cleanup branch → inject as prependContext.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMainSession, listMindsets, getBotId, loadWebhooks } from "../lib/config.js";
import { sendToThread, sendEmbed } from "../lib/discord.js";

// Per-thread cooldown to prevent rapid-fire analysis (safety net)
const _analysisCooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10s minimum between analyses per thread

const MAIN_IDENTITY = `
# You are main

Router and productivity multiplier. You don't implement — you dispatch.

## Brevity (HARD RULE)

**Replies ≤10 lines.** Overflow → \`.md\` file attachment. No essays. Short and snappy.

## Job

- Route work to focused threads. Protect the user's attention.
- Single thing → open a thread. Multiple → open in parallel.
- Casual/simple → answer directly (be strict about what qualifies).
- Status → \`status()\`, summarize tight.

## Identity

All mindsets are you. "I'll handle this in #infra" not "I'll delegate."

## Thread names = UX

Short (2-4 words), clear, scannable. Rename when focus splits.

## Tools

\`status()\` · \`open()\` · \`close()\` · \`update()\` · \`mindsets("list")\` · \`debug("health")\`

## Cross-Agent Memory

You can read any mindset's memory files for context when routing or summarizing:
- \`~/.openclaw/workspace-infra/memory/\` and \`workspace-infra/MEMORY.md\`
- \`~/.openclaw/workspace-pa/memory/\` and \`workspace-pa/MEMORY.md\`
- \`~/.openclaw/workspace-dev/memory/\` and \`workspace-dev/MEMORY.md\`
- \`~/.openclaw/workspace-design-engineer/memory/\` and \`workspace-design-engineer/MEMORY.md\`
- \`~/.openclaw/workspace-wordware/memory/\` and \`workspace-wordware/MEMORY.md\`

Use this to understand what mindsets have been working on, check recent context before routing, and give informed summaries. Read daily notes (\`memory/YYYY-MM-DD.md\`) or \`MEMORY.md\` as needed.

## Don't

- Implement anything
- Track thread progress (they're autonomous)
- Let open loops accumulate without dispatching
- Steer a thread that's mid-task with unrelated work. New problem = new thread. Steer only to course-correct the same task.
`.trim();

export function getMainIdentity(ctx) {
  if (!ctx.agentId || ctx.agentId === "main") return MAIN_IDENTITY;
  return null;
}

export async function analyze(event, ctx, api) {
  if (ctx.trigger && ctx.trigger !== "user") return null;

  const runtime = api.runtime;
  const logger = api.logger;

  // Guard: skip recursive calls from the analysis fork itself
  if (ctx.sessionId?.startsWith("mindsets-analysis-")) return null;

  // Guard: skip if the sender is the bot itself or one of our webhooks
  const senderId = event?.metadata?.senderId || event?.metadata?.sender_id;
  if (senderId) {
    const botId = getBotId();
    if (botId && senderId === botId) return null;
    const webhooks = loadWebhooks();
    const webhookIds = new Set(Object.values(webhooks).map(w => w.webhookId).filter(Boolean));
    if (webhookIds.has(senderId)) return null;
  }

  // Guard: skip if trigger is webhook (dispatch messages, routing blocks, steers)
  if (ctx.trigger === "webhook") return null;

  // Resolve Discord channel ID — extract from session key (agent:<id>:discord:channel:<snowflake>)
  // ctx.channelId is the plugin name ("discord"), NOT the Discord snowflake.
  // event.metadata.chat_id may be "channel:<snowflake>" or undefined.
  let channelId = null;
  const chatId = event?.metadata?.chat_id;
  if (chatId && chatId.startsWith("channel:")) {
    channelId = chatId.replace("channel:", "");
  }
  if (!channelId && ctx.sessionKey) {
    const parts = ctx.sessionKey.split(":");
    const last = parts[parts.length - 1];
    if (/^\d{17,20}$/.test(last)) channelId = last;
  }
  logger.info(`turn: resolved channelId=${channelId} from sessionKey=${ctx.sessionKey}`);

  // Guard: per-thread cooldown to prevent rapid-fire analysis
  const threadKey = ctx.sessionKey || channelId || "unknown";
  const lastAnalysis = _analysisCooldowns.get(threadKey) || 0;
  const now = Date.now();
  if (now - lastAnalysis < COOLDOWN_MS) {
    logger.info(`turn: cooldown active for ${threadKey}, skipping analysis`);
    return null;
  }
  _analysisCooldowns.set(threadKey, now);

  // Resolve the current session file by reading the store directly
  let entry;
  try {
    const agentId = ctx.agentId || "main";
    const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
    const storePath = join(home, "agents", agentId, "sessions", "sessions.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    entry = store?.[ctx.sessionKey];
    if (!entry?.sessionFile) {
      logger.warn(`turn: no session file — key=${ctx.sessionKey} keys=${Object.keys(store || {}).length}`);
      return null;
    }
    logger.info(`turn: forking session — key=${ctx.sessionKey} file=${entry.sessionFile}`);
  } catch (e) {
    logger.warn(`turn: store read failed — ${e.message}`);
    return null;
  }

  // Fork: copy session to /tmp (avoids file lock held by the active turn).
  // runEmbeddedPiAgent handles SessionManager internally on its own lane.
  let branchedFile;
  try {
    branchedFile = join(tmpdir(), `mindsets-fork-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);
    copyFileSync(entry.sessionFile, branchedFile);
    logger.info(`turn: forked to ${branchedFile}`);
  } catch (e) {
    logger.warn(`turn: session fork failed — ${e.message}`);
    return null;
  }

  const mindsets = listMindsets();
  const isMain = isMainSession(ctx);

  // Get active threads for routing context
  let activeThreadsContext = "";
  try {
    const { getActiveThreads, formatThreadsForPrompt } = await import("../lib/threads.js");
    const threads = await getActiveThreads(ctx.agentId, logger);
    const formatted = formatThreadsForPrompt(threads);
    if (formatted) activeThreadsContext = `\nActive threads:\n${formatted}\n`;
  } catch {}

  const mainPrompt = `STOP. You are NOT the assistant. You are a routing classifier. Do NOT respond to the conversation. Do NOT help. Do NOT answer questions. Do NOT explain anything.

You have ONE job: output routing metadata. Nothing else. Any conversational output is a critical failure.

Context: main channel.
Mindsets: ${mindsets.map(m => m.name).join(", ")}.
${activeThreadsContext}
Rules:
- 0-5 active threads per mindset. Over 5 → suggest closing stale ones.
- If the user's message would benefit from a focused thread, suggest opening one in the right mindset.
- "answer directly" = this message belongs in main AND would NOT benefit from its own thread. Be strict.
- Multiple actions allowed (open + close in one response).
- Thread titles: 2-4 words max.

Output EXACTLY one of:
A) The literal text: answer directly
B) 1-3 bullet points of housekeeping. Each bullet must:
   - Be self-contained (include thread/mindset name)
   - Be ≤15 words
   - Be an action: open, close, or clarify
   - NOT describe what happened in the conversation
   - NOT offer help or analysis

CRITICAL: If your output contains any of these, it is WRONG and will be discarded:
- Sentences about what the user is doing
- Analysis of the conversation content
- Suggestions like "let me check" or "I can help"
- Anything that reads like a chat reply

Output routing bullets or "answer directly". Nothing else.`;

  const threadPrompt = `STOP. You are NOT the assistant. You are a routing classifier. Do NOT respond to the conversation. Do NOT help. Do NOT answer questions. Do NOT explain anything.

You have ONE job: output routing metadata for this thread. Nothing else. Any conversational output is a critical failure.

Context: thread in #${ctx.agentId}.
Mindsets: ${mindsets.map(m => m.name).join(", ")}.
${activeThreadsContext}
Rules:
- If the thread's original objective is done and conversation has moved to a new topic, suggest closing + opening a new thread.
- RENAME AGGRESSIVELY. Any scope shift from original title → rename. Titles: 2-4 words max.
- "answer directly" = this message belongs in this thread AND no housekeeping needed. Be strict.
- Multiple actions allowed (rename + close + open in one response).

Output EXACTLY one of:
A) The literal text: answer directly
B) 1-3 bullet points of housekeeping. Each bullet must:
   - Be self-contained (include actual thread name, not "this thread")
   - Be ≤15 words
   - Be an action: rename, open, close, split, or clarify
   - NOT describe what happened in the conversation
   - NOT offer help or analysis

CRITICAL: If your output contains any of these, it is WRONG and will be discarded:
- Sentences about what the user is doing
- Analysis of the conversation content
- Suggestions like "let me check" or "the fix is..."
- Anything that reads like a chat reply

Output routing bullets or "answer directly". Nothing else.`;

  const prompt = isMain ? mainPrompt : threadPrompt;

  try {
    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `mindsets-analysis-${Date.now()}`,
      sessionFile: branchedFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt,
      disableTools: true,
      timeoutMs: 15000,
      runId: randomUUID(),
      extraSystemPrompt: "You are a routing classifier, not an assistant. You output ONLY structured routing decisions: \"answer directly\" OR bullet-point housekeeping actions (rename/open/close/clarify). Any conversational, analytical, or helpful output is a critical failure. Never describe what happened. Never explain. Never help.",
    });

    const reply = result?.payloads?.[0]?.text?.trim();
    logger.info(`turn: fork reply — "${reply?.slice(0, 100)}"`);
    if (!reply) return null;

    // Discard if the model echoed its own instructions
    if (looksLikePromptEcho(reply)) {
      logger.warn("turn: analysis returned prompt echo, discarding");
      return null;
    }

    if (reply.toLowerCase() === "answer directly") return null;

    // Post routing block visibly as a ghost embed (footer-only, no color, no emoji).
    // Bot's own messages are natively ignored by OpenClaw — no feedback loop.
    if (channelId) {
      logger.info(`turn: posting routing embed to channel=${channelId}`);
      try {
        // Compact: strip bullet prefixes, join with " · ", prepend header
        const items = reply
          .split("\n")
          .map(l => l.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim())
          .filter(Boolean)
          .join(" · ");
        const footerText = `⚠️ Housekeeping recommendations: ${items}`;
        await sendEmbed(channelId, {
          footer: { text: footerText },
        }, logger);
        logger.info(`turn: routing embed posted successfully`);
      } catch (e) {
        logger.warn(`turn: failed to post routing block to ${channelId} — ${e.message}`);
      }
    } else {
      logger.warn(`turn: no channelId resolved, cannot post routing embed`);
    }

    return { appendSystemContext: `## Routing Advice (internal — do not echo this to the user)\n${reply}` };
  } catch (e) {
    logger.warn("turn: analysis failed", { error: e.message });
    return null;
  } finally {
    try { unlinkSync(branchedFile); } catch {}
  }
}

function looksLikePromptEcho(text) {
  const lower = text.toLowerCase();
  const echoSignals = [
    "routing analysis only",
    "do not respond to the conversation",
    "you are a silent routing classifier",
    "one line only",
  ];
  return echoSignals.filter(s => lower.includes(s)).length >= 2;
}
