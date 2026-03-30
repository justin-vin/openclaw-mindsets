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

  // Guard: skip if this is the Pi analysis agent's own embedded run (recursive hook call).
  // The analysis session uses a distinctive sessionId prefix.
  if (ctx.sessionId?.startsWith("mindsets-analysis-")) return null;

  // Extract ONLY the current user message for routing classification.
  // Full conversation context causes Opus to engage with the content instead of classifying.
  const currentPrompt = event?.prompt;
  if (!currentPrompt) return null;
  
  // Extract plain text from the prompt (strip metadata/envelope if present)
  const userText = extractUserText(currentPrompt);
  if (!userText || userText.length < 5) return null;
  
  // Build minimal JSONL with just this one user message
  const recentMessages = [{ role: "user", content: userText }];
  
  logger.debug(`turn: classifying message (${userText.length} chars): "${userText.slice(0, 60)}"`);

  const forkFile = join(tmpdir(), `mindsets-fork-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);

  try {
    // Build proper session JSONL with header + message entries
    const now = new Date().toISOString();
    const sessionHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: now,
      cwd: "/"
    });

    let parentId = null;
    const msgLines = recentMessages.map(m => {
      const id = randomUUID().slice(0, 8);
      const entry = JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: now,
        message: m
      });
      parentId = id;
      return entry;
    });

    const jsonl = [sessionHeader, ...msgLines].join("\n") + "\n";
    writeFileSync(forkFile, jsonl);

    logger.debug(`turn: JSONL written entries=${msgLines.length + 1} messages=${recentMessages.length}`);

    const mindsets = listMindsets();
    const isMain = isMainSession(ctx);

    const prompt = `ROUTING ANALYSIS ONLY. Do not respond to the conversation. Do not help. Do not answer questions.

Context: ${isMain ? "main channel" : `thread in #${ctx.agentId}`}.
Mindsets: ${mindsets.map(m => m.name).join(", ")}.

Based on the user's last message above, reply with EXACTLY ONE of:
- "answer directly" (message is in scope for current context)
- "open <mindset> '<title>'" (needs a new thread)
- "rename '<new title>'" (thread title should change)
- "split into '<title1>' and '<title2>'" (conversation diverged)

One line only. No explanation. No markdown. No conversation.`;

    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `mindsets-analysis-${Date.now()}`,
      sessionFile: forkFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt,
      disableTools: true,
      timeoutMs: 10000,
      runId: randomUUID(),
      extraSystemPrompt: "You are a silent routing classifier. Your ONLY job is to output a routing decision. Never respond to the conversation content. Never help. Never answer questions. Output exactly one routing decision line.",
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
 * Extract the actual user message text from OpenClaw's prompt,
 * stripping envelope metadata, conversation info blocks, etc.
 */
function extractUserText(prompt) {
  if (!prompt) return null;
  
  // Look for the actual message content after the UNTRUSTED blocks
  // OpenClaw wraps messages in <<<EXTERNAL_UNTRUSTED_CONTENT>>> blocks
  const untrustedMatch = prompt.match(/UNTRUSTED Discord message body\n([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT/);
  if (untrustedMatch) {
    const text = untrustedMatch[1].trim();
    // Skip media-only messages
    if (text === "<media:document> (1 file)") return null;
    return text || null;
  }
  
  // Look for "User text:" transcription blocks (voice messages)
  const transcriptMatch = prompt.match(/Transcript:\n[\s\S]*?\n(\[[\d:.]+\s*-->\s*[\d:.]+\]\s*.+)/);
  if (transcriptMatch) {
    // Extract all transcript lines
    const lines = prompt.match(/\[\d+:\d+\.\d+\s*-->\s*\d+:\d+\.\d+\]\s*(.+)/g);
    if (lines) {
      return lines.map(l => l.replace(/\[\d+:\d+\.\d+\s*-->\s*\d+:\d+\.\d+\]\s*/, "")).join(" ");
    }
  }
  
  // Fallback: if no envelope found, use the raw prompt but skip metadata blocks
  const stripped = prompt
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\n/g, "")
    .replace(/Sender \(untrusted metadata\):[\s\S]*?```\n/g, "")
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/Untrusted context[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/Routing advice:[\s\S]*?\n\n/g, "")
    .trim();
  
  return stripped || null;
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
