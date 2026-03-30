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
import { getBotId, loadWebhooks } from "../lib/config.js";

const NAMESPACE = "action-blocks";
const CUSTOM_ID = `occomp:cid=${NAMESPACE}`;

/** channelId → { messageId, sessionKey } */
const blockState = new Map();

/** Channels currently generating predictions (prevent concurrent runs) */
const generating = new Set();

const PREDICTION_PROMPT = `Predict what the user will say next. Output ONLY a JSON array of 3-5 short phrases (max 80 chars each). Be specific to the conversation context — not generic. Include a mix of forward actions and clarifying questions.

Example: ["Ship it", "What about error handling?", "Show me the tests", "Try a different approach"]`;

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
    logger.info(`action-blocks: agent_end fired — trigger=${ctx.trigger} channel=${ctx.channelId} session=${ctx.sessionKey?.slice(-20)} success=${event.success}`);
    try {
      await onAgentEnd(event, ctx, runtime, logger);
    } catch (e) {
      logger.warn(`action-blocks: agent_end error — ${e.message}`);
    }
  });

  // 3. Interactive handler: user picks an option
  api.registerInteractiveHandler({
    channel: "discord",
    namespace: NAMESPACE,
    async handler(ctx) {
      const selected = ctx.interaction.values?.[0];
      if (!selected) {
        await ctx.respond.acknowledge();
        return { handled: true };
      }

      const chId = ctx.conversationId;
      const entry = blockState.get(chId);

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
  // Guards with logging
  if (!ctx.sessionKey) { logger.debug("action-blocks: skip — no sessionKey"); return; }
  if (ctx.trigger && ctx.trigger !== "user") { logger.debug(`action-blocks: skip — trigger=${ctx.trigger}`); return; }
  if (ctx.channelId !== "discord") { logger.debug(`action-blocks: skip — channel=${ctx.channelId}`); return; }
  if (!event.success) { logger.debug("action-blocks: skip — not success"); return; }
  if (ctx.sessionId?.startsWith("mindsets-") || ctx.sessionId?.startsWith("action-blocks-")) { logger.debug("action-blocks: skip — fork session"); return; }

  const chId = extractDiscordChannelId(ctx.sessionKey);
  if (!chId) { logger.info(`action-blocks: skip — no channel ID from key=${ctx.sessionKey}`); return; }
  logger.info(`action-blocks: proceeding for channel=${chId} session=${ctx.sessionKey}`);

  // Prevent concurrent generation
  if (generating.has(chId)) return;
  generating.add(chId);

  try {
    // Clean up previous block
    await deleteBlock(chId, logger);

    // Predict follow-ups
    logger.info(`action-blocks: starting prediction…`);
    const options = await predict(ctx, runtime, logger);
    if (!options?.length) {
      logger.info(`action-blocks: no predictions returned`);
      return;
    }

    logger.info(`action-blocks: got ${options.length} predictions: ${JSON.stringify(options)}`);

    // Post select component
    const msg = await discordApi(
      "POST",
      `/channels/${chId}/messages`,
      {
        content: "",
        components: [
          {
            type: 1, // ActionRow
            components: [
              {
                type: 3, // StringSelect
                custom_id: CUSTOM_ID,
                placeholder: "Continue the conversation…",
                min_values: 1,
                max_values: 1,
                options: options.map((text) => ({
                  label: text.slice(0, 100),
                  value: text.slice(0, 100),
                })),
              },
            ],
          },
        ],
      },
      logger,
    );

    if (msg?.id) {
      blockState.set(chId, { messageId: msg.id, sessionKey: ctx.sessionKey });
      logger.info(`action-blocks: posted ${options.length} options → ${chId} msg=${msg.id}`);
    } else {
      logger.warn(`action-blocks: post returned no message id`);
    }
  } catch (e) {
    logger.warn(`action-blocks: post failed — ${e.message}\n${e.stack}`);
  } finally {
    generating.delete(chId);
  }
}

// ─── Prediction ──────────────────────────────────────────────────────

async function predict(ctx, runtime, logger) {
  // 1. Extract last few messages from session file
  let recentMessages;
  try {
    const agentId = ctx.agentId || "main";
    const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
    const storePath = join(home, "agents", agentId, "sessions", "sessions.json");
    logger.info(`action-blocks: reading store — agent=${agentId} path=${storePath}`);
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    const entry = store?.[ctx.sessionKey];
    if (!entry?.sessionFile) {
      logger.info(`action-blocks: no session file for key=${ctx.sessionKey}`);
      return null;
    }
    logger.info(`action-blocks: session file=${entry.sessionFile}`);
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
      prompt: `Recent conversation:\n${context}\n\n${PREDICTION_PROMPT}`,
      disableTools: true,
      timeoutMs: 12_000,
      runId: randomUUID(),
      extraSystemPrompt:
        "Output ONLY a JSON array of predicted user follow-ups. No markdown fences, no explanation, no preamble.",
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
      .map((s) => s.trim().slice(0, 80))
      .slice(0, 5);
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
        if (entry.role !== "user" && entry.role !== "assistant") continue;

        let text = "";
        if (typeof entry.content === "string") {
          text = entry.content;
        } else if (Array.isArray(entry.content)) {
          text = entry.content
            .filter((c) => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
        }

        text = text.trim();
        if (!text || text === "HEARTBEAT_OK" || text === "NO_REPLY") continue;

        msgs.unshift({ role: entry.role, text: text.slice(0, 500) });
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
