/**
 * lifecycle/turn.js — Per-turn message analysis + main identity.
 *
 * getMainIdentity(ctx) → static main grounding (prependSystemContext)
 * analyze(event, ctx, api) → per-turn advice (prependContext)
 *
 * Analysis: build ephemeral JSONL from event.messages → runEmbeddedPiAgent → get advice.
 * No visible Discord posts. No session file disk reads. All data comes from the hook event.
 */

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMainSession, listMindsets } from "../lib/config.js";

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

  // Build ephemeral JSONL from event.messages (includes current user message)
  const messages = event?.messages;
  
  // Diagnostic: log what the hook actually receives
  const msgCount = messages?.length ?? 0;
  const roles = messages?.map(m => m.role) ?? [];
  const userMsgs = messages?.filter(m => m.role === "user") ?? [];
  const lastUserPreview = userMsgs.length > 0 
    ? (typeof userMsgs[userMsgs.length - 1].content === "string" 
        ? userMsgs[userMsgs.length - 1].content.slice(0, 80) 
        : "[complex content]")
    : "[none]";
  logger.info(`turn: event.messages count=${msgCount} roles=[${roles.join(",")}] userMsgs=${userMsgs.length} lastUser="${lastUserPreview}" prompt="${(event?.prompt || "").slice(0, 80)}"`);
  
  if (!messages || !messages.length) return null;

  const forkFile = join(tmpdir(), `mindsets-fork-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);

  try {
    const lines = messages
      .map(m => JSON.stringify({ type: "message", message: m }))
      .join("\n") + "\n";
    writeFileSync(forkFile, lines);

    const mindsets = listMindsets();
    const isMain = isMainSession(ctx);

    const prompt = `Analyze the user's last message. Current context: ${isMain ? "main channel" : `thread in #${ctx.agentId}`}.
Available mindsets: ${mindsets.map(m => m.name).join(", ")}.
Reply with a brief recommendation: "answer directly", "open <mindset> '<title>'", "rename '<old>' → '<new>'", or "split into X and Y". One or two lines max.`;

    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `mindsets-analysis-${Date.now()}`,
      sessionFile: forkFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt,
      disableTools: true,
      timeoutMs: 10000,
      runId: randomUUID(),
      extraSystemPrompt: "You are a routing advisor. Reply briefly. No markdown.",
    });

    const reply = result?.payloads?.[0]?.text?.trim();
    if (!reply) return null;

    // Validate output — discard if Pi echoed its own instructions back
    if (looksLikePromptEcho(reply)) {
      logger.warn("turn: analysis returned prompt echo, discarding");
      return null;
    }

    return `Routing advice: ${reply}`;
  } catch (e) {
    logger.warn("turn: analysis failed", { error: e.message });
    return null;
  } finally {
    try { rmSync(forkFile); } catch {}
  }
}

/**
 * Detect if the Pi agent echoed its own prompt/instructions back.
 * Common when the model has no real user content to analyze.
 */
function looksLikePromptEcho(text) {
  const lower = text.toLowerCase();
  const echoSignals = [
    "analyze the user's last message",
    "reply with a brief recommendation",
    "you are a routing advisor",
    "available mindsets:",
    "current context:",
    "one or two lines max",
  ];
  const matches = echoSignals.filter(s => lower.includes(s));
  return matches.length >= 2;
}
