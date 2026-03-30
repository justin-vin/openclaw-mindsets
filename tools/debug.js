/**
 * debug — System introspection. Health, zombies, sessions, cost, recovery.
 *
 * Read-only actions: health, zombies, sessions, cost.
 * Write action: recover (requires explicit target).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as discord from "../lib/discord.js";
import { listMindsets, getGuildId, getBotId, getAutoSubscribeIds, loadWebhooks } from "../lib/config.js";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
const AGENTS_DIR = join(OPENCLAW_HOME, "agents");
const DELIVERY_QUEUE = join(OPENCLAW_HOME, "delivery-queue");
const LAUNCH_AGENTS_DIR = `${process.env.HOME}/Library/LaunchAgents`;

const KNOWN_LAUNCH_AGENTS = [
  "ai.openclaw.gateway",
  "ai.openclaw.mac",
  "com.justin.openclaw-backup",
];

const ZOMBIE_NO_RESPONSE_MS = 15 * 60 * 1000;   // 15min
const ZOMBIE_STALE_MS = 2 * 60 * 60 * 1000;      // 2h

// ─── Helpers ─────────────────────────────────────────────────────────

function json(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

/** Safely read and parse a JSON file. Returns null on any error. */
function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** List agent IDs that have a sessions/sessions.json file. */
function listAgentIds() {
  try {
    return readdirSync(AGENTS_DIR).filter(d => {
      try { return existsSync(join(AGENTS_DIR, d, "sessions", "sessions.json")); }
      catch { return false; }
    });
  } catch { return []; }
}

/** Load session store for one agent. Returns {} on error. */
function loadStore(agentId) {
  return safeReadJson(join(AGENTS_DIR, agentId, "sessions", "sessions.json")) || {};
}

// ─── Health checks ───────────────────────────────────────────────────

async function checkConfig(logger) {
  const issues = [];
  const mindsets = listMindsets();

  try {
    const config = safeReadJson(join(OPENCLAW_HOME, "openclaw.json"));
    if (!config) { return { status: "error", issues: ["Cannot read openclaw.json"] }; }

    const agentIds = new Set((config.agents?.list || []).map(a => a?.id).filter(Boolean));

    for (const m of mindsets) {
      if (!agentIds.has(m.name)) {
        issues.push(`Binding '${m.name}' has no agent in agents.list`);
      }
      const ws = join(OPENCLAW_HOME, `workspace-${m.name}`);
      if (!existsSync(ws)) {
        issues.push(`No workspace for '${m.name}'`);
      } else if (!existsSync(join(ws, "SOUL.md")) && !existsSync(join(ws, "IDENTITY.md"))) {
        issues.push(`'${m.name}' missing SOUL.md/IDENTITY.md`);
      }
    }
  } catch (e) {
    issues.push(`Config check error: ${e.message.slice(0, 80)}`);
  }

  return { status: issues.length ? "warn" : "ok", issues: issues.length ? issues : undefined };
}

async function checkWebhooks(logger) {
  const mindsets = listMindsets();
  const results = {};

  for (const m of mindsets) {
    if (!m.webhookUrl) { results[m.name] = "missing"; continue; }
    try {
      // GET webhook info to verify it's still valid
      const res = await fetch(m.webhookUrl);
      results[m.name] = res.ok ? "ok" : `http:${res.status}`;
    } catch (e) {
      results[m.name] = `error:${e.message.slice(0, 50)}`;
    }
  }

  const hasProblems = Object.values(results).some(v => v !== "ok");
  return { status: hasProblems ? "error" : "ok", webhooks: results };
}

async function checkForums(logger) {
  const results = {};
  for (const m of listMindsets()) {
    try {
      await discord.api("GET", `/channels/${m.forumId}`, null, logger);
      results[m.name] = "ok";
    } catch (e) {
      results[m.name] = e.message.substring(0, 80);
    }
  }
  const hasErrors = Object.values(results).some(v => v !== "ok");
  return { status: hasErrors ? "error" : "ok", forums: results };
}

function checkLaunchAgents() {
  const results = {};
  for (const name of KNOWN_LAUNCH_AGENTS) {
    const plist = join(LAUNCH_AGENTS_DIR, `${name}.plist`);
    results[name] = existsSync(plist) ? "installed" : "missing";
  }
  const hasMissing = Object.values(results).some(v => v === "missing");
  return { status: hasMissing ? "warn" : "ok", agents: results };
}

function checkDeliveryQueue() {
  let active = 0;
  let failed = 0;
  const failedErrors = {};

  try {
    if (existsSync(DELIVERY_QUEUE)) {
      active = readdirSync(DELIVERY_QUEUE).filter(f => f.endsWith(".json")).length;
    }
    const failedDir = join(DELIVERY_QUEUE, "failed");
    if (existsSync(failedDir)) {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
      failed = files.length;
      for (const f of files.slice(0, 20)) {
        const item = safeReadJson(join(failedDir, f));
        if (item?.lastError) {
          const err = item.lastError.slice(0, 60) || "unknown";
          failedErrors[err] = (failedErrors[err] || 0) + 1;
        }
      }
    }
  } catch {}

  return {
    status: failed > 0 ? "warn" : active > 5 ? "warn" : "ok",
    active,
    failed,
    failedErrors: Object.keys(failedErrors).length ? failedErrors : undefined,
  };
}

// ─── Tool ────────────────────────────────────────────────────────────

export default function debugTool(api) {
  return {
    name: "debug",
    description: "System introspection. Health, zombies, sessions, cost, recovery.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["health", "zombies", "sessions", "cost", "recover"],
          description: "What to inspect.",
        },
        target: {
          type: "string",
          description: "Optional. Agent ID for sessions, thread ID for recover.",
        },
      },
      required: ["action"],
    },

    async execute(_id, { action, target }) {
      const logger = api.logger;

      // ── health ───────────────────────────────────────────────────
      if (action === "health") {
        const [config, webhooks, forums] = await Promise.all([
          checkConfig(logger),
          checkWebhooks(logger),
          checkForums(logger),
        ]);
        const launchAgents = checkLaunchAgents();
        const deliveryQueue = checkDeliveryQueue();

        const allOk = [config, webhooks, forums, launchAgents, deliveryQueue]
          .every(c => c.status === "ok");

        return json({
          ok: allOk,
          health: { config, webhooks, forums, launchAgents, deliveryQueue },
        });
      }

      // ── zombies ──────────────────────────────────────────────────
      if (action === "zombies") {
        const mindsets = listMindsets();
        const forumMap = new Map(mindsets.map(m => [m.forumId, m.name]));
        const botId = getBotId();
        const { threads } = await discord.listActiveThreads(getGuildId(), logger);
        const forumThreads = (threads || []).filter(t => forumMap.has(t.parent_id));
        const zombies = [];
        const now = Date.now();

        for (const t of forumThreads) {
          if (t.thread_metadata?.archived) continue;

          try {
            const msgs = await discord.api(
              "GET", `/channels/${t.id}/messages?limit=10`, null, logger
            );
            if (!msgs.length) continue;

            const hasBotReply = botId
              ? msgs.some(m => m.author?.id === botId)
              : msgs.some(m => m.author?.bot);
            const firstMsg = msgs[msgs.length - 1];
            const lastMsg = msgs[0];
            const threadAge = now - new Date(firstMsg.timestamp).getTime();
            const lastMsgAge = now - new Date(lastMsg.timestamp).getTime();
            const lastIsBot = botId
              ? lastMsg.author?.id === botId
              : lastMsg.author?.bot;

            // No response — thread opened, bot never replied, >15min
            if (!hasBotReply && threadAge > ZOMBIE_NO_RESPONSE_MS) {
              zombies.push({
                type: "no_response",
                id: t.id,
                title: t.name,
                mindset: forumMap.get(t.parent_id),
                ageMin: Math.round(threadAge / 60000),
                lastAuthor: lastMsg.author?.username,
              });
              continue;
            }

            // Stale — last message from user, no bot reply in >2h
            if (!lastIsBot && lastMsgAge > ZOMBIE_STALE_MS) {
              zombies.push({
                type: "stale",
                id: t.id,
                title: t.name,
                mindset: forumMap.get(t.parent_id),
                lastAuthor: lastMsg.author?.username,
                lastMsgAgeMin: Math.round(lastMsgAge / 60000),
              });
            }
          } catch {}
        }

        return json({ ok: true, zombies, count: zombies.length });
      }

      // ── sessions ─────────────────────────────────────────────────
      if (action === "sessions") {
        const agentIds = target ? [target] : listAgentIds();
        const agents = {};
        let totalSessions = 0;
        let totalCost = 0;
        let orphanedFiles = 0;
        const now = Date.now();

        for (const agentId of agentIds) {
          const store = loadStore(agentId);
          if (!store || typeof store !== "object") {
            agents[agentId] = { error: "Cannot read session store" };
            continue;
          }

          let agentCost = 0;
          const byType = { thread: 0, direct: 0, subagent: 0 };
          const sessions = [];

          for (const [key, entry] of Object.entries(store)) {
            const isSubagent = key.includes(":subagent:");
            const isThread = key.includes(":discord:channel:");
            const type = isSubagent ? "subagent" : isThread ? "thread" : "direct";
            byType[type]++;

            const cost = entry.estimatedCostUsd || 0;
            agentCost += cost;

            const age = entry.updatedAt ? now - entry.updatedAt : null;
            sessions.push({
              key: key.length > 70 ? `…${key.slice(-67)}` : key,
              type,
              updatedAgo: age != null ? `${Math.round(age / 60000)}m` : "?",
              updatedAt: entry.updatedAt || null,
              tokens: entry.totalTokens || 0,
              cost: cost > 0 ? `$${cost.toFixed(4)}` : null,
              model: entry.model || null,
              compactions: entry.compactionCount || 0,
            });
          }

          // Sort by most recently updated
          sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

          totalSessions += sessions.length;
          totalCost += agentCost;

          // Count orphaned files
          try {
            const sessDir = join(AGENTS_DIR, agentId, "sessions");
            const files = readdirSync(sessDir);
            orphanedFiles += files.filter(f =>
              f.includes(".deleted.") || f.includes(".reset.")
            ).length;
          } catch {}

          agents[agentId] = {
            total: sessions.length,
            cost: `$${agentCost.toFixed(4)}`,
            byType,
            recent: sessions.slice(0, 8),
          };
        }

        return json({
          ok: true,
          summary: {
            totalSessions,
            totalCost: `$${totalCost.toFixed(4)}`,
            orphanedFiles,
            agents: agentIds.length,
          },
          agents,
        });
      }

      // ── cost ─────────────────────────────────────────────────────
      if (action === "cost") {
        const agentIds = listAgentIds();
        let totalCost = 0;
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        const perAgent = {};
        const topSessions = [];

        for (const agentId of agentIds) {
          const store = loadStore(agentId);
          let agentCost = 0;
          let agentInput = 0;
          let agentOutput = 0;

          for (const [key, entry] of Object.entries(store)) {
            const cost = entry.estimatedCostUsd || 0;
            agentCost += cost;
            agentInput += entry.inputTokens || 0;
            agentOutput += entry.outputTokens || 0;
            totalCacheRead += entry.cacheRead || 0;
            totalCacheWrite += entry.cacheWrite || 0;

            if (cost > 0.01) {
              topSessions.push({
                key: key.length > 60 ? `…${key.slice(-57)}` : key,
                agent: agentId,
                cost,
                tokens: entry.totalTokens || 0,
                model: entry.model || "unknown",
              });
            }
          }

          totalCost += agentCost;
          totalInput += agentInput;
          totalOutput += agentOutput;

          if (agentCost > 0 || Object.keys(store).length > 0) {
            perAgent[agentId] = {
              cost: `$${agentCost.toFixed(4)}`,
              inputTokens: agentInput,
              outputTokens: agentOutput,
              sessions: Object.keys(store).length,
            };
          }
        }

        // Top 5 most expensive sessions
        topSessions.sort((a, b) => b.cost - a.cost);
        const top5 = topSessions.slice(0, 5).map(s => ({
          ...s,
          cost: `$${s.cost.toFixed(4)}`,
        }));

        return json({
          ok: true,
          total: {
            cost: `$${totalCost.toFixed(4)}`,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheRead: totalCacheRead,
            cacheWrite: totalCacheWrite,
          },
          perAgent,
          topSessions: top5,
        });
      }

      // ── recover ──────────────────────────────────────────────────
      if (action === "recover") {
        return json({
          ok: false,
          error: "recover not yet implemented — use target: thread ID, 'failed-queue', or 'action-blocks'",
          hint: "Coming soon. For now, manually clean ~/.openclaw/delivery-queue/failed/",
        });
      }

      return json({ ok: false, error: `Unknown action: ${action}` });
    },
  };
}
