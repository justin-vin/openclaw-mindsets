/**
 * openclaw-mindsets — Multiple AI mindsets, one identity.
 *
 * Architecture:
 *   Primitives   — config, store, Discord API
 *   Shared       — reusable functions (the library)
 *   L1 (_ms_*)   — debug tools, thin wrappers
 *   L2 (ms_*)    — composed operations
 *   L3 (ms3_*)   — coordination primitives
 *   L4           — agent-facing (delegate, board, query, nudge, close)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const OPENCLAW_HOME = "/Users/justin/.openclaw";
const AGENTS_DIR = join(OPENCLAW_HOME, "agents");
const THREAD_BINDINGS_PATH = join(OPENCLAW_HOME, "discord", "thread-bindings.json");

// ════════════════════════════════════════════════════════════════════
//  PRIMITIVES — config, store, Discord API
// ════════════════════════════════════════════════════════════════════

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function loadConfig() {
  return JSON.parse(readFileSync(join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
}

function loadThreadBindings() {
  try { return JSON.parse(readFileSync(THREAD_BINDINGS_PATH, "utf-8")); }
  catch { return { version: 1, bindings: {} }; }
}

function saveThreadBindings(tb) {
  writeFileSync(THREAD_BINDINGS_PATH, JSON.stringify(tb, null, 2));
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

function writeStore(agentId, store) {
  const p = join(AGENTS_DIR, agentId, "sessions", "sessions.json");
  writeFileSync(p, JSON.stringify(store, null, 2));
}

function getDiscordToken() {
  return loadConfig().channels?.discord?.token;
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
  if (method === "DELETE" || res.status === 204) return {};
  return res.json();
}

// ════════════════════════════════════════════════════════════════════
//  SHARED FUNCTIONS — the library, reusable by all layers
// ════════════════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────────────

function timeAgo(ts) {
  if (!ts) return "unknown";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function classifySession(key) {
  if (key.endsWith(":main")) return "main";
  if (key.includes(":subagent:")) return "subagent";
  if (key.includes(":cron:")) return "cron";
  if (key.includes(":discord:channel:")) return "discord-thread";
  if (key.includes(":discord:")) return "discord-other";
  return "other";
}

function threadIdFromKey(key) {
  return key.split("discord:channel:")[1]?.split(":")[0] || null;
}

function sessionKeyFor(agentId, threadId) {
  return `agent:${agentId}:discord:channel:${threadId}`;
}

function makeDeliveryContext(threadId) {
  return { channel: "discord", to: `channel:${threadId}`, accountId: "default", threadId };
}

// ── Forum / binding lookups ────────────────────────────────────────

function getForumBindings() {
  const config = loadConfig();
  const result = {};
  for (const b of (config.bindings || [])) {
    const peer = b.match?.peer;
    if (peer?.kind === "channel" && b.agentId) {
      result[b.agentId] = peer.id;
      result[`forum:${peer.id}`] = b.agentId;
    }
  }
  return result;
}

function getConfigBindings(mindset) {
  const config = loadConfig();
  return (config.bindings || [])
    .filter(b => b.match?.peer?.kind === "channel")
    .filter(b => !mindset || b.agentId === mindset);
}

function getGuildId() {
  const config = loadConfig();
  return Object.keys(config.channels?.discord?.guilds || {})[0] || null;
}

function getHumanId() {
  const config = loadConfig();
  const guilds = config.channels?.discord?.guilds || {};
  const guildId = Object.keys(guilds)[0];
  const users = guilds[guildId]?.users || [];
  return users.find(u => u !== "992803324116078692") || users[0] || null;
}

// ── Session formatting ─────────────────────────────────────────────

function formatSession(key, v, agentId) {
  const kind = classifySession(key);
  const base = {
    key, agent: agentId, kind,
    status: v.status || "unknown",
    totalTokens: v.totalTokens || 0,
    model: v.model || null,
    updatedAt: v.updatedAt || 0,
    updatedAgo: timeAgo(v.updatedAt),
  };

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
    const threadId = threadIdFromKey(key);
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
  if (kind === "cron") base.label = v.label || null;
  return base;
}

// ── Session CRUD ───────────────────────────────────────────────────

/** Find a session entry, searching across agents if needed. Returns { agentId, entry } or null. */
function findSession(sessionKey, agentId) {
  const agents = agentId ? [agentId] : listAgentIds();
  for (const aid of agents) {
    const store = readStore(aid);
    if (store[sessionKey]) return { agentId: aid, entry: store[sessionKey], store };
  }
  return null;
}

/** Find ALL sessions matching a threadId across all agents. */
function findSessionsForThread(threadId) {
  const matches = [];
  for (const agentId of listAgentIds()) {
    const store = readStore(agentId);
    for (const [key, v] of Object.entries(store)) {
      if (key.includes(threadId) || v.deliveryContext?.threadId === threadId ||
          v.deliveryContext?.to === `channel:${threadId}`) {
        matches.push({ agentId, key, ...v });
      }
    }
  }
  return matches;
}

/** Idempotent: ensure a session exists with correct deliveryContext. Returns { action, sessionKey }. */
function ensureSession(agentId, threadId) {
  const sessionKey = sessionKeyFor(agentId, threadId);
  const expectedDC = makeDeliveryContext(threadId);
  const store = readStore(agentId);
  const existing = store[sessionKey];

  if (existing) {
    const dc = existing.deliveryContext || {};
    if (dc.channel === "discord" && dc.to === `channel:${threadId}`) {
      return { action: "verified", sessionKey, agentId, threadId,
        status: existing.status || "unknown", totalTokens: existing.totalTokens || 0,
        hasTranscript: !!existing.sessionFile };
    }
    // Patch wrong DC
    Object.assign(existing, {
      deliveryContext: expectedDC,
      lastChannel: "discord", lastTo: `channel:${threadId}`,
      lastAccountId: "default", lastThreadId: threadId,
      channel: "discord", chatType: "channel", updatedAt: Date.now(),
    });
    writeStore(agentId, store);
    return { action: "patched", sessionKey, agentId, threadId, reason: "deliveryContext was missing or incorrect" };
  }

  // Create new
  store[sessionKey] = {
    sessionId: crypto.randomUUID(), status: "idle",
    deliveryContext: expectedDC,
    lastChannel: "discord", lastTo: `channel:${threadId}`,
    lastAccountId: "default", lastThreadId: threadId,
    channel: "discord", chatType: "channel",
    updatedAt: Date.now(), startedAt: Date.now(), totalTokens: 0,
  };
  writeStore(agentId, store);
  return { action: "created", sessionKey, agentId, threadId };
}

/** Idempotent: close thread + kill all sessions for it. */
async function ensureClosed(threadId, tagId) {
  const results = { threadId, steps: {} };

  try {
    const patch = { archived: true, locked: true };
    if (tagId) patch.applied_tags = [tagId];
    const ch = await patchThread(threadId, patch);
    results.steps.thread = { ok: true, archived: ch.thread_metadata?.archived, locked: ch.thread_metadata?.locked };
  } catch (e) {
    results.steps.thread = { ok: false, error: e.message };
  }

  const killed = [];
  for (const agentId of listAgentIds()) {
    const store = readStore(agentId);
    let changed = false;
    for (const [key, v] of Object.entries(store)) {
      if ((key.includes(threadId) || v.deliveryContext?.threadId === threadId) && v.status !== "done") {
        store[key].status = "done";
        store[key].endedAt = Date.now();
        store[key].updatedAt = Date.now();
        changed = true;
        killed.push({ agentId, key });
      }
    }
    if (changed) writeStore(agentId, store);
  }
  results.steps.sessions = { ok: true, killed: killed.length, details: killed };
  return results;
}

/** Kill a single session. Returns result object. */
function killSession(sessionKey, agentId, deleteFromStore = false) {
  const found = findSession(sessionKey, agentId);
  if (!found) return { ok: false, error: "Session not found", sessionKey };

  const { agentId: aid, store } = found;
  const before = { status: store[sessionKey].status, updatedAt: store[sessionKey].updatedAt };

  if (deleteFromStore) {
    delete store[sessionKey];
  } else {
    store[sessionKey].status = "done";
    store[sessionKey].endedAt = Date.now();
    store[sessionKey].updatedAt = Date.now();
  }
  writeStore(aid, store);

  return { ok: true, agentId: aid, sessionKey, action: deleteFromStore ? "deleted" : "marked-done", before, timestamp: new Date().toISOString() };
}

/** Link a session to a Discord thread by patching deliveryContext. */
function linkSession(sessionKey, threadId, agentId) {
  const found = findSession(sessionKey, agentId);
  if (!found) return { ok: false, error: "Session not found", sessionKey };

  const { agentId: aid, store } = found;
  const before = store[sessionKey].deliveryContext;
  Object.assign(store[sessionKey], {
    deliveryContext: makeDeliveryContext(threadId),
    lastChannel: "discord", lastTo: `channel:${threadId}`,
    lastAccountId: "default", lastThreadId: threadId,
    channel: "discord", chatType: "channel", updatedAt: Date.now(),
  });
  writeStore(aid, store);
  return { ok: true, agentId: aid, sessionKey, threadId, before: before || null, after: store[sessionKey].deliveryContext, timestamp: new Date().toISOString() };
}

/** Unlink a session from its Discord thread. */
function unlinkSession(sessionKey, agentId) {
  const found = findSession(sessionKey, agentId);
  if (!found) return { ok: false, error: "Session not found", sessionKey };

  const { agentId: aid, store } = found;
  const before = store[sessionKey].deliveryContext;
  store[sessionKey].deliveryContext = {};
  store[sessionKey].lastChannel = null;
  store[sessionKey].lastTo = null;
  store[sessionKey].updatedAt = Date.now();
  writeStore(aid, store);
  return { ok: true, agentId: aid, sessionKey, before: before || null, timestamp: new Date().toISOString() };
}

/** Patch arbitrary fields on a session. */
function patchSessionFields(sessionKey, patch, agentId) {
  const found = findSession(sessionKey, agentId);
  if (!found) return { ok: false, error: "Session not found", sessionKey };

  const { agentId: aid, store } = found;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = store[sessionKey][k];
  Object.assign(store[sessionKey], patch);
  store[sessionKey].updatedAt = Date.now();
  writeStore(aid, store);
  return { ok: true, agentId: aid, sessionKey, before, after: patch };
}

/** Bootstrap a fresh session entry. */
function bootstrapSession(agentId, threadId, customKey) {
  const sessionKey = customKey || sessionKeyFor(agentId, threadId);
  const store = readStore(agentId);
  const existed = !!store[sessionKey];
  const dc = makeDeliveryContext(threadId);

  store[sessionKey] = {
    sessionId: store[sessionKey]?.sessionId || crypto.randomUUID(),
    status: "idle", deliveryContext: dc,
    lastChannel: "discord", lastTo: `channel:${threadId}`,
    lastAccountId: "default", lastThreadId: threadId,
    channel: "discord", chatType: "channel",
    updatedAt: Date.now(), startedAt: Date.now(), totalTokens: 0,
    ...(store[sessionKey] || {}),
    // Always overwrite these
    deliveryContext: dc, lastChannel: "discord", lastTo: `channel:${threadId}`, updatedAt: Date.now(),
  };
  writeStore(agentId, store);
  return { ok: true, agentId, threadId, sessionKey, action: existed ? "updated" : "created", deliveryContext: dc, timestamp: new Date().toISOString() };
}

/** Reset a session: delete transcript, reset counters, keep identity. */
function resetSession(sessionKey, agentId) {
  const found = findSession(sessionKey, agentId);
  if (!found) return { ok: false, error: "Session not found", sessionKey };

  const { agentId: aid, store } = found;
  const entry = store[sessionKey];
  const oldFile = entry.sessionFile;
  const { deliveryContext: dc, channel, chatType, origin } = entry;

  if (oldFile) { try { renameSync(oldFile, `${oldFile}.reset.${Date.now()}`); } catch {} }

  Object.assign(entry, {
    status: "idle", sessionFile: null,
    totalTokens: 0, totalTokensFresh: false, inputTokens: 0, outputTokens: 0,
    cacheRead: 0, cacheWrite: 0, estimatedCostUsd: 0, contextTokens: 0,
    compactionCount: 0, abortedLastRun: false,
    updatedAt: Date.now(), startedAt: Date.now(), endedAt: null, runtimeMs: null,
    deliveryContext: dc, channel, chatType, origin,
  });
  writeStore(aid, store);
  return { ok: true, agentId: aid, sessionKey, oldTranscript: oldFile || null, deliveryContextPreserved: !!dc };
}

// ── Thread binding (focus/unfocus) ─────────────────────────────────

function focusThread(threadId, sessionKey, agentId) {
  const tb = loadThreadBindings();
  const before = tb.bindings[threadId] || null;
  tb.bindings[threadId] = {
    sessionKey, agentId: agentId || sessionKey.split(":")[1], focusedAt: Date.now(),
  };
  saveThreadBindings(tb);
  return { ok: true, threadId, sessionKey, before, after: tb.bindings[threadId], timestamp: new Date().toISOString() };
}

function unfocusThread(threadId) {
  const tb = loadThreadBindings();
  const before = tb.bindings[threadId] || null;
  if (!before) return { ok: false, error: "Thread not focused", threadId };
  delete tb.bindings[threadId];
  saveThreadBindings(tb);
  return { ok: true, threadId, removed: before, timestamp: new Date().toISOString() };
}

// ── Discord thread helpers ─────────────────────────────────────────

async function patchThread(threadId, patch) {
  return discordApi("PATCH", `/channels/${threadId}`, patch);
}

async function getChannel(channelId) {
  return discordApi("GET", `/channels/${channelId}`);
}

async function listForumThreads(guildId, channelId, includeArchived = true) {
  const active = await discordApi("GET", `/guilds/${guildId}/threads/active`);
  const activeInForum = (active.threads || []).filter(t => t.parent_id === channelId);
  let archived = [];
  if (includeArchived) {
    try {
      const arch = await discordApi("GET", `/channels/${channelId}/threads/archived/public?limit=100`);
      archived = arch.threads || [];
    } catch {}
  }
  return { active: activeInForum, archived };
}

async function getForumTags(channelId) {
  const ch = await getChannel(channelId);
  return (ch.available_tags || []).map(t => ({ id: t.id, name: t.name }));
}

async function resolveTagId(tagInput, threadId) {
  if (!tagInput) return null;
  if (/^\d+$/.test(tagInput)) return tagInput;
  const ch = await getChannel(threadId);
  if (!ch.parent_id) return null;
  const tags = await getForumTags(ch.parent_id);
  return tags.find(t => t.name.toLowerCase() === tagInput.toLowerCase())?.id || null;
}

const RENDER_MODES = {
  status:  { color: "#5865F2" }, success: { color: "#2ecc71" },
  error:   { color: "#e74c3c" }, warning: { color: "#f39c12" },
  info:    { color: "#3498db" },
};

async function postStyledMessage(threadId, content, kind = "status") {
  const mode = RENDER_MODES[kind] || RENDER_MODES.status;
  const color = parseInt(mode.color.replace("#", ""), 16);
  return discordApi("POST", `/channels/${threadId}/messages`, {
    components: [{ type: 17, accent_color: color, components: [{ type: 10, content }] }],
    flags: 32768,
  });
}

async function postPlainMessage(threadId, content, silent = false) {
  const body = { content };
  if (silent) body.flags = 4096;
  return discordApi("POST", `/channels/${threadId}/messages`, body);
}

async function readThreadMessages(threadId, limit = 20) {
  const clamp = Math.min(Math.max(limit || 20, 1), 100);
  const messages = await discordApi("GET", `/channels/${threadId}/messages?limit=${clamp}`);
  return (messages || []).map(m => ({
    id: m.id,
    author: m.author?.global_name || m.author?.username || "unknown",
    authorId: m.author?.id, isBot: m.author?.bot || false,
    content: (m.content || "").substring(0, 300),
    hasComponents: (m.components || []).length > 0,
    timestamp: m.timestamp,
  })).reverse();
}

// ── Gateway API ────────────────────────────────────────────────────

async function invokeToolAsSession(sessionKey, toolName, args) {
  const config = loadConfig();
  const token = config.gateway?.auth?.token;
  const port = config.gateway?.port || 18789;
  if (!token) throw new Error("Gateway auth token not found");
  const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: toolName, sessionKey, args }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`tools/invoke ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Runtime-dependent functions (set in register()) ────────────────

let _runtime = null;

async function wakeSession(rt, sessionKey, message, deliver = true, timeoutMs = 60000) {
  const { runId } = await rt.subagent.run({
    sessionKey, message, deliver, idempotencyKey: crypto.randomUUID(),
  });
  if (timeoutMs === 0) return { ok: true, runId, sessionKey, status: "accepted", timestamp: new Date().toISOString() };

  try {
    const result = await rt.subagent.waitForRun({ runId, timeoutMs });
    return {
      ok: true, runId, sessionKey,
      status: result?.status || "unknown",
      hasReply: !!result?.reply,
      replyPreview: result?.reply?.substring(0, 500),
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: true, runId, sessionKey, status: "timeout", error: e.message, timestamp: new Date().toISOString() };
  }
}

async function silentQuery(rt, sessionKey, message, timeoutMs = 60000) {
  const { runId } = await rt.subagent.run({
    sessionKey, message, deliver: false, idempotencyKey: crypto.randomUUID(),
  });
  try {
    const result = await rt.subagent.waitForRun({ runId, timeoutMs });
    let reply = result?.reply || null;
    if (!reply) {
      try {
        const { messages } = await rt.subagent.getSessionMessages({ sessionKey, limit: 3 });
        const last = [...(messages || [])].reverse().find(m => m.role === "assistant");
        if (last?.content) {
          reply = typeof last.content === "string" ? last.content :
            Array.isArray(last.content) ? last.content.filter(c => c.type === "text").map(c => c.text).join("\n") : null;
        }
      } catch {}
    }
    return { ok: true, sessionKey, runId, status: result?.status || "unknown", reply: reply || "(no reply)" };
  } catch (e) {
    return { ok: true, sessionKey, runId, status: "timeout", error: e.message };
  }
}

// ── Board scan — shared by _ms_board and board ─────────────────────

async function scanBoard(mindset, statusFilter = "all") {
  const guildId = getGuildId();
  if (!guildId) return { ok: false, error: "No guild configured" };

  const bindings = getConfigBindings(mindset);
  const forums = [];

  for (const binding of bindings) {
    const forumId = binding.match.peer.id;
    const agentId = binding.agentId;
    try {
      const forumInfo = await getChannel(forumId);
      const tagMap = {};
      for (const t of (forumInfo.available_tags || [])) tagMap[t.id] = t.name;

      const { active, archived } = await listForumThreads(guildId, forumId);
      let allThreads = [
        ...active.map(t => ({ ...t, _active: true })),
        ...archived.map(t => ({ ...t, _active: false })),
      ];

      if (statusFilter === "open") allThreads = allThreads.filter(t => !t.thread_metadata?.archived);
      else if (statusFilter === "closed") allThreads = allThreads.filter(t => t.thread_metadata?.archived);

      const store = readStore(agentId);
      const threads = allThreads.map(t => {
        const sk = sessionKeyFor(agentId, t.id);
        const session = store[sk];
        const tags = (t.applied_tags || []).map(id => tagMap[id] || id);
        return {
          id: t.id, name: t.name, tags,
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

      threads.sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        return (b.messageCount || 0) - (a.messageCount || 0);
      });

      forums.push({
        agentId, forumId, forumName: forumInfo.name,
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

  return { ok: true, guildId, mindsetFilter: mindset || "all", statusFilter, forumCount: forums.length, forums, timestamp: new Date().toISOString() };
}

// ── Transcript reader ──────────────────────────────────────────────

function readTranscript(sessionKey, limit = 10, agentId) {
  const maxLimit = Math.min(Math.max(limit || 10, 1), 50);
  const found = findSession(sessionKey, agentId);
  if (!found) return { found: false, sessionKey, searchedAgents: agentId ? [agentId] : listAgentIds() };
  if (!found.entry.sessionFile) return { found: true, agentId: found.agentId, sessionKey, error: "No transcript file" };

  try {
    const raw = readFileSync(found.entry.sessionFile, "utf-8");
    const lines = raw.trim().split("\n").filter(l => l.trim());
    const messages = [];
    const start = Math.max(0, lines.length - maxLimit);

    for (let i = start; i < lines.length; i++) {
      try {
        const envelope = JSON.parse(lines[i]);
        if (envelope.type !== "message") continue;
        const msg = envelope.message || {};
        if (!msg.role) continue;

        const simplified = { role: msg.role, timestamp: envelope.timestamp ? new Date(envelope.timestamp).toISOString() : null };
        const content = msg.content;

        if (msg.role === "user" || msg.role === "system") {
          simplified.text = (typeof content === "string" ? content :
            Array.isArray(content) ? content.map(c => c.text || `[${c.type}]`).join(" ") : "").substring(0, 500);
        } else if (msg.role === "assistant") {
          if (Array.isArray(content)) {
            simplified.text = content.filter(c => c.type === "text").map(c => c.text).join("\n").substring(0, 500);
            const tools = content.filter(c => c.type === "toolCall");
            if (tools.length) simplified.toolCalls = tools.map(t => t.name || "unknown");
          } else if (typeof content === "string") {
            simplified.text = content.substring(0, 500);
          }
        } else if (msg.role === "toolResult") {
          simplified.toolName = msg.toolName;
          simplified.isError = msg.isError || false;
        }
        messages.push(simplified);
      } catch {}
    }

    return {
      found: true, agentId: found.agentId, sessionKey,
      transcriptFile: found.entry.sessionFile,
      totalLines: lines.length, showing: messages.length,
      messages, timestamp: new Date().toISOString(),
    };
  } catch (e) {
    return { found: true, agentId: found.agentId, sessionKey, error: `Can't read transcript: ${e.message}` };
  }
}

// ════════════════════════════════════════════════════════════════════
//  PLUGIN REGISTRATION
// ════════════════════════════════════════════════════════════════════

export default {
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple AI mindsets, one identity.",
  register(api) {
    _runtime = api.runtime;
    const logger = api.logger;
    logger.info("openclaw-mindsets: registering");

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L1: Debug tools (_ms_*) — thin wrappers                   ║
    // ╚══════════════════════════════════════════════════════════════╝

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
          for (const k of keys) byKind[classifySession(k)] = (byKind[classifySession(k)] || 0) + 1;
          return {
            id, forumChannelId: fb[id] || null,
            totalSessions: keys.length,
            activeSessions: keys.filter(k => { const s = store[k].status; return s === "running" || s === "idle"; }).length,
            byKind,
          };
        });
        return ok({ agents, timestamp: new Date().toISOString() });
      },
    });

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
        sessions.sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

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
        const found = findSession(sessionKey, agentId);
        if (!found) return ok({ found: false, sessionKey, searchedAgents: agentId ? [agentId] : listAgentIds() });

        const { agentId: aid, entry: v } = found;
        const tb = loadThreadBindings();
        const threadId = threadIdFromKey(sessionKey);
        const isFocused = threadId ? !!tb.bindings?.[threadId] : false;
        const focusTarget = threadId ? (tb.bindings?.[threadId]?.sessionKey || null) : null;

        return ok({
          found: true, agentId: aid, sessionKey,
          kind: classifySession(sessionKey),
          sessionId: v.sessionId, status: v.status || "unknown",
          deliveryContext: v.deliveryContext || null,
          hasDiscordDelivery: v.deliveryContext?.channel === "discord" && !!v.deliveryContext?.to,
          channel: v.channel, chatType: v.chatType,
          threadId: threadId || null, isFocused, focusTarget,
          totalTokens: v.totalTokens || 0, inputTokens: v.inputTokens || 0,
          outputTokens: v.outputTokens || 0, cacheRead: v.cacheRead || 0,
          estimatedCostUsd: v.estimatedCostUsd || 0,
          model: v.model, modelProvider: v.modelProvider,
          updatedAt: v.updatedAt, updatedAgo: timeAgo(v.updatedAt),
          startedAt: v.startedAt, endedAt: v.endedAt, runtimeMs: v.runtimeMs,
          compactionCount: v.compactionCount || 0, abortedLastRun: v.abortedLastRun || false,
          spawnedBy: v.spawnedBy || null, subagentRole: v.subagentRole || null,
          spawnDepth: v.spawnDepth || null, label: v.label || null,
          origin: v.origin || null, lastChannel: v.lastChannel, lastTo: v.lastTo,
          sessionFile: v.sessionFile,
          skillsSnapshot: v.skillsSnapshot ? (typeof v.skillsSnapshot === "object" && !Array.isArray(v.skillsSnapshot) ? Object.keys(v.skillsSnapshot) : v.skillsSnapshot) : [],
        });
      },
    });

    api.registerTool({
      name: "_ms_list_bindings",
      description: "[debug] List all forum↔agent bindings from OpenClaw config.",
      parameters: { type: "object", properties: {} },
      async execute(_id) {
        const config = loadConfig();
        const bindings = (config.bindings || [])
          .filter(b => b.match?.peer?.kind === "channel")
          .map(b => ({ agentId: b.agentId, forumChannelId: b.match.peer.id, channel: b.match.channel }));

        const tb = loadThreadBindings();
        const threadBindings = Object.entries(tb.bindings || {}).map(([threadId, binding]) => ({ threadId, ...binding }));

        const guilds = config.channels?.discord?.guilds || {};
        const guildInfo = Object.entries(guilds).map(([guildId, g]) => ({
          guildId, requireMention: g.requireMention, users: g.users,
          channelCount: Object.keys(g.channels || {}).length,
          channels: Object.entries(g.channels || {}).map(([chId, ch]) => ({
            id: chId, allow: ch.allow, includeThreadStarter: ch.includeThreadStarter,
          })),
        }));

        return ok({ forumBindings: bindings, threadBindings, threadBindingsVersion: tb.version, guilds: guildInfo, timestamp: new Date().toISOString() });
      },
    });

    api.registerTool({
      name: "_ms_find_thread_sessions",
      description: "[debug] Find all sessions across all agents that match a Discord thread ID.",
      parameters: {
        type: "object",
        properties: { threadId: { type: "string", description: "Discord thread ID to search for" } },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId } = params;
        const matches = findSessionsForThread(threadId).map(m => formatSession(m.key, m, m.agentId));

        const tb = loadThreadBindings();
        const fb = getForumBindings();
        const isForumChannel = !!fb[`forum:${threadId}`];

        const anomalies = [];
        const agentSet = new Set(matches.map(m => m.agent));
        if (agentSet.size > 1) anomalies.push(`multi-agent: sessions in ${[...agentSet].join(", ")}`);
        const webchat = matches.filter(m => m.deliveryContext?.channel === "webchat");
        if (webchat.length) anomalies.push(`webchat-delivery: ${webchat.length} session(s) with webchat instead of discord`);
        const noDelivery = matches.filter(m => !m.hasDiscordDelivery);
        if (noDelivery.length) anomalies.push(`no-discord-delivery: ${noDelivery.length} session(s) missing discord delivery`);

        return ok({
          threadId, isForumChannel, forumAgent: isForumChannel ? fb[`forum:${threadId}`] : null,
          matchCount: matches.length, anomalies: anomalies.length > 0 ? anomalies : null,
          sessions: matches, focused: tb.bindings?.[threadId] ? { ...tb.bindings[threadId] } : null,
          timestamp: new Date().toISOString(),
        });
      },
    });

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
        const threadSessionMap = {};

        for (const agentId of agents) {
          const store = readStore(agentId);
          let agentCost = 0;
          for (const [key, v] of Object.entries(store)) {
            sessionStats.total++;
            const s = v.status || "unknown";
            if (s in sessionStats) sessionStats[s]++;
            agentCost += v.estimatedCostUsd || 0;

            if (s === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 2 * 60 * 60 * 1000) {
              issues.push({ type: "zombie", agentId, key, updatedAgo: timeAgo(v.updatedAt) });
              sessionStats.flagged++;
            }

            if (key.includes("discord:channel:")) {
              const dc = v.deliveryContext || {};
              const threadId = threadIdFromKey(key);
              if (threadId) {
                if (!threadSessionMap[threadId]) threadSessionMap[threadId] = [];
                threadSessionMap[threadId].push({ agentId, key, status: s });
              }
              if (dc.channel === "webchat") { issues.push({ type: "webchat-delivery", agentId, key, threadId }); sessionStats.flagged++; }
              else if (dc.channel !== "discord" || !dc.to) { issues.push({ type: "no-discord-delivery", agentId, key, threadId }); sessionStats.flagged++; }
              if ((v.totalTokens || 0) === 0 && s !== "running" && !v.origin) { issues.push({ type: "orphan-session", agentId, key, threadId, reason: "no tokens, no origin" }); sessionStats.flagged++; }
              if (v.abortedLastRun) { issues.push({ type: "aborted", agentId, key, threadId }); sessionStats.flagged++; }
              if (v.sessionFile) { try { readFileSync(v.sessionFile, "utf-8"); } catch { issues.push({ type: "missing-transcript", agentId, key, file: v.sessionFile }); sessionStats.flagged++; } }
            }
            if (key.includes(":cron:") && !key.includes(":run:") && s === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 30 * 60 * 1000) {
              issues.push({ type: "stale-cron", agentId, key, label: v.label, updatedAgo: timeAgo(v.updatedAt) });
            }
          }
          costByAgent[agentId] = Math.round(agentCost * 1000) / 1000;
        }

        for (const [threadId, sessions] of Object.entries(threadSessionMap)) {
          const uniqueAgents = new Set(sessions.map(s => s.agentId));
          if (uniqueAgents.size > 1) issues.push({ type: "binding-conflict", threadId, agents: [...uniqueAgents], sessions: sessions.length });
        }

        const tb = loadThreadBindings();
        const totalCost = Object.values(costByAgent).reduce((a, b) => a + b, 0);

        return ok({
          timestamp: new Date().toISOString(), sessionStats,
          cost: { total: Math.round(totalCost * 1000) / 1000, byAgent: costByAgent },
          focusedThreads: Object.keys(tb.bindings || {}).length,
          issueCount: issues.length, issues: issues.length > 0 ? issues : "all clear",
          forumBindings: Object.entries(fb).filter(([k]) => !k.startsWith("forum:")).map(([agent, forum]) => ({ agent, forum })),
        });
      },
    });

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
        return ok(readTranscript(params.sessionKey, params.limit, params.agentId));
      },
    });

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
        return ok(killSession(params.sessionKey, params.agentId, params.deleteFromStore));
      },
    });

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
        return ok(linkSession(params.sessionKey, params.threadId, params.agentId));
      },
    });

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
        return ok(unlinkSession(params.sessionKey, params.agentId));
      },
    });

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
        return ok(focusThread(params.threadId, params.sessionKey, params.agentId));
      },
    });

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
        return ok(unfocusThread(params.threadId));
      },
    });

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
          return ok(await wakeSession(_runtime, sessionKey, message, deliver, timeoutMs));
        } catch (e) {
          return ok({ ok: false, sessionKey, error: e.message, timestamp: new Date().toISOString() });
        }
      },
    });

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
        return ok(bootstrapSession(params.agentId, params.threadId, params.sessionKey));
      },
    });

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
          return ok({ ok: true, threadId, name: result.name, archived: result.thread_metadata?.archived, locked: result.thread_metadata?.locked, tags: result.applied_tags });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

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
          return ok({ ok: true, threadId, name: result.name, archived: result.thread_metadata?.archived, locked: result.thread_metadata?.locked, tags: result.applied_tags });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_get_thread",
      description: "[debug] Get full thread state: Discord metadata + session store data combined.",
      parameters: {
        type: "object",
        properties: { threadId: { type: "string", description: "Discord thread ID" } },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId } = params;
        try {
          const ch = await getChannel(threadId);
          const parentId = ch.parent_id;
          let tagMap = {};
          try { for (const t of await getForumTags(parentId)) tagMap[t.id] = t.name; } catch {}

          const sessions = findSessionsForThread(threadId).map(m => formatSession(m.key, m, m.agentId));
          const tb = loadThreadBindings();
          const fb = getForumBindings();

          return ok({
            threadId, name: ch.name, parentId, parentName: null,
            forumAgent: fb[`forum:${parentId}`] || null,
            archived: ch.thread_metadata?.archived || false,
            locked: ch.thread_metadata?.locked || false,
            tags: (ch.applied_tags || []).map(id => ({ id, name: tagMap[id] || "unknown" })),
            messageCount: ch.message_count || 0, memberCount: ch.member_count || 0,
            createdAt: ch.thread_metadata?.create_timestamp,
            autoArchiveDuration: ch.thread_metadata?.auto_archive_duration,
            sessionCount: sessions.length, sessions,
            focused: tb.bindings?.[threadId] || null,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

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
        return ok(await scanBoard(params?.mindset, params?.status || "all"));
      },
    });

    api.registerTool({
      name: "_ms_post_to_thread",
      description: "[debug] Post a message to a Discord thread. Supports plain text and mentions. Set status=true for a styled status block.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          content: { type: "string", description: "Message text (markdown ok)" },
          silent: { type: "boolean", description: "Suppress notification. Default: false" },
          status: { type: "boolean", description: "Render as a styled status block (component container). Default: false" },
          accentColor: { type: "string", description: "Hex color for status block. Default: '#5865F2' (blurple)" },
        },
        required: ["threadId", "content"],
      },
      async execute(_id, params) {
        const { threadId, content, silent = false, status = false } = params;
        try {
          const msg = status ? await postStyledMessage(threadId, content) : await postPlainMessage(threadId, content, silent);
          return ok({ ok: true, threadId, messageId: msg.id, rendered: status ? "status" : "plain" });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_post_components",
      description: "[debug] Post a rich Discord components v2 message to a thread. Container with accent color, text blocks, section+button.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          accentColor: { type: "string", description: "Container accent color hex (e.g. '#2ecc71')" },
          blocks: {
            type: "array",
            description: "Array of block objects: {type:'text',text:'...'} or {type:'section',text:'...',buttonLabel:'...',buttonStyle:'success|danger|secondary|primary'}",
          },
        },
        required: ["threadId", "blocks"],
      },
      async execute(_id, params) {
        const { threadId, accentColor, blocks = [] } = params;
        try {
          const components = [];
          for (const block of blocks) {
            if (block.type === "text") {
              components.push({ type: 10, content: block.text });
            } else if (block.type === "section") {
              const section = { type: 9, components: [{ type: 10, content: block.text }] };
              if (block.buttonLabel) {
                const styleMap = { primary: 1, secondary: 2, success: 3, danger: 4 };
                section.accessory = { type: 2, style: styleMap[block.buttonStyle] || 2, label: block.buttonLabel, custom_id: `ms_btn_${threadId}_${Date.now()}` };
              }
              components.push(section);
            } else if (block.type === "separator") {
              components.push({ type: 14 });
            }
          }
          const container = { type: 17, components };
          if (accentColor) container.accent_color = parseInt(accentColor.replace("#", ""), 16);

          const msg = await discordApi("POST", `/channels/${threadId}/messages`, { components: [container], flags: 32768 });
          return ok({ ok: true, threadId, messageId: msg.id, componentCount: components.length });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_edit_message",
      description: "[debug] Edit a message in a Discord thread.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread/channel ID" },
          messageId: { type: "string", description: "Message ID to edit" },
          content: { type: "string", description: "New message text" },
        },
        required: ["threadId", "messageId", "content"],
      },
      async execute(_id, params) {
        try {
          const msg = await discordApi("PATCH", `/channels/${params.threadId}/messages/${params.messageId}`, { content: params.content });
          return ok({ ok: true, messageId: msg.id, edited: msg.edited_timestamp });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_delete_message",
      description: "[debug] Delete a message from a Discord thread.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread/channel ID" },
          messageId: { type: "string", description: "Message ID to delete" },
        },
        required: ["threadId", "messageId"],
      },
      async execute(_id, params) {
        try {
          await discordApi("DELETE", `/channels/${params.threadId}/messages/${params.messageId}`);
          return ok({ ok: true, deleted: params.messageId });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_react",
      description: "[debug] Add a reaction to a message in a Discord thread.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread/channel ID" },
          messageId: { type: "string", description: "Message ID to react to" },
          emoji: { type: "string", description: "Emoji (e.g. '✅', '👀', '🔥')" },
        },
        required: ["threadId", "messageId", "emoji"],
      },
      async execute(_id, params) {
        try {
          const encoded = encodeURIComponent(params.emoji);
          await fetch(`https://discord.com/api/v10/channels/${params.threadId}/messages/${params.messageId}/reactions/${encoded}/@me`, {
            method: "PUT", headers: { Authorization: `Bot ${getDiscordToken()}` },
          });
          return ok({ ok: true, messageId: params.messageId, emoji: params.emoji });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_read_thread",
      description: "[debug] Read recent messages from a Discord thread.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          limit: { type: "number", description: "Max messages (1-100, default 20)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        try {
          const messages = await readThreadMessages(params.threadId, params.limit);
          return ok({ threadId: params.threadId, count: messages.length, messages });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "_ms_patch_session",
      description: "[debug] Patch arbitrary fields on a session entry. Use for model override, status, etc.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to patch" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all." },
          patch: { type: "object", description: "Fields to merge into the session entry (e.g. {model: 'claude-sonnet-4-20250514', status: 'idle'})" },
        },
        required: ["sessionKey", "patch"],
      },
      async execute(_id, params) {
        return ok(patchSessionFields(params.sessionKey, params.patch, params.agentId));
      },
    });

    api.registerTool({
      name: "_ms_reset_session",
      description: "[debug] Reset a session: delete transcript file, reset token counts, keep deliveryContext and binding.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key to reset" },
          agentId: { type: "string", description: "Agent ID. If omitted, searches all." },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        return ok(resetSession(params.sessionKey, params.agentId));
      },
    });

    api.registerTool({
      name: "_ms_thread_vs_session",
      description: "[debug] Compare thread messages with session transcript side by side. Shows gaps, mismatches, and routing issues.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          limit: { type: "number", description: "Max messages to compare (default 20)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId, limit = 20 } = params;
        const clamp = Math.min(Math.max(limit, 1), 50);

        let threadMessages;
        try { threadMessages = await readThreadMessages(threadId, clamp); }
        catch (e) { return ok({ error: `Can't read thread: ${e.message}` }); }

        const sessions = findSessionsForThread(threadId);
        const sessionTranscripts = sessions.map(sess => {
          if (!sess.sessionFile) return { agentId: sess.agentId, key: sess.key, status: sess.status || "unknown", totalTokens: sess.totalTokens || 0, messages: [], note: "no transcript file" };
          const t = readTranscript(sess.key, clamp, sess.agentId);
          return { agentId: sess.agentId, key: sess.key, status: sess.status || "unknown", totalTokens: sess.totalTokens || 0, messageCount: t.showing || 0, messages: t.messages || [], ...(t.error ? { error: t.error } : {}) };
        });

        const botMessages = threadMessages.filter(m => m.isBot);
        const humanMessages = threadMessages.filter(m => !m.isBot);
        const activeAgents = sessionTranscripts.filter(s => s.messageCount > 0).map(s => s.agentId);

        const analysis = {
          threadMessageCount: threadMessages.length, sessionCount: sessions.length,
          sessionsWithTranscript: sessionTranscripts.filter(s => s.messageCount > 0).length,
          sessionsEmpty: sessionTranscripts.filter(s => s.messageCount === 0 || s.note).length,
          humanMessagesInThread: humanMessages.length, botMessagesInThread: botMessages.length,
          activeAgents,
        };
        if (sessions.length === 0) analysis.issue = "No sessions found for this thread";
        else if (activeAgents.length === 0) analysis.issue = "Sessions exist but none have transcripts";
        else if (activeAgents.length > 1) analysis.issue = `Multiple agents processed this thread: ${activeAgents.join(", ")}`;

        return ok({ threadId, analysis, thread: { count: threadMessages.length, messages: threadMessages }, sessions: sessionTranscripts, timestamp: new Date().toISOString() });
      },
    });

    api.registerTool({
      name: "_ms_read_agent_workspace",
      description: "[debug] Read a file from an agent's workspace directory. Use to inspect SOUL.md, IDENTITY.md, skills.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID" },
          file: { type: "string", description: "Relative path within workspace (e.g. 'SOUL.md', 'IDENTITY.md'). Default: 'SOUL.md'" },
          maxLines: { type: "number", description: "Max lines to return. Default: 30." },
        },
        required: ["agentId"],
      },
      async execute(_id, params) {
        const { agentId, file = "SOUL.md", maxLines = 30 } = params;
        const config = loadConfig();
        const agentConfig = (config.agents?.list || []).find(a => a?.id === agentId);
        const paths = [
          ...(agentConfig?.workspace ? [join(agentConfig.workspace, file)] : []),
          join(OPENCLAW_HOME, `workspace-${agentId}`, file),
          join(AGENTS_DIR, agentId, "workspace", file),
          join(AGENTS_DIR, agentId, "agent", "workspace", file),
          join(OPENCLAW_HOME, "workspace", file),
        ];
        for (const p of paths) {
          try {
            const content = readFileSync(p, "utf-8");
            const lines = content.split("\n").slice(0, maxLines);
            return ok({ ok: true, agentId, file, path: p, lines: lines.length, content: lines.join("\n") });
          } catch {}
        }
        return ok({ ok: false, agentId, file, error: "File not found in any workspace path" });
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L2: Composed operations (ms_*) — thin wrappers            ║
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
      name: "ms_post_as",
      description: "Invoke a tool as a specific session via Gateway API. For posting interactive components owned by a mindset session, or any cross-session tool call.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Target session key (e.g. 'agent:sysadmin:discord:channel:12345')" },
          tool: { type: "string", description: "Tool name to invoke (e.g. 'message')" },
          args: { type: "object", description: "Tool arguments" },
        },
        required: ["sessionKey", "tool", "args"],
      },
      async execute(_id, params) {
        try {
          const result = await invokeToolAsSession(params.sessionKey, params.tool, params.args);
          return ok({ ok: true, sessionKey: params.sessionKey, tool: params.tool, result: result?.result || result });
        } catch (e) {
          return ok({ ok: false, sessionKey: params.sessionKey, tool: params.tool, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "ms_ensure_session",
      description: "Idempotent: ensure a thread has a working session with correct deliveryContext. Creates if missing, patches if wrong.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID that should own the session" },
          threadId: { type: "string", description: "Discord thread ID" },
        },
        required: ["agentId", "threadId"],
      },
      async execute(_id, params) {
        return ok({ ok: true, ...ensureSession(params.agentId, params.threadId) });
      },
    });

    api.registerTool({
      name: "ms_ensure_closed",
      description: "Idempotent: ensure a thread is fully closed (archived+locked) and its session is killed.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Discord thread ID" },
          tagId: { type: "string", description: "Optional tag to apply (e.g. Done or Canceled tag ID)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        return ok({ ok: true, ...(await ensureClosed(params.threadId, params.tagId)) });
      },
    });

    api.registerTool({
      name: "ms_diff",
      description: "Find orphans: threads without sessions and sessions without threads. Checks all forums.",
      parameters: {
        type: "object",
        properties: { mindset: { type: "string", description: "Filter by agent ID. Omit for all." } },
      },
      async execute(_id, params) {
        const { mindset } = params || {};
        const guildId = getGuildId();
        if (!guildId) return ok({ ok: false, error: "No guild configured" });

        const bindings = getConfigBindings(mindset);
        const orphanThreads = [], orphanSessions = [];

        for (const binding of bindings) {
          const forumId = binding.match.peer.id;
          const agentId = binding.agentId;
          const threadIds = new Set();
          try {
            const { active, archived } = await listForumThreads(guildId, forumId);
            for (const t of [...active, ...archived]) {
              threadIds.add(t.id);
              if (!t.thread_metadata?.archived) {
                const store = readStore(agentId);
                if (!store[sessionKeyFor(agentId, t.id)]) {
                  orphanThreads.push({ agentId, threadId: t.id, name: t.name, messageCount: t.message_count || 0 });
                }
              }
            }
          } catch { continue; }

          const store = readStore(agentId);
          for (const [key, v] of Object.entries(store)) {
            if (!key.includes("discord:channel:")) continue;
            const tid = threadIdFromKey(key);
            if (!tid || tid === forumId) continue;
            if (v.deliveryContext?.threadId && !threadIds.has(v.deliveryContext.threadId)) {
              orphanSessions.push({ agentId, key, threadId: v.deliveryContext.threadId, status: v.status, totalTokens: v.totalTokens || 0 });
            }
          }
        }

        return ok({ ok: true, orphanThreads: { count: orphanThreads.length, items: orphanThreads }, orphanSessions: { count: orphanSessions.length, items: orphanSessions }, timestamp: new Date().toISOString() });
      },
    });

    api.registerTool({
      name: "ms_recover",
      description: "Find zombie/aborted sessions across all agents. Optionally re-wake them. For restart recovery.",
      parameters: {
        type: "object",
        properties: {
          wake: { type: "boolean", description: "If true, re-wake recoverable sessions. Default: false (dry run)." },
          mindset: { type: "string", description: "Filter by agent ID. Omit for all." },
          maxAge: { type: "number", description: "Only recover sessions updated within this many hours. Default: 24." },
        },
      },
      async execute(_id, params) {
        const { wake = false, mindset, maxAge = 24 } = params || {};
        const cutoff = Date.now() - (maxAge * 60 * 60 * 1000);
        const agents = mindset ? [mindset] : listAgentIds();
        const fb = getForumBindings();
        const candidates = [];

        for (const agentId of agents) {
          if (!fb[agentId]) continue;
          const store = readStore(agentId);
          for (const [key, v] of Object.entries(store)) {
            if (!key.includes("discord:channel:")) continue;
            if ((v.updatedAt || 0) < cutoff) continue;
            const needs = [];
            if (v.abortedLastRun) needs.push("aborted");
            if (v.status === "running" && v.updatedAt && (Date.now() - v.updatedAt) > 10 * 60 * 1000) needs.push("zombie");
            if (needs.length === 0) continue;
            candidates.push({
              agentId, key, threadId: threadIdFromKey(key), status: v.status, needs,
              totalTokens: v.totalTokens || 0, updatedAgo: timeAgo(v.updatedAt),
              hasDelivery: v.deliveryContext?.channel === "discord" && !!v.deliveryContext?.to,
              hasTranscript: !!v.sessionFile,
            });
          }
        }

        const wakeResults = [];
        if (wake) {
          for (const c of candidates) {
            if (!c.hasDelivery) { wakeResults.push({ key: c.key, skipped: true, reason: "no discord delivery context" }); continue; }
            try {
              const r = await wakeSession(_runtime, c.key, "You were interrupted by a gateway restart. Review your last conversation and continue where you left off. If you were waiting for input, say so.", true, 0);
              wakeResults.push({ key: c.key, ok: true, runId: r.runId });
            } catch (e) {
              wakeResults.push({ key: c.key, ok: false, error: e.message });
            }
          }
        }

        return ok({ ok: true, dryRun: !wake, candidateCount: candidates.length, candidates, ...(wake ? { wakeResults } : {}), timestamp: new Date().toISOString() });
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L3: Coordination primitives (ms3_*)                       ║
    // ╚══════════════════════════════════════════════════════════════╝

    api.registerTool({
      name: "ms3_create_thread_session",
      description: "Atomic: create a Discord forum thread with a bootstrapped session. Returns thread ID, session key, and posted message ID.",
      parameters: {
        type: "object",
        properties: {
          forumId: { type: "string", description: "Forum channel ID to create thread in" },
          agentId: { type: "string", description: "Agent ID to own the session" },
          threadName: { type: "string", description: "Thread name" },
          message: { type: "string", description: "Initial message to post in thread" },
          tagId: { type: "string", description: "Optional tag to apply" },
        },
        required: ["forumId", "agentId", "threadName", "message"],
      },
      async execute(_id, params) {
        const { forumId, agentId, threadName, message, tagId } = params;
        const result = { steps: {}, timestamp: new Date().toISOString() };

        // Step 1: Create thread
        let threadId;
        try {
          const body = { name: threadName, message: { content: message } };
          if (tagId) body.applied_tags = [tagId];
          const thread = await discordApi("POST", `/channels/${forumId}/threads`, body);
          threadId = thread.id;
          result.threadId = threadId;
          result.steps.thread = { ok: true, id: threadId };
        } catch (e) {
          result.steps.thread = { ok: false, error: e.message };
          return ok({ ok: false, ...result });
        }

        // Step 2: Bootstrap session via shared function
        try {
          const sessionResult = ensureSession(agentId, threadId);
          result.sessionKey = sessionResult.sessionKey;
          result.steps.session = { ok: true, key: sessionResult.sessionKey, action: sessionResult.action };
        } catch (e) {
          try { await patchThread(threadId, { archived: true, locked: true }); } catch {}
          result.steps.session = { ok: false, error: e.message };
          return ok({ ok: false, ...result });
        }

        return ok({ ok: true, ...result });
      },
    });

    api.registerTool({
      name: "ms3_gate",
      description: "Post an interactive gate (buttons/select) to a thread as a session. Click routes to session. Returns message ID.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session to own the interaction" },
          threadId: { type: "string", description: "Thread to post in" },
          text: { type: "string", description: "Gate prompt text" },
          buttons: { type: "array", description: "Array of {label, style, value?} objects. Styles: primary, secondary, success, danger." },
          allowedUsers: { type: "array", description: "Discord user IDs who can interact. Omit for anyone." },
          reusable: { type: "boolean", description: "Allow multiple clicks. Default: false." },
        },
        required: ["sessionKey", "threadId", "text", "buttons"],
      },
      async execute(_id, params) {
        const { sessionKey, threadId, text, buttons, allowedUsers, reusable = false } = params;
        try {
          const componentButtons = buttons.map(b => ({
            label: b.label, style: b.style || "primary",
            ...(allowedUsers ? { allowedUsers } : {}),
          }));
          const result = await invokeToolAsSession(sessionKey, "message", {
            action: "send", channel: "discord", target: `channel:${threadId}`,
            components: { reusable, text, blocks: [{ type: "actions", buttons: componentButtons }] },
          });
          const details = result?.result?.details || result?.result;
          return ok({ ok: true, threadId, sessionKey, messageId: details?.result?.messageId || null, buttonCount: buttons.length });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "ms3_fan_out",
      description: "Apply an operation to all open threads in a forum (or all forums). Returns results per thread.",
      parameters: {
        type: "object",
        properties: {
          mindset: { type: "string", description: "Agent ID to filter. Omit for all." },
          operation: { type: "string", description: "What to do: 'wake', 'close', 'post'. " },
          message: { type: "string", description: "For wake/post: the message to send." },
          tagId: { type: "string", description: "For close: tag to apply." },
          dryRun: { type: "boolean", description: "If true, list matches but don't act. Default: true." },
        },
        required: ["operation"],
      },
      async execute(_id, params) {
        const { mindset, operation, message, tagId, dryRun = true } = params;
        const guildId = getGuildId();
        if (!guildId) return ok({ ok: false, error: "No guild" });

        const bindings = getConfigBindings(mindset);
        const targets = [];
        for (const binding of bindings) {
          const forumId = binding.match.peer.id;
          const agentId = binding.agentId;
          try {
            const { active } = await listForumThreads(guildId, forumId, false);
            for (const t of active) targets.push({ agentId, forumId, threadId: t.id, name: t.name, sessionKey: sessionKeyFor(agentId, t.id) });
          } catch {}
        }

        if (dryRun) return ok({ ok: true, dryRun: true, operation, matchCount: targets.length, targets });

        const results = [];
        for (const t of targets) {
          try {
            if (operation === "wake") {
              const r = await wakeSession(_runtime, t.sessionKey, message || "Check in — what's your status?", true, 0);
              results.push({ threadId: t.threadId, ok: true, runId: r.runId });
            } else if (operation === "close") {
              await ensureClosed(t.threadId, tagId);
              results.push({ threadId: t.threadId, ok: true, action: "closed" });
            } else if (operation === "post") {
              await postPlainMessage(t.threadId, message || "Ping.");
              results.push({ threadId: t.threadId, ok: true, action: "posted" });
            } else {
              results.push({ threadId: t.threadId, ok: false, error: `Unknown operation: ${operation}` });
            }
          } catch (e) {
            results.push({ threadId: t.threadId, ok: false, error: e.message });
          }
        }
        return ok({ ok: true, dryRun: false, operation, resultCount: results.length, results });
      },
    });

    api.registerTool({
      name: "ms3_activity_check",
      description: "Find threads with no session activity in N hours. Returns stale threads that may need attention.",
      parameters: {
        type: "object",
        properties: {
          mindset: { type: "string", description: "Agent ID to filter. Omit for all." },
          staleHours: { type: "number", description: "Hours of inactivity to consider stale. Default: 4." },
        },
      },
      async execute(_id, params) {
        const { mindset, staleHours = 4 } = params || {};
        const cutoff = Date.now() - (staleHours * 60 * 60 * 1000);
        const guildId = getGuildId();
        if (!guildId) return ok({ ok: false, error: "No guild" });

        const bindings = getConfigBindings(mindset);
        const stale = [], active = [];

        for (const binding of bindings) {
          const forumId = binding.match.peer.id;
          const agentId = binding.agentId;
          try {
            const { active: threads } = await listForumThreads(guildId, forumId, false);
            const store = readStore(agentId);
            for (const t of threads) {
              const session = store[sessionKeyFor(agentId, t.id)];
              const lastActivity = session?.updatedAt || 0;
              const entry = { agentId, threadId: t.id, name: t.name, hasSession: !!session, sessionStatus: session?.status || null, lastActivity: lastActivity ? timeAgo(lastActivity) : "never", lastActivityMs: lastActivity };
              (lastActivity < cutoff || !session ? stale : active).push(entry);
            }
          } catch {}
        }

        return ok({ ok: true, staleHours, staleCount: stale.length, activeCount: active.length, stale, active, timestamp: new Date().toISOString() });
      },
    });

    api.registerTool({
      name: "ms3_transition",
      description: "Atomic state transition: rename thread + set tag + post status message. Reports success per step.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread ID" },
          name: { type: "string", description: "New thread name (optional)" },
          tagId: { type: "string", description: "Tag to apply (optional)" },
          message: { type: "string", description: "Status message to post (optional)" },
          sessionKey: { type: "string", description: "Session to post as (optional — uses raw API if omitted)" },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId, name, message, sessionKey } = params;
        let { tagId } = params;
        const steps = {};

        if (tagId) { try { tagId = await resolveTagId(tagId, threadId); } catch {} }

        if (name || tagId) {
          try {
            const patch = {};
            if (name) patch.name = name;
            if (tagId) patch.applied_tags = [tagId];
            const ch = await patchThread(threadId, patch);
            steps.thread = { ok: true, name: ch.name, tags: ch.applied_tags };
          } catch (e) {
            steps.thread = { ok: false, error: e.message };
          }
        }

        if (message) {
          try {
            if (sessionKey) {
              await invokeToolAsSession(sessionKey, "message", { action: "send", channel: "discord", target: `channel:${threadId}`, message });
              steps.message = { ok: true, via: "session" };
            } else {
              await postStyledMessage(threadId, message, "status");
              steps.message = { ok: true, via: "status-block" };
            }
          } catch (e) {
            steps.message = { ok: false, error: e.message };
          }
        }

        return ok({ ok: Object.values(steps).every(s => s.ok), threadId, steps });
      },
    });

    api.registerTool({
      name: "ms3_silent_query",
      description: "Send a message to a session and get the response without posting to Discord. For orchestrator queries.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session to query" },
          message: { type: "string", description: "Question to ask the session" },
          timeoutMs: { type: "number", description: "Max wait time in ms. Default: 60000." },
        },
        required: ["sessionKey", "message"],
      },
      async execute(_id, params) {
        try {
          return ok(await silentQuery(_runtime, params.sessionKey, params.message, params.timeoutMs));
        } catch (e) {
          return ok({ ok: false, sessionKey: params.sessionKey, error: e.message });
        }
      },
    });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L4: Agent-facing tools — compose L2/L3, never reimplement ║
    // ╚══════════════════════════════════════════════════════════════╝

    api.registerTool({
      name: "delegate",
      description: "Give work to a mindset. Creates a task thread in the right forum, sets up the session, posts the brief, and mentions the human. The mindset picks it up autonomously. You orchestrate — you don't implement.",
      parameters: {
        type: "object",
        properties: {
          mindset: { type: "string", description: "Which mindset gets the work (e.g. 'sysadmin', 'design-engineer', 'pa', 'wordware')" },
          title: { type: "string", description: "Task title — short, descriptive" },
          brief: { type: "string", description: "What needs to be done. Be specific. The mindset starts from this." },
        },
        required: ["mindset", "title", "brief"],
      },
      async execute(_id, params) {
        const { mindset, title, brief } = params;

        // Resolve mindset → forum
        const fb = getForumBindings();
        const forumId = fb[mindset];
        if (!forumId) return ok({ ok: false, error: `Unknown mindset: ${mindset}. Available: ${Object.keys(fb).filter(k => !k.startsWith("forum:")).join(", ")}` });

        const humanId = getHumanId();
        const mention = humanId ? `<@${humanId}>` : "";

        // Create thread
        let threadId;
        try {
          const thread = await discordApi("POST", `/channels/${forumId}/threads`, { name: title, message: { content: `${mention} ${brief}` } });
          threadId = thread.id;
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }

        // Ensure session (uses shared function — idempotent)
        const sessionResult = ensureSession(mindset, threadId);

        // Wake the session
        let wakeResult = null;
        try { wakeResult = await wakeSession(_runtime, sessionResult.sessionKey, brief, true, 0); }
        catch (e) { wakeResult = { ok: false, error: e.message }; }

        return ok({ ok: true, mindset, threadId, sessionKey: sessionResult.sessionKey, title, forumId, wakeResult });
      },
    });

    api.registerTool({
      name: "board",
      description: "See everything. Every active thread across all mindsets — status, session health, staleness. Your nervous system. Call this to know what's happening.",
      parameters: {
        type: "object",
        properties: { mindset: { type: "string", description: "Filter to one mindset. Omit for the full board." } },
      },
      async execute(_id, params) {
        // Uses scanBoard (same as _ms_board) but returns only open threads in a compact format
        const result = await scanBoard(params?.mindset, "open");
        if (!result.ok) return ok(result);

        const mindsets = result.forums
          .filter(f => f.threads?.length > 0)
          .map(f => ({
            mindset: f.agentId,
            threads: f.threads.map(t => ({
              id: t.id, name: t.name, tags: t.tags,
              messages: t.messageCount, hasSession: t.hasSession,
              status: t.sessionStatus || "no session",
              tokens: t.sessionTokens, lastActive: t.sessionUpdated || "never",
            })),
          }));

        return ok({ totalThreads: mindsets.reduce((sum, m) => sum + m.threads.length, 0), mindsets });
      },
    });

    api.registerTool({
      name: "query",
      description: "Ask a mindset a question without posting to their thread. The answer comes back to you silently. For status checks and coordination — not for giving instructions.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "The session to query (from the board)" },
          question: { type: "string", description: "What to ask" },
        },
        required: ["sessionKey", "question"],
      },
      async execute(_id, params) {
        try {
          return ok(await silentQuery(_runtime, params.sessionKey, params.question));
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "nudge",
      description: "Wake a stale session. For threads that have gone quiet. The mindset gets a push to continue or report status.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "The session to nudge (from the board)" },
          message: { type: "string", description: "What to tell them. Default: 'Check in — what's your status on this?'" },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        try {
          const result = await wakeSession(_runtime, params.sessionKey, params.message || "Check in — what's your status on this?", true, 0);
          return ok({ ok: true, sessionKey: params.sessionKey, runId: result.runId });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "close",
      description: "Shut down a task. Archives the thread, kills the session. Terminal state — the work is either Done or Canceled. Use after reviewing completion.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to close" },
          tag: { type: "string", description: "Final status: 'Done' or 'Canceled'. Resolves to the right tag automatically." },
        },
        required: ["threadId"],
      },
      async execute(_id, params) {
        const { threadId, tag } = params;
        let tagId = null;
        if (tag) { try { tagId = await resolveTagId(tag, threadId); } catch {} }

        // Uses ensureClosed (same as ms_ensure_closed)
        const result = await ensureClosed(threadId, tagId);
        return ok({ ok: true, threadId, tag: tag || "none", ...result });
      },
    });

    logger.info("openclaw-mindsets: registered all tools");
  },
};
