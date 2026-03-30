/**
 * lifecycle/action-blocks.js — Post-turn action block predictions.
 *
 * After each user-triggered agent turn, extract recent messages, run a
 * lightweight embedded agent to predict 3-5 likely follow-ups, and post
 * them as a Discord select component. Selecting an option injects it as
 * a system event that wakes the agent.
 *
 * Hooks: message_received (cleanup), agent_end (generate).
 * Interactive handler: namespace "action-blocks".
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { api as discordApi } from "../lib/discord.js";
import { getBotId, loadWebhooks, isMainSession } from "../lib/config.js";

const NAMESPACE = "action-blocks";
const CUSTOM_ID = NAMESPACE;

/** channelId → { messageId, sessionKey } */
const blockState = new Map();

/** Channels currently generating predictions (prevent concurrent runs) */
const generating = new Set();

const THREAD_PROMPT = `Predict what the user will say next in this focused work thread. Output ONLY a JSON array of 3-4 short phrases (max 55 chars each). Start each with a relevant emoji. Be specific to the conversation context — not generic. Mix forward actions and clarifying questions.

Example: ["🚀 Ship it", "🤔 What about error handling?", "🧪 Show me the tests", "🔄 Try another approach"]`;

const MAIN_PROMPT = `You are predicting what the user might want to do next in their main command channel. This is NOT a focused work thread — it's their home base for orchestrating across mindsets (infra, dev, pa, wordware).

Suggest a mix of:
- Proactive actions they might want (check threads, open something new, review status)
- Vibe checks ("How's everything looking?", "What's stale?")
- Fresh ideas based on what mindsets could help with
- Housekeeping (close old threads, check email, calendar)

Output ONLY a JSON array of 3-4 short phrases (max 35 chars each). Start each with a relevant emoji. Be specific and useful, not generic.

Example: ["📋 Board status", "🧹 Close stale threads", "📬 Check my inbox", "💡 What should I work on?"]`;

// ─── Setup ───────────────────────────────────────────────────────────

export function setup(api) {
  const logger = api.logger;
  const runtime = api.runtime;

  // 1. Immediate cleanup when a new inbound message arrives
  api.on("message_received", async (event, ctx) => {
    if (ctx.channelId !== "discord") return;
    const chId = ctx.conversationId;
    if (!chId || !blockState.has(chId)) return;

    logger.debug(`action-blocks: message_received cleanup for ${chId}`);
    await deleteBlock(chId, logger);
  });

  // 2. Generate action blocks after user-triggered turns
  api.on("agent_end", async (event, ctx) => {
    logger.debug(`action-blocks: agent_end — trigger=${ctx.trigger} channel=${ctx.channelId} success=${event.success}`);
    try {
      await onAgentEnd(event, ctx, runtime, logger);
    } catch (e) {
      logger.warn(`action-blocks: agent_end error — ${e.message}`);
    }
  });

  // 3. Interactive handler: user picks a button
  api.registerInteractiveHandler({
    channel: "discord",
    namespace: NAMESPACE,
    async handler(ctx) {
      // Button payload is in ctx.interaction.data (the custom_id suffix)
      // The button label IS the prediction text
      const chId = ctx.conversationId;
      const entry = blockState.get(chId);

      // Extract selected text from the button label via the message components
      let selected = null;
      // Parse index from payload: "i=0", "i=1", etc.
      const idxMatch = ctx.interaction.payload?.match(/i=(\d+)/);
      if (idxMatch && entry?.options) {
        selected = entry.options[parseInt(idxMatch[1])];
      }

      if (!selected) {
        // Fallback: use the payload directly
        selected = ctx.interaction.payload || "continue";
      }

      // Replace component with the selected text
      try {
        await ctx.respond.clearComponents({ text: `> ${selected}` });
      } catch {
        try {
          await ctx.respond.acknowledge();
        } catch {}
      }

      // Inject into session
      if (entry?.sessionKey) {
        runtime.system.enqueueSystemEvent(
          `User tapped action block: "${selected}"\nRespond as if the user typed this directly.`,
          { sessionKey: entry.sessionKey },
        );
        runtime.system.requestHeartbeatNow();
        logger.info(`action-blocks: injected "${selected}" → ${entry.sessionKey}`);
      } else {
        logger.warn(`action-blocks: no session key for channel ${chId}`);
      }

      blockState.delete(chId);
      return { handled: true };
    },
  });

  logger.info("action-blocks: setup complete");
}

// ─── agent_end hook ──────────────────────────────────────────────────

async function onAgentEnd(event, ctx, runtime, logger) {
  // Guards
  if (!ctx.sessionKey) return;
  if (ctx.trigger && ctx.trigger !== "user") return;
  if (ctx.channelId !== "discord") return;
  if (!event.success) return;
  if (ctx.sessionId?.startsWith("mindsets-") || ctx.sessionId?.startsWith("action-blocks-")) return;

  const chId = extractDiscordChannelId(ctx.sessionKey);
  if (!chId) return;

  // Prevent concurrent generation
  if (generating.has(chId)) return;
  generating.add(chId);

  try {
    // Clean up previous block
    await deleteBlock(chId, logger);

    // Predict follow-ups
    const isMain = !ctx.agentId || ctx.agentId === "main";
    logger.debug(`action-blocks: predicting (${isMain ? "main" : "thread"})`);
    const options = await predict(ctx, runtime, logger, isMain);
    if (!options?.length) return;

    // Post as inline buttons — 1 per row for mobile readability (labels wrap to 2 lines)
    const buttons = options.map((text, i) => ({
      type: 2, // Button
      style: 2, // Secondary (grey)
      label: text.slice(0, 60),
      custom_id: `${CUSTOM_ID}:i=${i}`,
    }));

    // 1 button per row — full width, allows label text to wrap on mobile
    const rows = buttons.map((btn) => ({ type: 1, components: [btn] }));

    const msg = await discordApi(
      "POST",
      `/channels/${chId}/messages`,
      { content: "", components: rows },
      logger,
    );

    if (msg?.id) {
      blockState.set(chId, { messageId: msg.id, sessionKey: ctx.sessionKey, options });
      logger.info(`action-blocks: ${options.length} buttons → ${chId}`);
    }
  } catch (e) {
    logger.warn(`action-blocks: failed — ${e.message}`);
  } finally {
    generating.delete(chId);
  }
}

// ─── Prediction ──────────────────────────────────────────────────────

async function predict(ctx, runtime, logger, isMain = false) {
  // 1. Extract last few messages from session file
  let recentMessages;
  try {
    const agentId = ctx.agentId || "main";
    const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
    const storePath = join(home, "agents", agentId, "sessions", "sessions.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    const entry = store?.[ctx.sessionKey];
    if (!entry?.sessionFile) return null;
    recentMessages = extractRecentMessages(entry.sessionFile, 6);
  } catch (e) {
    logger.warn(`action-blocks: session read — ${e.message}`);
    return null;
  }

  if (!recentMessages.length) return null;

  // 2. Build conversation context string
  const context = recentMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");

  // 3. Run embedded agent with a fresh (empty) session — avoids replaying
  //    entire conversation history and keeps cost low.
  const tempFile = join(tmpdir(), `action-blocks-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);
  writeFileSync(tempFile, "");

  try {
    const result = await runtime.agent.runEmbeddedPiAgent({
      sessionId: `action-blocks-${Date.now()}`,
      sessionFile: tempFile,
      workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(ctx.agentId || "main"),
      prompt: `Recent conversation:\n${context}\n\n${isMain ? MAIN_PROMPT : THREAD_PROMPT}`,
      disableTools: true,
      timeoutMs: 12_000,
      runId: randomUUID(),
      extraSystemPrompt:
        "Output ONLY a JSON array of 3-4 predicted user follow-ups. Each must start with a relevant emoji and be max 35 chars. No markdown fences, no explanation, no preamble.",
    });

    const text = result?.payloads?.[0]?.text?.trim();
    if (!text) return null;

    // Extract JSON array from response (model may wrap in markdown)
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      logger.debug(`action-blocks: no JSON — "${text.slice(0, 120)}"`);
      return null;
    }

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;

    return arr
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 35))
      .slice(0, 4);
  } catch (e) {
    logger.debug(`action-blocks: predict failed — ${e.message}`);
    return null;
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {}
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractRecentMessages(sessionFile, count) {
  try {
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const msgs = [];

    for (let i = lines.length - 1; i >= 0 && msgs.length < count; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // Session files use {type:"message", message:{role,content}} wrappers
        const msg = entry.message || entry;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
        }

        text = text.trim();
        if (!text || text === "HEARTBEAT_OK" || text === "NO_REPLY") continue;
        // Skip tool-only messages (no readable text)
        if (text.length < 5) continue;

        msgs.unshift({ role: msg.role, text: text.slice(0, 500) });
      } catch {}
    }

    return msgs;
  } catch {
    return [];
  }
}

function extractDiscordChannelId(sessionKey) {
  const m = sessionKey?.match(/:discord:channel:(\d+)$/);
  return m?.[1] || null;
}

async function deleteBlock(channelId, logger) {
  const entry = blockState.get(channelId);
  if (!entry?.messageId) return;

  try {
    await discordApi("DELETE", `/channels/${channelId}/messages/${entry.messageId}`, null, logger);
  } catch (e) {
    logger.debug(`action-blocks: delete — ${e.message}`);
  }
  blockState.delete(channelId);
}
