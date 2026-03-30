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

  // Guard: skip if the inbound is a routing block we posted (prevents loop)
  const promptText = event?.prompt || "";
  if (promptText.includes("📋") && /📋\s*(answer directly|open |rename |split into)/.test(promptText)) return null;

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

  const prompt = `ROUTING ANALYSIS ONLY. Do not respond to the conversation. Do not help. Do not answer questions.

Context: ${isMain ? "main channel" : `thread in #${ctx.agentId}`}.
Mindsets: ${mindsets.map(m => m.name).join(", ")}.

Based on the user's last message, reply with EXACTLY ONE of:
- "answer directly" (message is in scope for current context)
- "open <mindset> '<title>'" (needs a new thread)
- "rename '<new title>'" (thread title should change)
- "split into '<title1>' and '<title2>'" (conversation diverged)

One line only. No explanation. No markdown. No conversation.`;

  try {
    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `mindsets-analysis-${Date.now()}`,
      sessionFile: branchedFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt,
      disableTools: true,
      timeoutMs: 15000,
      runId: randomUUID(),
      extraSystemPrompt: "You are a silent routing classifier. Your ONLY job is to output a routing decision. Never respond to the conversation content. Never help. Never answer questions. Output exactly one routing decision line.",
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
      const webhooks = listMindsets();
      await sendToThread(`📋 ${reply}`, threadId, webhooks, { header: null, color: 0x2B2D31 }).catch(() => {});
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
