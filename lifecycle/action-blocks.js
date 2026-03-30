/**
 * lifecycle/action-blocks.js — Post-turn action block predictions.
 *
 * After each user-triggered agent turn, extract recent messages, run a
 * lightweight embedded agent to predict 3-4 likely follow-ups, and post
 * them as Discord component buttons via OpenClaw's built-in component
 * system. Buttons use callbackData to route clicks through the plugin's
 * interactive handler, which posts the selected text visibly and injects
 * it into the agent session.
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

// Lazy-loaded from OpenClaw core on first use
let sendDiscordComponentMessage;
let _coreImportAttempted = false;

async function getSendDiscordComponentMessage() {
  if (_coreImportAttempted) return sendDiscordComponentMessage;
  _coreImportAttempted = true;
  try {
    const core = await import("/opt/homebrew/lib/node_modules/openclaw/dist/pi-embedded-BaSvmUpW.js");
    sendDiscordComponentMessage = core.In;
  } catch {}
  return sendDiscordComponentMessage;
}

/** channelId → { messageId, sessionKey, options } */
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

Output ONLY a JSON array of 3-4 short phrases (max 55 chars each). Start each with a relevant emoji. Be specific and useful, not generic.

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
  //    callbackData routes here BEFORE core posts "✓"
  const handlerResult = api.registerInteractiveHandler({
    channel: "discord",
    namespace: NAMESPACE,
    async handler(ctx) {
      logger.info(`action-blocks: HANDLER FIRED — namespace=${ctx.interaction?.namespace} payload=${ctx.interaction?.payload} conv=${ctx.conversationId} keys=${Object.keys(ctx.interaction || {}).join(",")} ctxKeys=${Object.keys(ctx || {}).join(",")}`);
      // conversationId may be "channel:123" or just "123"
      const rawChId = ctx.conversationId?.replace(/^channel:/, "");
      const entry = blockState.get(rawChId);

      // The button label IS the prediction text — get it from the interaction
      // The label is on the interaction's source message component
      let selected = ctx.interaction?.label || null;

      // Fallback: try to get from blockState by index
      if (!selected) {
        const idxMatch = ctx.interaction.payload?.match(/i=(\d+)/);
        if (idxMatch && entry?.options) {
          selected = entry.options[parseInt(idxMatch[1])];
        }
      }
      if (!selected) {
        selected = ctx.interaction.payload || "continue";
      }

      logger.info(`action-blocks: selected="${selected}" hasEntry=${!!entry} sessionKey=${entry?.sessionKey}`);

      // Post the selected text visibly, replacing the button message
      try {
        await ctx.respond.clearComponents({ text: `> ${selected}` });
      } catch (e) {
        logger.warn(`action-blocks: clearComponents failed — ${e.message}`);
        try { await ctx.respond.acknowledge(); } catch {}
      }

      // Inject into session — try blockState first, then build sessionKey from context
      let sessionKey = entry?.sessionKey;
      if (!sessionKey && rawChId) {
        // Reconstruct sessionKey from the agentId binding for this channel
        // The component system passes sessionKey via the spec — check if available
        // For now, use the conversationId to find the right session
        const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
        try {
          // Search all agent session stores for a session matching this channel
          const { readdirSync } = await import("node:fs");
          const agentsDir = join(home, "agents");
          for (const agentId of readdirSync(agentsDir)) {
            const storePath = join(agentsDir, agentId, "sessions", "sessions.json");
            try {
              const store = JSON.parse(readFileSync(storePath, "utf-8"));
              const key = Object.keys(store).find(k => k.endsWith(`:discord:channel:${rawChId}`));
              if (key) { sessionKey = key; break; }
            } catch {}
          }
        } catch {}
      }

      if (sessionKey) {
        runtime.system.enqueueSystemEvent(
          `User tapped action block: "${selected}"\nRespond as if the user typed this directly.`,
          { sessionKey },
        );
        runtime.system.requestHeartbeatNow();
        logger.info(`action-blocks: injected "${selected}" → ${sessionKey}`);
      } else {
        logger.warn(`action-blocks: no sessionKey found for ${rawChId}`);
      }

      blockState.delete(rawChId);
      return { handled: true };
    },
  });
  logger.info(`action-blocks: interactive handler registered — ok=${handlerResult?.ok} error=${handlerResult?.error}`);

  logger.info("action-blocks: setup complete");
}

// ─── agent_end hook ──────────────────────────────────────────────────

async function onAgentEnd(event, ctx, runtime, logger) {
  if (!ctx.sessionKey) return;
  if (ctx.trigger && ctx.trigger !== "user") return;
  if (ctx.channelId !== "discord") return;
  if (!event.success) return;
  if (ctx.sessionId?.startsWith("mindsets-") || ctx.sessionId?.startsWith("action-blocks-")) return;

  const chId = extractDiscordChannelId(ctx.sessionKey);
  if (!chId) return;

  if (generating.has(chId)) return;
  generating.add(chId);

  try {
    await deleteBlock(chId, logger);

    const isMain = !ctx.agentId || ctx.agentId === "main";
    logger.debug(`action-blocks: predicting (${isMain ? "main" : "thread"})`);
    const options = await predict(ctx, runtime, logger, isMain);
    if (!options?.length) return;

    // Build component spec with callbackData pointing to our interactive handler
    // Format: "action-blocks:i=N" — core parses namespace "action-blocks", payload "i=N"
    const spec = {
      reusable: true,
      blocks: options.map((text, i) => ({
        type: "actions",
        buttons: [{
          label: text.slice(0, 60),
          style: "secondary",
          callbackData: `${NAMESPACE}:i=${i}`,
        }],
      })),
    };

    logger.info(`action-blocks: spec callbackData=${spec.blocks?.[0]?.buttons?.[0]?.callbackData}`);
    const sendFn = await getSendDiscordComponentMessage();
    logger.info(`action-blocks: sendFn=${typeof sendFn} name=${sendFn?.name}`);
    if (sendFn) {
      try {
        const result = await sendFn(`channel:${chId}`, spec, {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        if (result?.messageId) {
          blockState.set(chId, { messageId: result.messageId, sessionKey: ctx.sessionKey, options });
          logger.info(`action-blocks: ${options.length} buttons → ${chId}`);
        }
      } catch (e) {
        logger.warn(`action-blocks: component send failed — ${e.message}`);
      }
    } else {
      logger.warn("action-blocks: sendDiscordComponentMessage not available (import failed)");
    }
  } catch (e) {
    logger.warn(`action-blocks: failed — ${e.message}`);
  } finally {
    generating.delete(chId);
  }
}

// ─── Prediction ──────────────────────────────────────────────────────

async function predict(ctx, runtime, logger, isMain = false) {
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

  const context = recentMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");

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
        "Output ONLY a JSON array of 3-4 predicted user follow-ups. Each must start with a relevant emoji and be max 55 chars. No markdown fences, no explanation, no preamble.",
    });

    const text = result?.payloads?.[0]?.text?.trim();
    if (!text) return null;

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      logger.debug(`action-blocks: no JSON — "${text.slice(0, 120)}"`);
      return null;
    }

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;

    return arr
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 55))
      .slice(0, 4);
  } catch (e) {
    logger.debug(`action-blocks: predict failed — ${e.message}`);
    return null;
  } finally {
    try { unlinkSync(tempFile); } catch {}
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
