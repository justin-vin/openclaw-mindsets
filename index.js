/**
 * openclaw-mindsets — Multiple AI mindsets, one identity.
 *
 * Layer 1: Debug tools (_ms_*) — granular atomic reads, undocumented
 * Layer 2: Agent tools (mindset_*) — semantic composed operations
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OPENCLAW_HOME = "/Users/justin/.openclaw";
const AGENTS_DIR = join(OPENCLAW_HOME, "agents");
const THREAD_BINDINGS_PATH = join(OPENCLAW_HOME, "discord", "thread-bindings.json");

// ── Primitives ─────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(readFileSync(join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
}

function loadThreadBindings() {
  try { return JSON.parse(readFileSync(THREAD_BINDINGS_PATH, "utf-8")); }
  catch { return { version: 1, bindings: {} }; }
}

function listAgentIds() {
  try {
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

function readStore(agentId) {
  const p = join(AGENTS_DIR, agentId, "sessions", "sessions.json");
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch { return {}; }
}

function getForumBindings() {
  const config = loadConfig();
  const result = {};
  for (const b of (config.bindings || [])) {
    const peer = b.match?.peer;
    if (peer?.kind === "channel" && b.agentId) {
      result[b.agentId] = peer.id;
      result[`forum:${peer.id}`] = b.agentId; // reverse lookup
    }
  }
  return result;
}

function allSessions() {
  const result = [];
  for (const agentId of listAgentIds()) {
    const store = readStore(agentId);
    for (const [key, entry] of Object.entries(store)) {
      result.push({ agentId, key, ...entry });
    }
  }
  return result;
}

function classifySession(key, entry) {
  if (key.endsWith(":main")) return "main";
  if (key.includes(":subagent:")) return "subagent";
  if (key.includes(":cron:")) return "cron";
  if (key.includes(":discord:channel:")) return "discord-thread";
  if (key.includes(":discord:")) return "discord-other";
  return "other";
}

function timeAgo(ts) {
  if (!ts) return "unknown";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatSession(key, v, agentId) {
  const kind = classifySession(key, v);
  const base = {
    key,
    agent: agentId,
    kind,
    status: v.status || "unknown",
    totalTokens: v.totalTokens || 0,
    model: v.model || null,
    updatedAt: v.updatedAt || 0,
    updatedAgo: timeAgo(v.updatedAt),
  };

  // Anomaly flags
  const flags = [];
  if (v.abortedLastRun) flags.push("aborted");
  if (v.status === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 2 * 60 * 60 * 1000) flags.push("zombie");
  if (v.status === "unknown") flags.push("never-ran");
  if (kind === "discord-thread") {
    const dc = v.deliveryContext || {};
    if (dc.channel === "webchat") flags.push("webchat-delivery");
    if (dc.channel !== "discord" || !dc.to) flags.push("no-discord-delivery");
    if (!v.origin) flags.push("no-origin");
    if ((v.totalTokens || 0) === 0 && v.status !== "running") flags.push("empty");
  }
  if (flags.length) base.flags = flags;

  if (kind === "discord-thread") {
    const threadId = key.split("discord:channel:")[1]?.split(":")[0];
    base.threadId = threadId;
    base.deliveryContext = v.deliveryContext || null;
    base.hasDiscordDelivery = v.deliveryContext?.channel === "discord" && !!v.deliveryContext?.to;
    base.origin = typeof v.origin === "object" ? v.origin.label : (v.origin || null);
  }
  if (kind === "subagent") {
    base.spawnedBy = v.spawnedBy || null;
    base.subagentRole = v.subagentRole || null;
    base.label = v.label || null;
    base.spawnDepth = v.spawnDepth || null;
  }
  if (kind === "cron") {
    base.label = v.label || null;
  }
  return base;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── Plugin ─────────────────────────────────────────────────────────

export default {
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple AI mindsets, one identity.",
  register(api) {
    const runtime = api.runtime;
    const logger = api.logger;
    logger.info("openclaw-mindsets: registering");

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  LAYER 1: Debug tools (_ms_*)                              ║
    // ╚══════════════════════════════════════════════════════════════╝

    // ─── _ms_list_agents ───────────────────────────────────────────
    api.registerTool({
      name: "_ms_list_agents",
      description: "[debug] List all agent IDs on disk with session counts.",
      parameters: { type: "object", properties: {} },
      async execute(_id) {
        const fb = getForumBindings();
        const agents = listAgentIds().map(id => {
          const store = readStore(id);
          const keys = Object.keys(store);
          const byKind = {};
          for (const k of keys) {
            const kind = classifySession(k, store[k]);
            byKind[kind] = (byKind[kind] || 0) + 1;
          }
          const active = keys.filter(k => {
            const s = store[k].status;
            return s === "running" || s === "idle";
          });
          return {
            id,
            forumChannelId: fb[id] || null,
            totalSessions: keys.length,
            activeSessions: active.length,
            byKind,
          };
        });
        return ok({ agents, timestamp: new Date().toISOString() });
      },
    });

    // ─── _ms_read_store ────────────────────────────────────────────
    api.registerTool({
      name: "_ms_read_store",
      description: "[debug] Read session store for one agent. Filter by channel type.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID (e.g. 'sysadmin')" },
          filter: { type: "string", description: "Filter: 'all', 'discord', 'active'. Default: 'discord'" },
        },
        required: ["agentId"],
      },
      async execute(_id, params) {
        const { agentId, filter = "discord" } = params;
        const store = readStore(agentId);
        const entries = Object.entries(store);

        let filtered;
        if (filter === "all") filtered = entries;
        else if (filter === "active") filtered = entries.filter(([, v]) => v.status === "running" || v.status === "idle");
        else filtered = entries.filter(([k]) => k.includes("discord"));

        const sessions = filtered.map(([key, v]) => formatSession(key, v, agentId));
        // Sort: running first, then by updatedAt desc
        sessions.sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

        // Summary
        const flagged = sessions.filter(s => s.flags?.length > 0);
        const summary = {
          total: sessions.length,
          running: sessions.filter(s => s.status === "running").length,
          done: sessions.filter(s => s.status === "done").length,
          idle: sessions.filter(s => s.status === "idle").length,
          unknown: sessions.filter(s => s.status === "unknown").length,
          flagged: flagged.length,
          flags: flagged.length > 0 ? Object.fromEntries(
            [...new Set(flagged.flatMap(s => s.flags || []))].map(f => [f, flagged.filter(s => s.flags?.includes(f)).length])
          ) : {},
        };

        return ok({ agentId, filter, summary, sessions, timestamp: new Date().toISOString() });
      },
    });

    // ─── _ms_get_session ───────────────────────────────────────────
    api.registerTool({
      name: "_ms_get_session",
      description: "[debug] Get full session metadata by key. Searches all agents if agentId not specified.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Full session key (e.g. 'agent:sysadmin:discord:channel:12345')" },
          agentId: { type: "string", description: "Agent ID to search. If omitted, searches all agents." },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        const { sessionKey, agentId } = params;
        const agents = agentId ? [agentId] : listAgentIds();

        for (const aid of agents) {
          const store = readStore(aid);
          if (store[sessionKey]) {
            const v = store[sessionKey];
            const tb = loadThreadBindings();
            const threadId = sessionKey.split("discord:channel:")[1]?.split(":")[0];
            const isFocused = threadId ? !!tb.bindings?.[threadId] : false;
            const focusTarget = threadId ? (tb.bindings?.[threadId]?.sessionKey || null) : null;

            return ok({
              found: true,
              agentId: aid,
              sessionKey,
              kind: classifySession(sessionKey, v),
              sessionId: v.sessionId,
              status: v.status || "unknown",
              deliveryContext: v.deliveryContext || null,
              hasDiscordDelivery: v.deliveryContext?.channel === "discord" && !!v.deliveryContext?.to,
              channel: v.channel,
              chatType: v.chatType,
              // Thread binding state
              threadId: threadId || null,
              isFocused,
              focusTarget,
              // Usage
              totalTokens: v.totalTokens || 0,
              inputTokens: v.inputTokens || 0,
              outputTokens: v.outputTokens || 0,
              cacheRead: v.cacheRead || 0,
              estimatedCostUsd: v.estimatedCostUsd || 0,
              model: v.model,
              modelProvider: v.modelProvider,
              // Lifecycle
              updatedAt: v.updatedAt,
              updatedAgo: timeAgo(v.updatedAt),
              startedAt: v.startedAt,
              endedAt: v.endedAt,
              runtimeMs: v.runtimeMs,
              compactionCount: v.compactionCount || 0,
              abortedLastRun: v.abortedLastRun || false,
              // Lineage
              spawnedBy: v.spawnedBy || null,
              subagentRole: v.subagentRole || null,
              spawnDepth: v.spawnDepth || null,
              label: v.label || null,
              // Identity
              origin: v.origin || null,
              lastChannel: v.lastChannel,
              lastTo: v.lastTo,
              sessionFile: v.sessionFile,
              skillsSnapshot: v.skillsSnapshot ? (typeof v.skillsSnapshot === "object" && !Array.isArray(v.skillsSnapshot) ? Object.keys(v.skillsSnapshot) : v.skillsSnapshot) : [],
            });
          }
        }
        return ok({ found: false, sessionKey, searchedAgents: agents });
      },
    });

    // ─── _ms_list_bindings ─────────────────────────────────────────
    api.registerTool({
      name: "_ms_list_bindings",
      description: "[debug] List all forum↔agent bindings from OpenClaw config.",
      parameters: { type: "object", properties: {} },
      async execute(_id) {
        const config = loadConfig();
        const bindings = (config.bindings || [])
          .filter(b => b.match?.peer?.kind === "channel")
          .map(b => ({
            agentId: b.agentId,
            forumChannelId: b.match.peer.id,
            channel: b.match.channel,
          }));

        // Also include thread bindings (focused threads)
        const tb = loadThreadBindings();
        const threadBindings = Object.entries(tb.bindings || {}).map(([threadId, binding]) => ({
          threadId,
          ...binding,
        }));

        // Also check guild config
        const guilds = config.channels?.discord?.guilds || {};
        const guildInfo = Object.entries(guilds).map(([guildId, g]) => ({
          guildId,
          requireMention: g.requireMention,
          users: g.users,
          channelCount: Object.keys(g.channels || {}).length,
          channels: Object.entries(g.channels || {}).map(([chId, ch]) => ({
            id: chId,
            allow: ch.allow,
            includeThreadStarter: ch.includeThreadStarter,
          })),
        }));

        return ok({
          forumBindings: bindings,
          threadBindings,
          threadBindingsVersion: tb.version,
          guilds: guildInfo,
          timestamp: new Date().toISOString(),
        });
      },
    });

    // ─── _ms_find_thread_sessions ──────────────────────────────────
    api.registerTool({
      name: "_ms_find_thread_sessions",
      description: "[debug] Find all sessions across all agents that match a Discord thread ID.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID to search for" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId } = params;
        const matches = [];

        for (const agentId of listAgentIds()) {
          const store = readStore(agentId);
          for (const [key, v] of Object.entries(store)) {
            if (key.includes(threadId) ||
                v.deliveryContext?.threadId === threadId ||
                v.deliveryContext?.to === `channel:${threadId}`) {
              matches.push(formatSession(key, v, agentId));
            }
          }
        }

        // Check thread binding state
        const tb = loadThreadBindings();
        const focused = tb.bindings?.[threadId] || null;

        // Check if the thread ID is a known forum channel (not a thread)
        const fb = getForumBindings();
        const isForumChannel = !!fb[`forum:${threadId}`];

        // Detect anomalies
        const anomalies = [];
        const agentSet = new Set(matches.map(m => m.agent));
        if (agentSet.size > 1) anomalies.push(`multi-agent: sessions in ${[...agentSet].join(", ")}`);
        const webchat = matches.filter(m => m.deliveryContext?.channel === "webchat");
        if (webchat.length) anomalies.push(`webchat-delivery: ${webchat.length} session(s) with webchat instead of discord`);
        const noDelivery = matches.filter(m => !m.hasDiscordDelivery);
        if (noDelivery.length) anomalies.push(`no-discord-delivery: ${noDelivery.length} session(s) missing discord delivery`);

        return ok({
          threadId,
          isForumChannel,
          forumAgent: isForumChannel ? fb[`forum:${threadId}`] : null,
          matchCount: matches.length,
          anomalies: anomalies.length > 0 ? anomalies : null,
          sessions: matches,
          focused: focused ? { ...focused } : null,
          timestamp: new Date().toISOString(),
        });
      },
    });

    // ─── _ms_health ─────────────────────────────────────────────────
    // Cross-agent health check — everything wrong in one call
    api.registerTool({
      name: "_ms_health",
      description: "[debug] Cross-agent health check. Shows zombies, orphans, broken delivery, missing transcripts, cost summary.",
      parameters: { type: "object", properties: {} },
      async execute(_id) {
        const fb = getForumBindings();
        const agents = listAgentIds();
        const issues = [];
        const costByAgent = {};
        const sessionStats = { total: 0, running: 0, done: 0, idle: 0, unknown: 0, flagged: 0 };
        const threadSessionMap = {}; // threadId -> [sessions]

        for (const agentId of agents) {
          const store = readStore(agentId);
          let agentCost = 0;

          for (const [key, v] of Object.entries(store)) {
            sessionStats.total++;
            const s = v.status || "unknown";
            if (s in sessionStats) sessionStats[s]++;

            agentCost += v.estimatedCostUsd || 0;

            // Zombie detection
            if (s === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 2 * 60 * 60 * 1000) {
              issues.push({ type: "zombie", agentId, key, updatedAgo: timeAgo(v.updatedAt) });
              sessionStats.flagged++;
            }

            // Broken delivery on discord threads
            if (key.includes("discord:channel:")) {
              const dc = v.deliveryContext || {};
              const threadId = key.split("discord:channel:")[1]?.split(":")[0];

              // Track thread -> session mapping
              if (threadId) {
                if (!threadSessionMap[threadId]) threadSessionMap[threadId] = [];
                threadSessionMap[threadId].push({ agentId, key, status: s });
              }

              if (dc.channel === "webchat") {
                issues.push({ type: "webchat-delivery", agentId, key, threadId });
                sessionStats.flagged++;
              } else if (dc.channel !== "discord" || !dc.to) {
                issues.push({ type: "no-discord-delivery", agentId, key, threadId });
                sessionStats.flagged++;
              }

              // Empty session (created but never ran)
              if ((v.totalTokens || 0) === 0 && s !== "running" && !v.origin) {
                issues.push({ type: "orphan-session", agentId, key, threadId, reason: "no tokens, no origin" });
                sessionStats.flagged++;
              }

              // Aborted
              if (v.abortedLastRun) {
                issues.push({ type: "aborted", agentId, key, threadId });
                sessionStats.flagged++;
              }

              // Transcript file missing
              if (v.sessionFile) {
                try { readFileSync(v.sessionFile, "utf-8"); }
                catch {
                  issues.push({ type: "missing-transcript", agentId, key, file: v.sessionFile });
                  sessionStats.flagged++;
                }
              }
            }

            // Stale cron sessions
            if (key.includes(":cron:") && !key.includes(":run:")) {
              if (s === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 30 * 60 * 1000) {
                issues.push({ type: "stale-cron", agentId, key, label: v.label, updatedAgo: timeAgo(v.updatedAt) });
              }
            }
          }

          costByAgent[agentId] = Math.round(agentCost * 1000) / 1000;
        }

        // Multi-agent conflicts (same thread, multiple agents)
        for (const [threadId, sessions] of Object.entries(threadSessionMap)) {
          const uniqueAgents = new Set(sessions.map(s => s.agentId));
          if (uniqueAgents.size > 1) {
            issues.push({ type: "binding-conflict", threadId, agents: [...uniqueAgents], sessions: sessions.length });
          }
        }

        // Thread bindings state
        const tb = loadThreadBindings();
        const focusedCount = Object.keys(tb.bindings || {}).length;

        const totalCost = Object.values(costByAgent).reduce((a, b) => a + b, 0);

        return ok({
          timestamp: new Date().toISOString(),
          sessionStats,
          cost: { total: Math.round(totalCost * 1000) / 1000, byAgent: costByAgent },
          focusedThreads: focusedCount,
          issueCount: issues.length,
          issues: issues.length > 0 ? issues : "all clear",
          forumBindings: Object.entries(fb).filter(([k]) => !k.startsWith("forum:")).map(([agent, forum]) => ({ agent, forum })),
        });
      },
    });

    // ─── _ms_transcript ───────────────────────────────────────────
    // Read last N messages from a session's JSONL transcript file
    api.registerTool({
      name: "_ms_transcript",
      description: "[debug] Read last N messages from a session's transcript file. Shows what the agent actually said.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to read transcript for" },
          limit: { type: "number", description: "Max messages to return (default 10, max 50)" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all agents." },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        const { sessionKey, limit: rawLimit = 10, agentId } = params;
        const limit = Math.min(Math.max(rawLimit || 10, 1), 50);
        const agents = agentId ? [agentId] : listAgentIds();

        for (const aid of agents) {
          const store = readStore(aid);
          const entry = store[sessionKey];
          if (!entry?.sessionFile) continue;

          try {
            const raw = readFileSync(entry.sessionFile, "utf-8");
            const lines = raw.trim().split("\n").filter(l => l.trim());
            const messages = [];

            // Parse JSONL — last N lines
            const start = Math.max(0, lines.length - limit);
            for (let i = start; i < lines.length; i++) {
              try {
                const envelope = JSON.parse(lines[i]);
                // OpenClaw JSONL: { type, id, parentId, timestamp, message? | data? }
                const envType = envelope.type;
                const ts = envelope.timestamp ? new Date(envelope.timestamp).toISOString() : null;

                // Skip non-message envelopes (custom, header, etc.)
                if (envType !== "message") continue;

                const msg = envelope.message || {};
                const role = msg.role;
                if (!role) continue;

                const simplified = { role, timestamp: ts };

                const content = msg.content;
                if (role === "user" || role === "system") {
                  if (typeof content === "string") {
                    simplified.text = content.substring(0, 500);
                  } else if (Array.isArray(content)) {
                    simplified.text = content.map(c => c.text || `[${c.type}]`).join(" ").substring(0, 500);
                  }
                } else if (role === "assistant") {
                  if (Array.isArray(content)) {
                    const texts = content.filter(c => c.type === "text").map(c => c.text);
                    simplified.text = texts.join("\n").substring(0, 500);
                    const tools = content.filter(c => c.type === "toolCall");
                    if (tools.length) simplified.toolCalls = tools.map(t => t.name || "unknown");
                  } else if (typeof content === "string") {
                    simplified.text = content.substring(0, 500);
                  }
                } else if (role === "toolResult") {
                  simplified.toolName = msg.toolName;
                  simplified.isError = msg.isError || false;
                }
                messages.push(simplified);
              } catch {} // skip unparseable lines
            }

            return ok({
              found: true,
              agentId: aid,
              sessionKey,
              transcriptFile: entry.sessionFile,
              totalLines: lines.length,
              showing: messages.length,
              messages,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            return ok({ found: true, agentId: aid, sessionKey, error: `Can't read transcript: ${e.message}` });
          }
        }

        return ok({ found: false, sessionKey, searchedAgents: agents });
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  LAYER 1b: Debug action tools (_ms_*)                      ║
    // ╚══════════════════════════════════════════════════════════════╝

    // ─── _ms_kill_session ──────────────────────────────────────────
    api.registerTool({
      name: "_ms_kill_session",
      description: "[debug] Kill a session: set status to 'done', optionally delete from store.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to kill" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all." },
          deleteFromStore: { type: "boolean", description: "If true, remove entry entirely. Default: false (just marks done)." },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        const { sessionKey, deleteFromStore = false } = params;
        const agents = params.agentId ? [params.agentId] : listAgentIds();

        for (const aid of agents) {
          const store = readStore(aid);
          if (!store[sessionKey]) continue;

          const before = { status: store[sessionKey].status, updatedAt: store[sessionKey].updatedAt };

          if (deleteFromStore) {
            delete store[sessionKey];
          } else {
            store[sessionKey].status = "done";
            store[sessionKey].endedAt = Date.now();
            store[sessionKey].updatedAt = Date.now();
          }

          const storePath = join(AGENTS_DIR, aid, "sessions", "sessions.json");
          writeFileSync(storePath, JSON.stringify(store, null, 2));

          return ok({
            ok: true,
            agentId: aid,
            sessionKey,
            action: deleteFromStore ? "deleted" : "marked-done",
            before,
            timestamp: new Date().toISOString(),
          });
        }
        return ok({ ok: false, error: "Session not found", sessionKey });
      },
    });

    // ─── _ms_link_session ──────────────────────────────────────────
    api.registerTool({
      name: "_ms_link_session",
      description: "[debug] Link a session to a Discord thread by patching deliveryContext.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to link" },
          threadId: { type: "string", description: "Discord thread ID to link to" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all." },
        },
        required: ["sessionKey", "threadId"],
      },
      async execute(_id, params) {
        const { sessionKey, threadId } = params;
        const agents = params.agentId ? [params.agentId] : listAgentIds();

        for (const aid of agents) {
          const store = readStore(aid);
          if (!store[sessionKey]) continue;

          const before = store[sessionKey].deliveryContext;
          Object.assign(store[sessionKey], {
            deliveryContext: { channel: "discord", to: `channel:${threadId}`, accountId: "default", threadId },
            lastChannel: "discord", lastTo: `channel:${threadId}`,
            lastAccountId: "default", lastThreadId: threadId,
            channel: "discord", chatType: "channel",
            updatedAt: Date.now(),
          });

          const storePath = join(AGENTS_DIR, aid, "sessions", "sessions.json");
          writeFileSync(storePath, JSON.stringify(store, null, 2));

          return ok({
            ok: true, agentId: aid, sessionKey, threadId,
            before: before || null,
            after: store[sessionKey].deliveryContext,
            timestamp: new Date().toISOString(),
          });
        }
        return ok({ ok: false, error: "Session not found", sessionKey });
      },
    });

    // ─── _ms_unlink_session ────────────────────────────────────────
    api.registerTool({
      name: "_ms_unlink_session",
      description: "[debug] Unlink a session from its Discord thread. Clears deliveryContext.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to unlink" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all." },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        const { sessionKey } = params;
        const agents = params.agentId ? [params.agentId] : listAgentIds();

        for (const aid of agents) {
          const store = readStore(aid);
          if (!store[sessionKey]) continue;

          const before = store[sessionKey].deliveryContext;
          store[sessionKey].deliveryContext = {};
          store[sessionKey].lastChannel = null;
          store[sessionKey].lastTo = null;
          store[sessionKey].updatedAt = Date.now();

          const storePath = join(AGENTS_DIR, aid, "sessions", "sessions.json");
          writeFileSync(storePath, JSON.stringify(store, null, 2));

          return ok({
            ok: true, agentId: aid, sessionKey,
            before: before || null,
            timestamp: new Date().toISOString(),
          });
        }
        return ok({ ok: false, error: "Session not found", sessionKey });
      },
    });

    // ─── _ms_focus_thread ──────────────────────────────────────────
    api.registerTool({
      name: "_ms_focus_thread",
      description: "[debug] Focus a Discord thread — write thread binding so messages route to a specific session.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID to focus" },
          sessionKey: { type: "string", description: "Session key to route to" },
          agentId: { type: "string", description: "Agent ID that owns the session" },
        },
        required: ["threadId", "sessionKey"],
      },
      async execute(_id, params) {
        const { threadId, sessionKey, agentId } = params;
        const tb = loadThreadBindings();

        const before = tb.bindings[threadId] || null;
        tb.bindings[threadId] = {
          sessionKey,
          agentId: agentId || sessionKey.split(":")[1],
          focusedAt: Date.now(),
        };

        writeFileSync(THREAD_BINDINGS_PATH, JSON.stringify(tb, null, 2));

        return ok({
          ok: true, threadId, sessionKey,
          before,
          after: tb.bindings[threadId],
          timestamp: new Date().toISOString(),
        });
      },
    });

    // ─── _ms_unfocus_thread ────────────────────────────────────────
    api.registerTool({
      name: "_ms_unfocus_thread",
      description: "[debug] Unfocus a Discord thread — remove thread binding.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID to unfocus" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId } = params;
        const tb = loadThreadBindings();
        const before = tb.bindings[threadId] || null;

        if (!before) return ok({ ok: false, error: "Thread not focused", threadId });

        delete tb.bindings[threadId];
        writeFileSync(THREAD_BINDINGS_PATH, JSON.stringify(tb, null, 2));

        return ok({ ok: true, threadId, removed: before, timestamp: new Date().toISOString() });
      },
    });

    // ─── _ms_wake_session ──────────────────────────────────────────
    api.registerTool({
      name: "_ms_wake_session",
      description: "[debug] Send a message into a session via subagent.run. Creates session if needed.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to wake" },
          message: { type: "string", description: "Message to send to the session" },
          deliver: { type: "boolean", description: "Whether to deliver reply to channel. Default: true" },
          timeoutMs: { type: "number", description: "Wait timeout in ms. Default: 60000. 0 = fire and forget." },
        },
        required: ["sessionKey", "message"],
      },
      async execute(_id, params) {
        const { sessionKey, message, deliver = true, timeoutMs = 60000 } = params;
        logger.info(`wake_session: ${sessionKey}`);

        try {
          const { runId } = await runtime.subagent.run({
            sessionKey, message, deliver,
            idempotencyKey: crypto.randomUUID(),
          });

          if (timeoutMs === 0) {
            return ok({ ok: true, runId, sessionKey, status: "accepted", timestamp: new Date().toISOString() });
          }

          try {
            const result = await runtime.subagent.waitForRun({ runId, timeoutMs });
            return ok({
              ok: true, runId, sessionKey,
              status: result?.status || "unknown",
              hasReply: !!result?.reply,
              replyPreview: result?.reply?.substring(0, 500),
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            return ok({ ok: true, runId, sessionKey, status: "timeout", error: e.message, timestamp: new Date().toISOString() });
          }
        } catch (e) {
          return ok({ ok: false, sessionKey, error: e.message, timestamp: new Date().toISOString() });
        }
      },
    });

    // ─── _ms_bootstrap_session ─────────────────────────────────────
    api.registerTool({
      name: "_ms_bootstrap_session",
      description: "[debug] Create a fresh session entry in an agent's store with Discord deliveryContext. Does NOT run the session.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID to create session under" },
          threadId: { type: "string", description: "Discord thread ID to bind to" },
          sessionKey: { type: "string", description: "Custom session key. Default: agent:<agentId>:discord:channel:<threadId>" },
        },
        required: ["agentId", "threadId"],
      },
      async execute(_id, params) {
        const { agentId, threadId } = params;
        const sessionKey = params.sessionKey || `agent:${agentId}:discord:channel:${threadId}`;

        const store = readStore(agentId);
        const existed = !!store[sessionKey];

        store[sessionKey] = {
          sessionId: store[sessionKey]?.sessionId || crypto.randomUUID(),
          status: "idle",
          deliveryContext: { channel: "discord", to: `channel:${threadId}`, accountId: "default", threadId },
          lastChannel: "discord",
          lastTo: `channel:${threadId}`,
          lastAccountId: "default",
          lastThreadId: threadId,
          channel: "discord",
          chatType: "channel",
          updatedAt: Date.now(),
          startedAt: Date.now(),
          totalTokens: 0,
          ...(store[sessionKey] || {}), // preserve existing fields if updating
          // Always overwrite these
          deliveryContext: { channel: "discord", to: `channel:${threadId}`, accountId: "default", threadId },
          lastChannel: "discord",
          lastTo: `channel:${threadId}`,
          updatedAt: Date.now(),
        };

        const storePath = join(AGENTS_DIR, agentId, "sessions", "sessions.json");
        writeFileSync(storePath, JSON.stringify(store, null, 2));

        return ok({
          ok: true, agentId, threadId, sessionKey,
          action: existed ? "updated" : "created",
          deliveryContext: store[sessionKey].deliveryContext,
          timestamp: new Date().toISOString(),
        });
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  LAYER 1c: Discord API debug tools (_ms_*)                 ║
    // ╚══════════════════════════════════════════════════════════════╝

    function getDiscordToken() {
      const config = loadConfig();
      return config.channels?.discord?.token;
    }

    async function discordApi(method, path, body) {
      const token = getDiscordToken();
      if (!token) throw new Error("Discord token not found in config");
      const opts = {
        method,
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`https://discord.com/api/v10${path}`, opts);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Discord API ${res.status}: ${text}`);
      }
      return res.json();
    }

    // ─── _ms_health (cross-agent) ─── already registered above ───

    // Everything below uses the Discord REST API directly via bot token
    // because the message tool doesn't expose all thread operations.

    // ─── _ms_archive_thread ────────────────────────────────────────
    // Note: NOT a registered tool. discordApi is used by higher-level
    // composed tools. But we DO register granular Discord debug tools:

    // Helper: modify thread metadata
    async function patchThread(threadId, patch) {
      return discordApi("PATCH", `/channels/${threadId}`, patch);
    }

    // Helper: get channel info
    async function getChannel(channelId) {
      return discordApi("GET", `/channels/${channelId}`);
    }

    // Helper: list threads in a forum
    async function listForumThreads(guildId, channelId, includeArchived = true) {
      // Active threads (guild-wide, filter by parent)
      const active = await discordApi("GET", `/guilds/${guildId}/threads/active`);
      const activeInForum = (active.threads || []).filter(t => t.parent_id === channelId);

      let archived = [];
      if (includeArchived) {
        try {
          const arch = await discordApi("GET", `/channels/${channelId}/threads/archived/public?limit=100`);
          archived = arch.threads || [];
        } catch {} // may fail if no archived threads
      }

      return { active: activeInForum, archived };
    }

    // Helper: get available tags for a forum
    async function getForumTags(channelId) {
      const ch = await getChannel(channelId);
      return (ch.available_tags || []).map(t => ({ id: t.id, name: t.name }));
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  LAYER 1d: Thread lifecycle debug tools                    ║
    // ╚══════════════════════════════════════════════════════════════╝

    // These fill gaps the `message` tool doesn't cover.

    // ─── _ms_close_thread ──────────────────────────────────────────
    api.registerTool({
      name: "_ms_close_thread",
      description: "[debug] Close a thread: archive + lock. Optionally rename and retag.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          rename: { type: "string", description: "New name (optional). Tip: prefix with ✅ or ❌" },
          tagId: { type: "string", description: "Tag ID to apply (optional)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId, rename, tagId } = params;
        try {
          const patch = { archived: true, locked: true };
          if (rename) patch.name = rename;
          if (tagId) patch.applied_tags = [tagId];
          const result = await patchThread(threadId, patch);
          return ok({
            ok: true, threadId,
            name: result.name,
            archived: result.thread_metadata?.archived,
            locked: result.thread_metadata?.locked,
            tags: result.applied_tags,
          });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    // ─── _ms_open_thread ───────────────────────────────────────────
    api.registerTool({
      name: "_ms_open_thread",
      description: "[debug] Reopen a thread: unarchive + unlock. Optionally rename and retag.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          rename: { type: "string", description: "New name (optional). Tip: prefix with 🔄" },
          tagId: { type: "string", description: "Tag ID to apply (optional)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId, rename, tagId } = params;
        try {
          const patch = { archived: false, locked: false };
          if (rename) patch.name = rename;
          if (tagId) patch.applied_tags = [tagId];
          const result = await patchThread(threadId, patch);
          return ok({
            ok: true, threadId,
            name: result.name,
            archived: result.thread_metadata?.archived,
            locked: result.thread_metadata?.locked,
            tags: result.applied_tags,
          });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    // ─── _ms_get_thread ────────────────────────────────────────────
    api.registerTool({
      name: "_ms_get_thread",
      description: "[debug] Get full thread state: Discord metadata + session store data combined.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId } = params;
        try {
          // Discord side
          const ch = await getChannel(threadId);
          const parentId = ch.parent_id;

          // Get parent forum tags
          let tagMap = {};
          try {
            const tags = await getForumTags(parentId);
            for (const t of tags) tagMap[t.id] = t.name;
          } catch {}

          // Session side
          const sessions = [];
          for (const agentId of listAgentIds()) {
            const store = readStore(agentId);
            for (const [key, v] of Object.entries(store)) {
              if (key.includes(threadId) || v.deliveryContext?.threadId === threadId) {
                sessions.push(formatSession(key, v, agentId));
              }
            }
          }

          // Thread binding
          const tb = loadThreadBindings();
          const focused = tb.bindings?.[threadId] || null;

          // Forum binding — which agent owns the parent forum?
          const fb = getForumBindings();
          const forumAgent = fb[`forum:${parentId}`] || null;

          return ok({
            threadId,
            name: ch.name,
            parentId,
            parentName: null, // would need another API call
            forumAgent,
            archived: ch.thread_metadata?.archived || false,
            locked: ch.thread_metadata?.locked || false,
            tags: (ch.applied_tags || []).map(id => ({ id, name: tagMap[id] || "unknown" })),
            messageCount: ch.message_count || 0,
            memberCount: ch.member_count || 0,
            createdAt: ch.thread_metadata?.create_timestamp,
            autoArchiveDuration: ch.thread_metadata?.auto_archive_duration,
            // Sessions
            sessionCount: sessions.length,
            sessions,
            focused,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    // ─── _ms_board ─────────────────────────────────────────────────
    api.registerTool({
      name: "_ms_board",
      description: "[debug] Full board view: all forums, all threads, all sessions. Filterable by mindset or status.",
      parameters: {
        type: "object",
        properties: {
          mindset: { type: "string", description: "Filter by agent/mindset ID (e.g. 'sysadmin'). Omit for all." },
          status: { type: "string", description: "Filter: 'open' (not archived), 'closed' (archived), 'all'. Default: 'all'" },
        },
      },
      async execute(_id, params) {
        const { mindset, status: statusFilter = "all" } = params || {};
        const fb = getForumBindings();
        const config = loadConfig();
        const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];
        if (!guildId) return ok({ ok: false, error: "No guild configured" });

        const bindings = (config.bindings || [])
          .filter(b => b.match?.peer?.kind === "channel")
          .filter(b => !mindset || b.agentId === mindset);

        const forums = [];

        for (const binding of bindings) {
          const forumId = binding.match.peer.id;
          const agentId = binding.agentId;

          try {
            // Get forum info + tags
            const forumInfo = await getChannel(forumId);
            const tagMap = {};
            for (const t of (forumInfo.available_tags || [])) tagMap[t.id] = t.name;

            // Get threads
            const { active, archived } = await listForumThreads(guildId, forumId);

            let allThreads = [
              ...active.map(t => ({ ...t, _active: true })),
              ...archived.map(t => ({ ...t, _active: false })),
            ];

            // Filter by status
            if (statusFilter === "open") allThreads = allThreads.filter(t => !t.thread_metadata?.archived);
            else if (statusFilter === "closed") allThreads = allThreads.filter(t => t.thread_metadata?.archived);

            // Get sessions for this agent
            const store = readStore(agentId);

            const threads = allThreads.map(t => {
              const sessionKey = `agent:${agentId}:discord:channel:${t.id}`;
              const session = store[sessionKey];
              const tags = (t.applied_tags || []).map(id => tagMap[id] || id);

              return {
                id: t.id,
                name: t.name,
                tags,
                archived: t.thread_metadata?.archived || false,
                locked: t.thread_metadata?.locked || false,
                messageCount: t.message_count || 0,
                createdAt: t.thread_metadata?.create_timestamp,
                hasSession: !!session,
                sessionStatus: session?.status || null,
                sessionTokens: session?.totalTokens || 0,
                sessionUpdated: session ? timeAgo(session.updatedAt) : null,
                hasDiscordDelivery: session?.deliveryContext?.channel === "discord" && !!session?.deliveryContext?.to,
              };
            });

            // Sort: open first, then by message count desc
            threads.sort((a, b) => {
              if (a.archived !== b.archived) return a.archived ? 1 : -1;
              return (b.messageCount || 0) - (a.messageCount || 0);
            });

            forums.push({
              agentId,
              forumId,
              forumName: forumInfo.name,
              tags: Object.entries(tagMap).map(([id, name]) => ({ id, name })),
              threadCount: threads.length,
              openCount: threads.filter(t => !t.archived).length,
              closedCount: threads.filter(t => t.archived).length,
              withSession: threads.filter(t => t.hasSession).length,
              threads,
            });
          } catch (e) {
            forums.push({ agentId, forumId, error: e.message });
          }
        }

        return ok({
          guildId,
          mindsetFilter: mindset || "all",
          statusFilter,
          forumCount: forums.length,
          forums,
          timestamp: new Date().toISOString(),
        });
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  LAYER 2: Agent tools (mindset_*)                          ║
    // ║  (Placeholder — semantic tools composed from Layer 1)      ║
    // ╚══════════════════════════════════════════════════════════════╝

    api.registerTool({
      name: "mindset_ping",
      description: "Test tool — confirms the openclaw-mindsets extension is loaded.",
      parameters: { type: "object", properties: {} },
      async execute(_id) {
        return ok({ ok: true, extension: "openclaw-mindsets", version: "0.1.0", timestamp: new Date().toISOString() });
      },
    });

    api.registerTool({
      name: "mindset_session_probe",
      description: "Probe session store capabilities. Tests: list sessions, read store, check subagent API. Returns raw findings.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID to probe session store for (e.g. 'main', 'sysadmin'). Defaults to 'main'." },
        },
      },
      async execute(_id, params) {
        const agentId = params?.agentId || "main";
        const agents = listAgentIds();
        const byAgent = {};
        for (const aid of agents) byAgent[aid] = Object.keys(readStore(aid)).length;
        return ok({
          agentId, timestamp: new Date().toISOString(),
          agents: byAgent,
          subagentMethods: Object.getOwnPropertyNames(runtime.subagent)
            .filter(k => typeof runtime.subagent[k] === "function"),
        });
      },
    });

    api.registerTool({
      name: "mindset_create_task",
      description: "TEST: Create a task session in a target agent's forum thread. Patches deliveryContext for Discord routing. Returns session key and delivery status.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Target agent ID (e.g. 'sysadmin')" },
          threadId: { type: "string", description: "Discord thread ID to bind the session to" },
          message: { type: "string", description: "Task instructions for the agent" },
        },
        required: ["agentId", "threadId", "message"],
      },
      async execute(_id, params) {
        const { agentId, threadId, message } = params || {};
        if (!agentId || !threadId || !message) return ok({ error: "Missing required params" });

        logger.info(`create_task: agentId=${agentId} threadId=${threadId}`);
        const sessionKey = `agent:${agentId}:discord:channel:${threadId}`;
        const results = { agentId, threadId, sessionKey, timestamp: new Date().toISOString(), steps: {} };

        try {
          const store = readStore(agentId);
          const storePath = join(AGENTS_DIR, agentId, "sessions", "sessions.json");
          if (!store[sessionKey]) store[sessionKey] = { sessionId: sessionKey, updatedAt: Date.now() };
          Object.assign(store[sessionKey], {
            deliveryContext: { channel: "discord", to: `channel:${threadId}`, accountId: "default", threadId },
            lastChannel: "discord", lastTo: `channel:${threadId}`,
            lastAccountId: "default", lastThreadId: threadId,
            channel: "discord", chatType: "channel", updatedAt: Date.now(),
          });
          writeFileSync(storePath, JSON.stringify(store, null, 2));
          results.steps.patchStore = { ok: true };
        } catch (e) {
          results.steps.patchStore = { ok: false, error: e.message };
          return ok(results);
        }

        try {
          const { runId } = await runtime.subagent.run({
            sessionKey, message, deliver: true, idempotencyKey: crypto.randomUUID(),
          });
          results.steps.run = { ok: true, runId };
          const store2 = readStore(agentId);
          results.steps.dcSurvived = { ok: store2[sessionKey]?.deliveryContext?.to === `channel:${threadId}` };
          try {
            const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 90000 });
            results.steps.wait = { ok: true, status: result?.status, replyPreview: result?.reply?.substring(0, 300) };
          } catch (e) { results.steps.wait = { ok: false, error: e.message }; }
        } catch (e) { results.steps.run = { ok: false, error: e.message }; }
        return ok(results);
      },
    });

    logger.info("openclaw-mindsets: registered all tools");
  },
};
