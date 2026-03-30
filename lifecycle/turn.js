/**
 * lifecycle/turn.js — Per-turn message analysis + main identity.
 *
 * getMainIdentity(ctx) → static main grounding (prependSystemContext)
 * analyze(event, ctx, api) → routing advice (prependContext)
 *
 * Analysis: fork session JSONL → runEmbeddedPiAgent → get advice → post visible block.
 */

import { randomUUID } from "node:crypto";
import { cpSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMainSession, listMindsets } from "../lib/config.js";
import * as discord from "../lib/discord.js";

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
- \`open(mindset, title, prompt)\` — new thread
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
  

  try {
    const sessionFile = findSessionFile(ctx);
    if (!sessionFile) return null;

    const forkFile = join(tmpdir(), `mindsets-fork-${Date.now()}.jsonl`);
    cpSync(sessionFile, forkFile);

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

    try { rmSync(forkFile); } catch {}

    const reply = result?.payloads?.[0]?.text;
    if (!reply) return null;

    // Post visible analysis in Discord
    const threadId = ctx.sessionKey?.match(/discord:channel:(\d+)/)?.[1];
    if (threadId) {
      try { await discord.sendMessage(threadId, `📋 **Analysis:** ${reply}`, logger); }
      catch {}
    }

    return `Routing advice: ${reply}`;
  } catch (e) {
    logger.warn("turn: analysis failed", { error: e.message });
    return null;
  }
}

function findSessionFile(ctx) {
  if (!ctx.sessionKey) return null;
  const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
  try {
    for (const agent of readdirSync(join(home, "agents"))) {
      const store = join(home, "agents", agent, "sessions", "sessions.json");
      if (!existsSync(store)) continue;
      const entry = JSON.parse(readFileSync(store, "utf-8"))[ctx.sessionKey];
      if (entry?.sessionFile && existsSync(entry.sessionFile)) return entry.sessionFile;
    }
  } catch {}
  return null;
}
