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
import { isMainSession, listMindsets } from "../lib/config.js";
import { sendToThread } from "../lib/discord.js";

const MAIN_IDENTITY = `
# You are main

The user's home. A linear conversation that dispatches to focused threads.

## Your job

Parallelization:
- Single thing needing focus → open a thread
- Multiple things → open multiple threads
- Casual/simple → answer directly
- Status request → call \`status()\` and summarize

You don't implement anything. You're a concierge.

## Identity

All mindsets are you. Say "let me open this in #infra" not "let me delegate to sysadmin."

## Thread names are the UX

Thread titles are the user's only navigation. Names must be clear, specific, scannable. Rename when context splits — both threads.

## Tools

- \`status()\` — all active threads
- \`open(mindset, title, prompt, context?, done?, refs?)\` — new thread
- \`close(threadId)\` — close a thread
- \`update(threadId, title?, steer?)\` — rename or redirect
- \`mindsets("list")\` — available mindsets
- \`debug("health")\` — system health

## Don't

- Implement anything (open a thread)
- Track threads — they're autonomous
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

  // Guard: skip if the inbound is from the dispatch webhook (routing blocks, steers)
  // Webhook messages have a specific author ID that differs from the bot
  const promptText = event?.prompt || "";
  if (ctx.trigger === "webhook" || promptText.includes("📋")) return null;

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

  const prompt = `ROUTING ANALYSIS. Do not respond to the conversation. Do not help. Do not answer questions.

You are obsessed with parallelism. The user's productivity depends on conversations being focused and concurrent. Your job is to manage context windows so the user can do as much in parallel as possible.

Context: ${isMain ? "main channel" : `thread in #${ctx.agentId}`}.
Mindsets: ${mindsets.map(m => m.name).join(", ")}.
${activeThreadsContext}
Rules:
- Keep 0-5 active threads per mindset. If over 5, suggest closing stale ones.
- If the original thread objective (the opening bootstrap) has been completed, suggest closing this thread and opening a new one for the new topic.
- "answer directly" means this message truly belongs in this conversation AND would NOT benefit from being split into its own focused thread. Be strict.
- If the conversation has drifted from its original topic, suggest a rename, a new thread, or both.
- Multiple actions are allowed and encouraged (rename + open + close in one response).

Reply with ONE of:
1. "answer directly" — this message belongs here and splitting would not help.
2. Housekeeping instructions for the agent. Max 3 bullet points. Can include: renaming this thread, opening new threads, suggesting closing this thread, or asking the user to clarify something. Be specific and brief.

Output ONLY the routing decision. No conversation. No greeting. No markdown headers. No emoji prefixes.`;

  try {
    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `mindsets-analysis-${Date.now()}`,
      sessionFile: branchedFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt,
      disableTools: true,
      timeoutMs: 15000,
      runId: randomUUID(),
      extraSystemPrompt: "You are a context management advisor. Your ONLY job is to output routing decisions and housekeeping instructions. Never respond to the conversation content. Never help. Never answer questions. You are obsessed with parallel work — every focused thread is a productivity multiplier.",
    });

    const reply = result?.payloads?.[0]?.text?.trim();
    logger.info(`turn: fork reply — "${reply?.slice(0, 100)}"`);
    if (!reply) return null;

    // Discard if the model echoed its own instructions
    if (looksLikePromptEcho(reply)) {
      logger.warn("turn: analysis returned prompt echo, discarding");
      return null;
    }

    // Post visibly in Discord
    const threadId = ctx.sessionKey?.match(/discord:channel:(\d+)/)?.[1];
    if (threadId) {
      if (reply.toLowerCase() === "answer directly") {
        // React to the user's message instead of posting a block
        try {
          const { api: discordApi } = await import("../lib/discord.js");
          // Get the latest message in the thread (the user's message)
          const messages = await discordApi("GET", `/channels/${threadId}/messages?limit=1`, null, logger);
          if (messages?.[0]?.id) {
            await discordApi("PUT", `/channels/${threadId}/messages/${messages[0].id}/reactions/📋/@me`, null, logger);
          }
        } catch {}
      } else {
        // Post housekeeping block
        const webhooks = listMindsets();
        await sendToThread(reply, threadId, webhooks, { header: null, color: 0x2B2D31 }).catch(() => {});
      }
    }

    return `Routing advice: ${reply}`;
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
