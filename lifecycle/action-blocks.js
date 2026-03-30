/**
 * lifecycle/action-blocks.js — Post-turn action block predictions.
 *
 * After each user-triggered agent turn, predict 3-4 likely follow-ups
 * and post them as Discord component buttons. Clicking a button deletes
 * the buttons, posts the selected text as a quote, and sends it via
 * webhook to trigger an agent turn.
 *
 * Buttons survive gateway restarts by persisting component entries to
 * disk and re-registering them on plugin setup.
 *
 * Hooks: message_received (cleanup), agent_end (generate).
 * Interactive handler: namespace "action-blocks".
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { api as discordApi, sendToThread } from "../lib/discord.js";
import { getBotId, loadWebhooks, isMainSession } from "../lib/config.js";

const NAMESPACE = "action-blocks";
const STATE_FILE = join(dirname(new URL(import.meta.url).pathname), "..", ".action-blocks-state.json");

// ─── Component Entry Persistence ─────────────────────────────────────

/** Access the global component entries map (shared with OpenClaw core) */
function getComponentEntriesMap() {
  const key = Symbol.for("openclaw.discord.componentEntries");
  return globalThis[key] || null;
}

/** Save component entries to disk so they survive restarts */
function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

/** Load persisted state from disk */
function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Re-register persisted component entries into the global map */
function restoreComponentEntries(logger) {
  const map = getComponentEntriesMap();
  if (!map) {
    logger.warn("action-blocks: component entries map not available yet");
    return;
  }

  const state = loadState();
  let restored = 0;
  const now = Date.now();
  const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  for (const [channelId, data] of Object.entries(state)) {
    if (!data?.entries) continue;
    // Skip entries older than 24h
    if (data.savedAt && now - data.savedAt > TTL_MS) continue;

    for (const entry of data.entries) {
      // Re-insert with fresh timestamps
      map.set(entry.id, {
        ...entry,
        createdAt: now,
        expiresAt: now + TTL_MS,
      });
      restored++;
    }
  }

  if (restored > 0) {
    logger.info(`action-blocks: restored ${restored} component entries from disk`);
  }
}

// Lazy-loaded from OpenClaw core
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

/** Channels currently generating predictions */
const generating = new Set();

const THREAD_PROMPT = `Predict what the user will say next in this focused work thread. Output ONLY a JSON array of 2-3 objects (vary the count naturally), each with:
- "emoji": a relevant emoji
- "description": what the user would say or want done (30-100 chars, one clear sentence)
- "action": short verb label for the button (max 20 chars)

Be specific to the conversation context — not generic. Mix forward actions and clarifying questions.
If the conversation includes a recent routing/housekeeping recommendation (e.g. close a thread, rename, open new thread), include a button to help act on it.

Example: [{"emoji":"🚀","description":"Push the auth service changes to production and verify health checks","action":"Deploy now"},{"emoji":"🤔","description":"What happens when the API returns a 500?","action":"Investigate"},{"emoji":"🧪","description":"Run the full test suite and show coverage numbers","action":"Run tests"}]`;

const MAIN_PROMPT = `You are predicting what the user might want to do next in their main command channel. This is NOT a focused work thread — it's their home base for orchestrating across mindsets (infra, dev, pa, wordware).

Suggest a mix of:
- Proactive actions they might want (check threads, open something new, review status)
- Vibe checks ("How's everything looking?", "What's stale?")
- Fresh ideas based on what mindsets could help with
- Housekeeping (close old threads, check email, calendar)

Output ONLY a JSON array of 2-3 objects (vary the count naturally), each with:
- "emoji": a relevant emoji
- "description": what the user would say or want done (30-100 chars, one clear sentence)
- "action": short verb label for the button (max 20 chars)

If the conversation includes a recent routing/housekeeping recommendation (e.g. close stale threads, open new thread), include a button to help act on it.

Example: [{"emoji":"📋","description":"Check all active threads across mindsets and see what's stale","action":"Show board"},{"emoji":"📬","description":"Scan for unread emails that need attention today","action":"Check email"}]`;

// ─── Setup ───────────────────────────────────────────────────────────

export function setup(api) {
  const logger = api.logger;
  const runtime = api.runtime;

  // Restore persisted component entries so old buttons still work
  restoreComponentEntries(logger);

  // 1. Cleanup when a new inbound message arrives
  api.on("message_received", async (event, ctx) => {
    if (ctx.channelId !== "discord") return;
    const chId = ctx.conversationId?.replace(/^channel:/, "");
    if (!chId) return;
    // Check in-memory state first, then persisted state (covers post-restart)
    if (blockState.has(chId)) {
      await deleteBlock(chId, logger);
    } else {
      await deletePersistedBlock(chId, logger);
    }
  });

  // 2. Generate action blocks after user-triggered turns
  api.on("agent_end", async (event, ctx) => {
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
      logger.info(`action-blocks: HANDLER FIRED — payload=${ctx.interaction?.payload} conv=${ctx.conversationId}`);
      const rawChId = ctx.conversationId?.replace(/^channel:/, "");

      // Payload is "i=<index>" — resolve full description from persisted state
      let selected = ctx.interaction.payload?.trim() || "continue";
      const indexMatch = selected.match(/^i=(\d+)$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10);
        // Try in-memory state first, then persisted state
        const memEntry = blockState.get(rawChId);
        const persisted = loadState()[rawChId];
        const options = memEntry?.options || persisted?.options;
        if (options && options[idx]?.description) {
          selected = options[idx].description;
        } else {
          selected = "continue";
        }
      }

      logger.info(`action-blocks: selected="${selected}"`);

      try {
        // Delete button message (webhook will be the only visible result)
        const msgId = ctx.interaction?.messageId;
        if (msgId && rawChId) {
          await discordApi("DELETE", `/channels/${rawChId}/messages/${msgId}`, null, logger);
        }
      } catch (e) {
        logger.warn(`action-blocks: delete failed — ${e.message}`);
      }

      // Send via webhook to trigger agent turn
      try {
        const webhooksMap = loadWebhooks();
        // Convert map to array of {webhookUrl} for sendToThread
        const webhooks = webhooksMap ? Object.values(webhooksMap).map((w) => ({
          webhookUrl: `https://discord.com/api/webhooks/${w.webhookId}/${w.webhookToken}`,
        })) : [];

        if (webhooks.length && rawChId) {
          // Send as embed matching thread open/steer style (dark, no accent)
          const sent = await sendToThread(selected, rawChId, webhooks, {
            header: null,
            color: 0x2b2d31,
          });
          logger.info(`action-blocks: webhook sent=${sent} → ${rawChId}`);
        } else {
          logger.warn(`action-blocks: no webhooks for ${rawChId}`);
        }
      } catch (e) {
        logger.warn(`action-blocks: webhook error — ${e.message}`);
      }

      // Clean up in-memory state
      blockState.delete(rawChId);

      // Remove from persisted state
      try {
        const state = loadState();
        if (state[rawChId]) {
          delete state[rawChId];
          saveState(state);
        }
      } catch {}

      return { handled: true };
    },
  });

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
    const options = await predict(ctx, runtime, logger, isMain);
    if (!options?.length) return;

    // Build container card spec with text descriptions + emoji buttons + separators
    const blocks = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const emoji = opt.emoji || "";
      const title = opt.title || opt.label || "Option";
      const description = opt.description || title;
      const action = opt.action || opt.label || "Go";
      // Separator between options (not before first)
      if (i > 0) blocks.push({ type: "separator" });
      // Description only — no title
      blocks.push({ type: "text", text: description });
      // callbackData carries the description for webhook posting
      blocks.push({
        type: "actions",
        buttons: [{
          label: action.slice(0, 30),
          style: "secondary",
          ...(emoji ? { emoji: { name: emoji } } : {}),
          callbackData: `${NAMESPACE}:i=${i}`,
        }],
      });
    }
    const spec = {
      reusable: true,
      container: { accentColor: "#5865F2" },
      blocks,
    };

    const sendFn = await getSendDiscordComponentMessage();
    if (!sendFn) {
      logger.warn("action-blocks: sendDiscordComponentMessage not available");
      return;
    }

    try {
      const result = await sendFn(`channel:${chId}`, spec, {
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });

      if (result?.messageId) {
        blockState.set(chId, { messageId: result.messageId, sessionKey: ctx.sessionKey, options });
        logger.info(`action-blocks: ${options.length} buttons → ${chId}`);

        // Persist component entries for restart survival
        try {
          const map = getComponentEntriesMap();
          if (map) {
            // Find entries we just registered (they'll have our sessionKey)
            const entries = [];
            for (const [id, entry] of map.entries()) {
              if (entry.sessionKey === ctx.sessionKey && entry.callbackData?.startsWith(NAMESPACE + ":")) {
                entries.push({ ...entry, id });
              }
            }

            if (entries.length > 0) {
              const state = loadState();
              state[chId] = {
                entries,
                options,
                sessionKey: ctx.sessionKey,
                messageId: result.messageId,
                savedAt: Date.now(),
              };
              saveState(state);
              logger.info(`action-blocks: persisted ${entries.length} entries for ${chId}`);
            }
          }
        } catch (e) {
          logger.debug(`action-blocks: persist error — ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn(`action-blocks: component send failed — ${e.message}`);
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
        'Output ONLY a JSON array of 2-3 objects with "emoji", "description" (30-100 chars, one sentence), and "action" (short verb, max 20 chars) keys. No markdown fences, no explanation, no preamble.',
    });

    const text = result?.payloads?.[0]?.text?.trim();
    if (!text) return null;

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;

    return arr
      .filter((item) => {
        // Support both old string format and new object format
        if (typeof item === "string") return item.trim().length > 0;
        return item && typeof item === "object" && (item.title || item.label || item.description);
      })
      .map((item) => {
        if (typeof item === "string") {
          // Legacy format: "🚀 Ship it" → parse emoji + title
          const emojiMatch = item.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*/u);
          const text = (emojiMatch ? item.slice(emojiMatch[0].length) : item).trim();
          return {
            emoji: emojiMatch?.[1] || "",
            title: text.slice(0, 30),
            description: text.slice(0, 100),
            action: "Go",
          };
        }
        return {
          emoji: (item.emoji || "").slice(0, 2),
          title: (item.title || item.label || "Option").slice(0, 30),
          description: (item.description || item.title || item.label || "").slice(0, 100),
          action: (item.action || item.label || "Go").slice(0, 20),
        };
      })
      .slice(0, 3);
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
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content))
          text = msg.content.filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
        text = text.trim();
        if (!text || text === "HEARTBEAT_OK" || text === "NO_REPLY" || text.length < 5) continue;
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
  // Also clean persisted state
  try {
    const state = loadState();
    if (state[channelId]) {
      delete state[channelId];
      saveState(state);
    }
  } catch {}
}

/** Delete a block using only persisted state (for post-restart cleanup) */
async function deletePersistedBlock(channelId, logger) {
  const state = loadState();
  const data = state[channelId];
  if (!data?.messageId) return;
  try {
    await discordApi("DELETE", `/channels/${channelId}/messages/${data.messageId}`, null, logger);
    logger.info(`action-blocks: deleted persisted stale block in ${channelId}`);
  } catch (e) {
    logger.debug(`action-blocks: persisted delete — ${e.message}`);
  }
  delete state[channelId];
  saveState(state);
}
