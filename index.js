/**
 * openclaw-mindsets — OpenClaw extension for Discord.
 * Multiple agents acting as one.
 *
 * 9 tools:
 *   triage    — ephemeral routing agent (auto-routes inbound messages)
 *   topic     — open a new thread in a mindset
 *   board     — see everything active
 *   query     — ask a mindset silently
 *   continue  — follow up on a quiet thread
 *   close     — shut down a task
 *   health    — system health on heartbeat
 *   inspect   — deep dive on one thread
 *   recover   — restart recovery
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
const AGENTS_DIR = join(OPENCLAW_HOME, "agents");
const THREAD_BINDINGS_PATH = join(OPENCLAW_HOME, "discord", "thread-bindings.json");

// Module-level logger — set in register(), used by shared functions outside register()
let _logger = null;

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
  if (_logger) _logger.debug(`discordApi: ${method} ${path}`);
  const res = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    if (_logger) _logger.warn(`discordApi: ${method} ${path} failed ${res.status}`, { body: text.substring(0, 200) });
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  if (method === "DELETE" || res.status === 204) return {};
  return res.json();
}

// ════════════════════════════════════════════════════════════════════
//  SHARED FUNCTIONS — the library, reusable by all layers
// ════════════════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────────────

function mindsetLabel(id) {
  const labels = {
    sysadmin: "Sysadmin Mindset",
    "design-engineer": "Design Engineer Mindset",
    pa: "PA Mindset",
    wordware: "Wordware Mindset",
    main: "Main",
  };
  return labels[id] || id;
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
      if (_logger) _logger.debug(`ensureSession: verified existing session`, { agentId, threadId });
      return { action: "verified", sessionKey, agentId, threadId,
        status: existing.status || "unknown", totalTokens: existing.totalTokens || 0,
        hasTranscript: !!existing.sessionFile };
    }
    // Patch wrong DC
    if (_logger) _logger.info(`ensureSession: patching wrong deliveryContext`, { agentId, threadId });
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
  if (_logger) _logger.info(`ensureSession: creating new session`, { agentId, threadId, sessionKey });
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
  if (_logger) _logger.info(`ensureClosed: closing thread`, { threadId, tagId });
  const results = { threadId, steps: {} };

  try {
    const patch = { archived: true, locked: true };
    if (tagId) patch.applied_tags = [tagId];
    const ch = await patchThread(threadId, patch);
    if (_logger) _logger.info(`ensureClosed: thread archived+locked`, { threadId });
    results.steps.thread = { ok: true, archived: ch.thread_metadata?.archived, locked: ch.thread_metadata?.locked };
  } catch (e) {
    if (_logger) _logger.warn(`ensureClosed: failed to archive thread`, { threadId, error: e.message });
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
  if (_logger) _logger.info(`ensureClosed: killed ${killed.length} sessions`, { threadId });
  results.steps.sessions = { ok: true, killed: killed.length, details: killed };

  // Remove all users from thread so it disappears from sidebars
  try {
    const config = loadConfig();
    const guilds = config.channels?.discord?.guilds || {};
    const guildId = Object.keys(guilds)[0];
    const users = guilds[guildId]?.users || [];
    for (const userId of users) {
      try { await discordApi("DELETE", `/channels/${threadId}/thread-members/${userId}`); } catch {}
    }
    if (_logger) _logger.debug(`ensureClosed: unfollowed ${users.length} users`, { threadId });
    results.steps.unfollowed = { ok: true, users: users.length };
  } catch (e) {
    if (_logger) _logger.warn(`ensureClosed: failed to unfollow users`, { threadId, error: e.message });
    results.steps.unfollowed = { ok: false, error: e.message };
  }

  return results;
}

/** Kill a single session. Returns result object. */
function killSession(sessionKey, agentId, deleteFromStore = false) {
  if (_logger) _logger.info(`killSession: killing session`, { sessionKey, deleteFromStore });
  const found = findSession(sessionKey, agentId);
  if (!found) {
    if (_logger) _logger.warn(`killSession: session not found`, { sessionKey });
    return { ok: false, error: "Session not found", sessionKey };
  }

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
  if (_logger) _logger.info(`killSession: done`, { sessionKey, action: deleteFromStore ? "deleted" : "marked-done" });

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
  if (_logger) _logger.info(`bootstrapSession: bootstrapping`, { agentId, threadId, customKey });
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
  if (_logger) _logger.info(`resetSession: resetting`, { sessionKey });
  const found = findSession(sessionKey, agentId);
  if (!found) {
    if (_logger) _logger.warn(`resetSession: session not found`, { sessionKey });
    return { ok: false, error: "Session not found", sessionKey };
  }

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

// ── Typing indicator (interval-based) ──────────────────────────────
const _typingLoops = new Map(); // threadId → { interval, timeout }

async function triggerTyping(threadId) {
  try { await discordApi("POST", `/channels/${threadId}/typing`); }
  catch (e) { if (_logger) _logger.debug(`triggerTyping: failed for ${threadId}: ${e.message}`); }
}

function startTypingLoop(threadId, maxMs = 120000) {
  // Don't stack loops for the same thread
  stopTypingLoop(threadId);
  // Fire immediately
  triggerTyping(threadId);
  // Then every 8s (Discord typing expires at 10s)
  const interval = setInterval(() => triggerTyping(threadId), 8000);
  // Safety cap — auto-clear after maxMs
  const timeout = setTimeout(() => stopTypingLoop(threadId), maxMs);
  _typingLoops.set(threadId, { interval, timeout });
  if (_logger) _logger.debug(`startTypingLoop: started for ${threadId} (max ${maxMs}ms)`);
}

function stopTypingLoop(threadId) {
  const loop = _typingLoops.get(threadId);
  if (!loop) return;
  clearInterval(loop.interval);
  clearTimeout(loop.timeout);
  _typingLoops.delete(threadId);
  if (_logger) _logger.debug(`stopTypingLoop: stopped for ${threadId}`);
}

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
  description: "OpenClaw extension for Discord. Multiple agents acting as one.",
  register(api) {
    const runtime = api.runtime;
    const logger = api.logger;
    _logger = logger; // Set module-level logger for shared functions
    logger.info("openclaw-mindsets: registering");

    // ═══════════════════════════════════════════════════════════════════
    // /mindsets/wake — THE MULTI-TURN SESSION WAKE ENDPOINT
    //
    // DO NOT CHANGE THIS WITHOUT UNDERSTANDING WHY IT EXISTS.
    //
    // This is the result of 6+ hours of debugging. Every other approach
    // was tested and failed:
    //
    //   subagent.run        → works for turn 1, SILENTLY FAILS on turn 2+
    //   sessions_send       → delivers reply to SENDER, not to Discord thread
    //   sessions_send via   → same problem
    //     /tools/invoke
    //   execSync from tool  → blocks the gateway, causes timeout
    //     handler
    //   spawn without HTTP  → detached process can't find openclaw binary
    //     endpoint
    //
    // THE WORKING PATTERN:
    //   1. Tool handler calls fetch("http://localhost/mindsets/wake")
    //   2. This HTTP handler spawns `openclaw gateway call agent` as a
    //      DETACHED BACKGROUND PROCESS
    //   3. The background process connects to the gateway WebSocket
    //   4. The gateway runs the agent turn with deliver:true + channel:discord
    //   5. Reply appears in the Discord thread
    //
    // This is the same code path as a user typing in a thread. Native.
    // The HTTP endpoint exists solely to break the concurrency deadlock
    // between the tool handler and the gateway agent method.
    //
    // Full path to openclaw binary is REQUIRED (/opt/homebrew/bin/openclaw)
    // because detached processes don't inherit PATH.
    // ═══════════════════════════════════════════════════════════════════
    api.registerHttpRoute({
      path: "/mindsets/wake",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          
          // Call the gateway agent method via the runtime
          const { execSync } = await import("node:child_process");
          const tmpFile = `/tmp/mindset-http-wake-${Date.now()}.json`;
          writeFileSync(tmpFile, JSON.stringify(body));
          
          // Fire and forget via background process
          const { spawn } = await import("node:child_process");
          const child = spawn("/opt/homebrew/bin/openclaw", [
            "gateway", "call", "agent", "--timeout", "30000", "--params", readFileSync(tmpFile, "utf-8"),
          ], { detached: true, stdio: "ignore" });
          child.unref();
          try { unlinkSync(tmpFile); } catch {}
          
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, status: "accepted" }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return true;
      },
    });

    // Per-turn context injection via before_prompt_build hook
    api.on("before_prompt_build", async () => {
      return { appendSystemContext: "STOP. REFOCUS. You manage forum threads. Your obsession is giving the user the right context session for whatever they need. Every message: does a thread already exist where this would be a natural continuation? Forward it there. If not, open one in the right forum. Each thread is a focused conversation under a mindset. You are the moderator — route, surface, close. All threads are you, use first person. Say 'let\'s discuss this in #sysadmin' not 'delegating to sysadmin agent'. NEVER edit files, run commands, or do work directly. ALWAYS open or continue a thread." };
    });

    // Boot notification removed — restart events are logged, not posted to Discord.

    // Runtime-dependent shared functions (must be inside register() for request scope)
    async function wakeSession(sessionKey, message, deliver = true, timeoutMs = 60000) {
      // ARCHITECTURE: Use gateway 'agent' RPC method — the ONLY reliable path for
      // multi-turn sessions that delivers replies to Discord threads.
      // subagent.run fails silently on existing sessions.
      // sessions_send delivers to sender, not thread.
      // gateway call agent + deliver:true + channel:discord + to:channel:<threadId>
      // = the same path as a user typing in the thread. Native. No hacks.
      const threadId = sessionKey.split("discord:channel:")[1]?.split(":")[0];
      logger.info("wakeSession: using gateway agent RPC", { sessionKey, threadId });
      
      try {
        const config = loadConfig();
        const gwToken = config.gateway?.auth?.token;
        const gwPort = config.gateway?.port || 18789;
        if (!gwToken) throw new Error("No gateway token");

        const params = {
          sessionKey,
          message,
          deliver,
          channel: "discord",
          to: `channel:${threadId}`,
          idempotencyKey: crypto.randomUUID(),
        };

        // Show typing indicator in the thread while the agent generates
        if (threadId) startTypingLoop(threadId);

        // Call our own /mindsets/wake HTTP endpoint which spawns the gateway
        // agent call as a background process. This avoids blocking.
        const res = await fetch(`http://127.0.0.1:${gwPort}/mindsets/wake`, {
          method: "POST",
          headers: { Authorization: `Bearer ${gwToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        const result = await res.json();
        logger.info("wakeSession: accepted via HTTP", { sessionKey, ok: result.ok });
        return { ok: result.ok, sessionKey, status: "accepted" };
      } catch (e) {
        logger.warn("wakeSession: failed", { sessionKey, error: e.message });
        return { ok: false, sessionKey, error: e.message };
      }
    }

    async function silentQuery(sessionKey, message, timeoutMs = 60000) {
      const { runId } = await runtime.subagent.run({
        sessionKey, message, deliver: false, idempotencyKey: crypto.randomUUID(),
      });
      try {
        const result = await runtime.subagent.waitForRun({ runId, timeoutMs });
        let reply = result?.reply || null;
        if (!reply) {
          try {
            const { messages } = await runtime.subagent.getSessionMessages({ sessionKey, limit: 3 });
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

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L1: Debug tools (_ms_*) — thin wrappers                   ║
    // ╚══════════════════════════════════════════════════════════════╝






    api.registerTool({
      name: "health",
      description: "System health. Zombies, orphans, conflicts, costs across all mindsets. Call on heartbeat.",
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
    }, { optional: true });


























    api.registerTool({
      name: "inspect",
      description: "Deep inspection of one thread. Messages + session state side by side.",
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
    }, { optional: true });


    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L2: Composed operations (ms_*) — thin wrappers            ║
    // ╚══════════════════════════════════════════════════════════════╝







    api.registerTool({
      name: "recover",
      description: "Restart recovery. Find sessions that died mid-turn and re-wake them. Dry run by default.",
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
              const r = await wakeSession(c.key, "You were interrupted by a gateway restart. Review your last conversation and continue where you left off. If you were waiting for input, say so.", true, 0);
              wakeResults.push({ key: c.key, ok: true, runId: r.runId });
            } catch (e) {
              wakeResults.push({ key: c.key, ok: false, error: e.message });
            }
          }
        }

        return ok({ ok: true, dryRun: !wake, candidateCount: candidates.length, candidates, ...(wake ? { wakeResults } : {}), timestamp: new Date().toISOString() });
      },
    }, { optional: true });

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L3: Coordination primitives (ms3_*)                       ║
    // ╚══════════════════════════════════════════════════════════════╝









    // ╔══════════════════════════════════════════════════════════════╗
    // ║  L4: Agent-facing tools — compose L2/L3, never reimplement ║
    // ╚══════════════════════════════════════════════════════════════╝

    // ═══ triage ════════════════════════════════════════════════════
    api.registerTool({
      name: "triage",
      description: "Route an inbound message. Reads the user's latest message, active threads, and mindset descriptions, then returns a structured routing decision: continue an existing thread OR open a new one. Call with no params — the tool gathers context itself. Execute the returned decision without second-guessing it.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional override: the user message to triage. If omitted, reads the latest from the main session transcript." },
        },
      },
      async execute(_id, params) {
        const startMs = Date.now();
        try {
          // 1. Gather user message — from param or main session transcript
          let userMessage = params.message;
          if (!userMessage) {
            const mainSessionKey = sessionKeyFor("main", "main");
            // Try reading transcript from main agent
            const transcript = readTranscript(mainSessionKey, 10, "main");
            if (transcript.found && transcript.messages) {
              const userMsgs = transcript.messages.filter(m => m.role === "user" && m.text);
              if (userMsgs.length) userMessage = userMsgs[userMsgs.length - 1].text;
            }
          }
          if (!userMessage) return ok({ ok: false, error: "No user message found. Pass `message` param or ensure main session has recent messages." });

          // 2. Load mindset descriptions from registry
          let mindsets = [];
          try {
            const regPath = join(OPENCLAW_HOME, "mindsets.json");
            const registry = JSON.parse(readFileSync(regPath, "utf-8"));
            mindsets = (registry.mindsets || []).filter(m => m.id !== "main").map(m => ({
              id: m.id, name: m.name, description: m.description,
              forumId: m.forumId, capabilities: m.capabilities || [],
            }));
          } catch (e) {
            // Fallback: derive from config bindings
            const fb = getForumBindings();
            for (const [key, val] of Object.entries(fb)) {
              if (!key.startsWith("forum:")) mindsets.push({ id: key, forumId: val, name: key, description: "", capabilities: [] });
            }
          }

          // 3. Scan active threads (board state)
          const board = await scanBoard();
          const activeThreads = [];
          if (board.ok) {
            for (const forum of board.forums) {
              for (const thread of (forum.threads || [])) {
                if (!thread.archived) {
                  activeThreads.push({
                    id: thread.id,
                    name: thread.name,
                    mindset: forum.agentId,
                    forumId: forum.forumId,
                    messageCount: thread.messageCount,
                    sessionStatus: thread.sessionStatus,
                    lastActivity: thread.sessionUpdated,
                    tags: thread.tags,
                  });
                }
              }
            }
          }

          // 4. Build system prompt for the ephemeral triage agent
          const systemPrompt = `You are a triage router. Given a user message, available mindsets, and active threads, decide the best routing.

RULES:
- If the message is a natural continuation of an existing open thread, route to that thread.
- If the message is a new topic, pick the best mindset and suggest a new thread.
- "main" is never a valid mindset target — always route to a specialist.
- Prefer continuing existing threads over creating new ones when the topic overlaps.
- Thread titles should be short (3-6 words), descriptive, action-oriented.
- The brief should be the user's message reframed as a clear task/question for the mindset.
- If the message is casual/conversational and doesn't need specialist work, return action "reply" — main handles it directly.
- If multiple threads could match, pick the most relevant one.

AVAILABLE MINDSETS:
${mindsets.map(m => `- ${m.id} (${m.name}): ${m.description}`).join("\n")}

ACTIVE THREADS:
${activeThreads.length ? activeThreads.map(t => `- [${t.mindset}] "${t.name}" (id:${t.id}, msgs:${t.messageCount}, status:${t.sessionStatus || "unknown"}, activity:${t.lastActivity || "unknown"})`).join("\n") : "(none open)"}

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):

For continuing an existing thread:
{"action":"continue","threadId":"<id>","sessionKey":"agent:<mindset>:discord:channel:<threadId>","message":"<brief for the mindset>","reason":"<1 sentence why>"}

For a new thread:
{"action":"new","mindset":"<id>","forumId":"<forumId>","title":"<short title>","brief":"<task description>","reason":"<1 sentence why>"}

For direct reply (no specialist needed):
{"action":"reply","reason":"<1 sentence why>"}`;

          // 5. Spawn ephemeral subagent
          const triageSessionKey = `agent:main:subagent:triage-${Date.now()}`;
          const { runId } = await runtime.subagent.run({
            sessionKey: triageSessionKey,
            message: `USER MESSAGE:\n${userMessage}`,
            systemPrompt,
            deliver: false,
            model: "anthropic/claude-sonnet-4-20250514",
            idempotencyKey: crypto.randomUUID(),
          });

          // 6. Wait for result
          const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 15000 });
          let reply = result?.reply || null;
          if (!reply) {
            try {
              const { messages } = await runtime.subagent.getSessionMessages({ sessionKey: triageSessionKey, limit: 3 });
              const last = [...(messages || [])].reverse().find(m => m.role === "assistant");
              if (last?.content) {
                reply = typeof last.content === "string" ? last.content :
                  Array.isArray(last.content) ? last.content.filter(c => c.type === "text").map(c => c.text).join("\n") : null;
              }
            } catch {}
          }

          // 7. Cleanup ephemeral session
          try { await runtime.subagent.deleteSession({ sessionKey: triageSessionKey }); } catch {}

          // 8. Parse JSON from reply
          if (!reply) return ok({ ok: false, error: "Triage agent returned no reply", durationMs: Date.now() - startMs });

          let decision;
          try {
            // Extract JSON from reply (handle potential markdown wrapping)
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) decision = JSON.parse(jsonMatch[0]);
            else throw new Error("No JSON found");
          } catch (e) {
            return ok({ ok: false, error: `Failed to parse triage response: ${e.message}`, raw: reply.substring(0, 500), durationMs: Date.now() - startMs });
          }

          // 9. Validate and return
          const validActions = ["continue", "new", "reply"];
          if (!validActions.includes(decision.action)) {
            return ok({ ok: false, error: `Invalid action: ${decision.action}`, decision, durationMs: Date.now() - startMs });
          }

          if (decision.action === "continue") {
            if (!decision.threadId) return ok({ ok: false, error: "continue action missing threadId", decision, durationMs: Date.now() - startMs });
            // Ensure sessionKey is populated
            if (!decision.sessionKey) {
              const mindset = activeThreads.find(t => t.id === decision.threadId)?.mindset;
              if (mindset) decision.sessionKey = sessionKeyFor(mindset, decision.threadId);
            }
          }

          if (decision.action === "new") {
            if (!decision.mindset || !decision.title) return ok({ ok: false, error: "new action missing mindset or title", decision, durationMs: Date.now() - startMs });
            // Ensure forumId is populated
            if (!decision.forumId) {
              const m = mindsets.find(ms => ms.id === decision.mindset);
              if (m) decision.forumId = m.forumId;
            }
          }

          return ok({ ok: true, ...decision, userMessage: userMessage.substring(0, 200), durationMs: Date.now() - startMs });

        } catch (e) {
          return ok({ ok: false, error: e.message, durationMs: Date.now() - startMs });
        }
      },
    });

    api.registerTool({
      name: "topic",
      description: "Open a new thread to think about something. Picks the right mindset, creates a forum thread, and starts the conversation. Use this whenever you need specialist thinking on a topic.",
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

        // Create thread — opening post IS the scope (plain text)
        let threadId;
        try {
          const thread = await discordApi("POST", `/channels/${forumId}/threads`, {
            name: title,
            message: { content: brief },
          });
          threadId = thread.id;
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }

        // Silently subscribe Dom to the thread (no ping, just appears in sidebar)
        if (humanId) {
          try { await discordApi("PUT", `/channels/${threadId}/thread-members/${humanId}`); } catch {}
        }

        // Ensure session (uses shared function — idempotent)
        const sessionResult = ensureSession(mindset, threadId);

        // Show typing while agent boots up
        startTypingLoop(threadId);

        // Wake the session
        const starterPrompt = `The scope is in the first post above. Read it and respond.`;
        let wakeResult = null;
        try { wakeResult = await wakeSession(sessionResult.sessionKey, starterPrompt, true, 0); }
        catch (e) { wakeResult = { ok: false, error: e.message }; }

        return ok({ ok: true, mindset, threadId, sessionKey: sessionResult.sessionKey, title, forumId, wakeResult });
      },
    });

    api.registerTool({
      name: "board",
      description: "See all active threads across all mindsets. Your overview of what you're currently thinking about.",
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
      description: "Think about something silently in a specific thread context. The response comes back to you without posting in the thread.",
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
          return ok(await silentQuery(params.sessionKey, params.question));
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    api.registerTool({
      name: "continue",
      description: "Continue a conversation in a thread. For threads that have gone quiet or need a follow-up message.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "The session to nudge (from the board)" },
          message: { type: "string", description: "What to tell them. Default: 'Check in — what's your status on this?'" },
        },
        required: ["sessionKey"],
      },
      async execute(_id, params) {
        const msg = params.message || "Check in — what's your status on this?";
        const sessionKey = params.sessionKey;

        // Extract threadId from sessionKey (agent:X:discord:channel:THREADID)
        const threadId = sessionKey.split("discord:channel:")[1]?.split(":")[0];
        const agentId = sessionKey.split(":")[1];

        // Post visible styled message in thread
        if (threadId) {
          try {
            const color = parseInt("5865F2", 16);
            await discordApi("POST", `/channels/${threadId}/messages`, {
              components: [{
                type: 17, accent_color: color,
                components: [
                  { type: 10, content: `→ **${mindsetLabel(agentId)}**` },
                  { type: 14 },
                  { type: 10, content: msg },
                ],
              }],
              flags: 32768,
            });
          } catch {} // non-critical
        }

        // Wake session — reply goes to thread via deliveryContext
        try {
          const result = await wakeSession(sessionKey, msg, true, 0);
          return ok({ ok: true, sessionKey, runId: result.runId });
        } catch (e) {
          return ok({ ok: false, error: e.message, hint: "Session may have stale transcript. Try closing and re-delegating." });
        }
      },
    });

    api.registerTool({
      name: "close",
      description: "Close a thread. Archives it, ends the conversation. Use when a topic is resolved or no longer needed.",
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


    api.registerTool({
      name: "report",
      description: "Report back to the main agent. Posts a styled status block in the main channel with your update. Use when you've completed work, hit a blocker, or have something the orchestrator needs to know.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Your update" },
        },
        required: ["message"],
      },
      async execute(_id, params) {
        const { message } = params;
        try {
          const config = loadConfig();
          const guilds = config.channels?.discord?.guilds || {};
          const guildId = Object.keys(guilds)[0];
          const channels = guilds[guildId]?.channels || {};
          let mainChannelId = null;
          for (const [chId, ch] of Object.entries(channels)) {
            if (ch.allow && ch.includeThreadStarter === undefined) {
              mainChannelId = chId;
              break;
            }
          }
          if (!mainChannelId) return ok({ ok: false, error: "No main channel found" });
          const color = parseInt("2ecc71", 16);
          await discordApi("POST", `/channels/${mainChannelId}/messages`, {
            components: [{ type: 17, accent_color: color, components: [{ type: 10, content: message }] }],
            flags: 32768,
          });

          // Post a confirmation receipt in the calling thread
          let callingThreadId = null;
          try {
            const reqScope = globalThis[Symbol.for("openclaw.pluginRuntimeGatewayRequestScope")]?.getStore?.();
            const sessionKey = reqScope?.context?.sessionKey || reqScope?.context?.key;
            if (sessionKey) {
              const match = sessionKey.match(/discord:channel:(\d+)$/);
              if (match) callingThreadId = match[1];
            }
          } catch {}
          if (callingThreadId && callingThreadId !== mainChannelId) {
            try {
              const receiptColor = parseInt("95a5a6", 16);
              await discordApi("POST", `/channels/${callingThreadId}/messages`, {
                components: [{ type: 17, accent_color: receiptColor, components: [{ type: 10, content: "↗ Reported to main" }] }],
                flags: 32768,
              });
            } catch (threadErr) {
              if (_logger) _logger.warn(`report: failed to post thread receipt: ${threadErr.message}`);
            }
          }

          return ok({ ok: true, postedTo: mainChannelId, threadReceipt: callingThreadId || null });
        } catch (e) {
          return ok({ ok: false, error: e.message });
        }
      },
    });

    // ═══ refocus ════════════════════════════════════════════════
    api.registerTool({
      name: "refocus",
      description: "Refocus this conversation into one or more new threads in the same forum. Single thread = reframe with clearer scope. Multiple threads = decompose/fork into parallel siblings. Each new thread is independent — no parent/child tracking. Use when scope has drifted, when a thread should split into parallel work, or when you want a cleaner starting point.",
      parameters: {
        type: "object",
        properties: {
          threads: {
            type: "array",
            description: "One or more threads to create. Each gets a structured bootstrap message.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Thread title — short, 3-6 words" },
                type: { type: "string", enum: ["task", "discussion", "research"], description: "Thread type. Determines lifecycle expectations." },
                scope: { type: "string", description: "What this thread is about and what 'done' looks like." },
                constraints: { type: "string", description: "What this thread should NOT touch or focus on." },
                context: { type: "string", description: "Key decisions, facts, or findings from the parent conversation to carry forward." },
                priming: { type: "array", items: { type: "string" }, description: "Files or skills the thread should read on wake." },
              },
              required: ["title", "type", "scope"],
            },
          },
          keepOriginal: { type: "boolean", description: "Keep this thread open after refocusing. Default: false (close it)." },
        },
        required: ["threads"],
      },
      async execute(_id, params) {
        const { threads, keepOriginal = false } = params;
        if (!threads || threads.length === 0) return ok({ ok: false, error: "At least one thread is required" });

        // 1. Figure out which forum we're in from the calling session
        let callingThreadId = null;
        let callingAgentId = null;
        try {
          const reqScope = globalThis[Symbol.for("openclaw.pluginRuntimeGatewayRequestScope")]?.getStore?.();
          const sessionKey = reqScope?.context?.sessionKey || reqScope?.context?.key;
          if (sessionKey) {
            const threadMatch = sessionKey.match(/discord:channel:(\d+)$/);
            if (threadMatch) callingThreadId = threadMatch[1];
            const agentMatch = sessionKey.match(/^agent:([^:]+):/);
            if (agentMatch) callingAgentId = agentMatch[1];
          }
        } catch {}

        if (!callingAgentId) return ok({ ok: false, error: "Could not determine calling agent. refocus must be called from a mindset thread." });

        // Resolve forum ID from agent binding
        const fb = getForumBindings();
        const forumId = fb[callingAgentId];
        if (!forumId) return ok({ ok: false, error: `No forum found for agent ${callingAgentId}` });

        const humanId = getHumanId();
        const created = [];

        // 2. Create each new thread with structured bootstrap message
        for (const t of threads) {
          const lifecycleMap = {
            task: "Closes when the task is confirmed done by the user.",
            discussion: "Closes when the topic reaches a conclusion or is no longer relevant.",
            research: "Closes when findings are delivered and acknowledged.",
          };

          // Build bootstrap message
          const sections = [];
          sections.push(`## ${t.type} — ${t.title}`);
          sections.push(`**Scope:** ${t.scope}`);
          if (t.constraints) sections.push(`**Constraints:** ${t.constraints}`);
          sections.push(`**Closes when:** ${lifecycleMap[t.type] || "Resolved."}`);
          if (t.context) sections.push(`\n**Context from parent:**\n${t.context}`);
          if (t.priming && t.priming.length > 0) sections.push(`\n**Priming:**\n${t.priming.map(p => `- Read: \`${p}\``).join("\n")}`);
          sections.push(`\n---\n⚠️ Do not implement until user confirms intent.`);

          const bootstrapContent = sections.join("\n");

          try {
            const thread = await discordApi("POST", `/channels/${forumId}/threads`, {
              name: t.title,
              message: { content: bootstrapContent },
            });

            // Subscribe Dom to the new thread
            if (humanId) {
              try { await discordApi("PUT", `/channels/${thread.id}/thread-members/${humanId}`); } catch {}
            }

            // Ensure session exists
            const sessionResult = ensureSession(callingAgentId, thread.id);

            // Show typing while agent boots
            startTypingLoop(thread.id);

            // Wake the session
            const starterPrompt = "The scope and context are in the bootstrap message above. Read it, then respond with your initial assessment and plan. Do not implement until the user confirms.";
            let wakeResult = null;
            try { wakeResult = await wakeSession(sessionResult.sessionKey, starterPrompt, true, 0); }
            catch (e) { wakeResult = { ok: false, error: e.message }; }

            created.push({ title: t.title, type: t.type, threadId: thread.id, sessionKey: sessionResult.sessionKey, wakeResult });
          } catch (e) {
            created.push({ title: t.title, type: t.type, error: e.message });
          }
        }

        // 3. Post summary in current thread
        const successCount = created.filter(c => c.threadId).length;
        if (callingThreadId && successCount > 0) {
          const links = created.filter(c => c.threadId).map(c => `→ <#${c.threadId}>`).join("\n");
          const label = threads.length === 1 ? "Refocused into" : "Forked into";
          try {
            const color = parseInt("5865F2", 16);
            await discordApi("POST", `/channels/${callingThreadId}/messages`, {
              components: [{ type: 17, accent_color: color, components: [{ type: 10, content: `**${label}:**\n${links}` }] }],
              flags: 32768,
            });
          } catch {}
        }

        // 4. Optionally close current thread
        if (!keepOriginal && callingThreadId) {
          try {
            await ensureClosed(callingThreadId);
          } catch (e) {
            if (_logger) _logger.warn(`refocus: failed to close original thread: ${e.message}`);
          }
        }

        return ok({
          ok: true,
          action: threads.length === 1 ? "reframe" : "fork",
          created: created.length,
          originalClosed: !keepOriginal,
          threads: created,
        });
      },
    });

    // ═══ add_mindset ════════════════════════════════════════════
    api.registerTool({
      name: "add_mindset",
      description: "Add a new mindset to the system. Creates the Discord forum, OpenClaw agent config, binding, workspace, and registry entry. Requires a gateway restart to take effect.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Agent ID (e.g. 'researcher'). Lowercase, no spaces." },
          name: { type: "string", description: "Display name (e.g. 'Research Mindset')" },
          description: { type: "string", description: "What this mindset does (e.g. 'Deep research, literature review, fact-checking')" },
          categoryId: { type: "string", description: "Discord category ID to create the forum in. If omitted, uses the same category as existing forums." },
        },
        required: ["id", "name", "description"],
      },
      async execute(_id, params) {
        const { id, name, description } = params;
        const steps = {};

        // 1. Find existing forum category
        const config = loadConfig();
        const existingBinding = (config.bindings || [])[0];
        let categoryId = params.categoryId;
        if (!categoryId && existingBinding) {
          try {
            const ch = await discordApi("GET", `/channels/${existingBinding.match.peer.id}`);
            categoryId = ch.parent_id;
          } catch {}
        }

        // 2. Create Discord forum channel
        let forumId;
        try {
          const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];
          const forum = await discordApi("POST", `/guilds/${guildId}/channels`, {
            name: id,
            type: 15, // GUILD_FORUM
            topic: description,
            parent_id: categoryId || undefined,
            available_tags: [
              { name: "Planning" }, { name: "In Progress" }, { name: "Blocked" },
              { name: "Done" }, { name: "Canceled" },
            ],
          });
          forumId = forum.id;
          steps.forum = { ok: true, id: forumId };
        } catch (e) {
          return ok({ ok: false, error: `Failed to create forum: ${e.message}`, steps });
        }

        // 3. Update openclaw.json — agent, binding, channel allowlist
        try {
          const fresh = loadConfig();
          const workspacePath = join(OPENCLAW_HOME, `workspace-${id}`);

          // Add agent
          if (!fresh.agents) fresh.agents = {};
          if (!fresh.agents.list) fresh.agents.list = [];
          fresh.agents.list.push({
            id,
            workspace: workspacePath,
            model: { primary: "anthropic/claude-opus-4-6" },
            heartbeat: { every: "15m", target: "none", to: forumId },
          });

          // Add binding
          if (!fresh.bindings) fresh.bindings = [];
          fresh.bindings.push({
            agentId: id,
            match: { channel: "discord", peer: { kind: "channel", id: forumId } },
          });

          // Add to guild channel allowlist
          const guildId = Object.keys(fresh.channels?.discord?.guilds || {})[0];
          if (guildId) {
            if (!fresh.channels.discord.guilds[guildId].channels) fresh.channels.discord.guilds[guildId].channels = {};
            fresh.channels.discord.guilds[guildId].channels[forumId] = { allow: true, includeThreadStarter: false };
          }

          // Add tools
          const globalTools = fresh.tools?.alsoAllow || [];
          fresh.agents.list[fresh.agents.list.length - 1].tools = { alsoAllow: [...globalTools, "report"] };

          writeFileSync(join(OPENCLAW_HOME, "openclaw.json"), JSON.stringify(fresh, null, 2));
          steps.config = { ok: true };
        } catch (e) {
          steps.config = { ok: false, error: e.message };
        }

        // 4. Create workspace with SOUL.md
        try {
          const workspacePath = join(OPENCLAW_HOME, `workspace-${id}`);
          const { mkdirSync } = await import("node:fs");
          mkdirSync(workspacePath, { recursive: true });
          mkdirSync(join(AGENTS_DIR, id, "sessions"), { recursive: true });
          writeFileSync(join(AGENTS_DIR, id, "sessions", "sessions.json"), "{}");
          writeFileSync(join(workspacePath, "SOUL.md"), `# Mindset: ${name}\n\n${description}\n`);
          writeFileSync(join(workspacePath, "MEMORY.md"), `# MEMORY.md — ${name}\n\nFresh mindset. No memories yet.\n`);
          steps.workspace = { ok: true };
        } catch (e) {
          steps.workspace = { ok: false, error: e.message };
        }

        // 5. Write to mindsets.json registry
        try {
          const regPath = join(OPENCLAW_HOME, "mindsets.json");
          let registry = {};
          try { registry = JSON.parse(readFileSync(regPath, "utf-8")); } catch {}
          if (!registry.mindsets) registry.mindsets = {};
          registry.mindsets[id] = { name, description, forumId, createdAt: new Date().toISOString() };
          writeFileSync(regPath, JSON.stringify(registry, null, 2));
          steps.registry = { ok: true };
        } catch (e) {
          steps.registry = { ok: false, error: e.message };
        }

        return ok({
          ok: true, id, name, forumId,
          steps,
          note: "Gateway restart required for new agent to become active.",
        });
      },
    });

    // ═══ remove_mindset ═══════════════════════════════════════════
    api.registerTool({
      name: "remove_mindset",
      description: "Remove a mindset from the system. Closes all open threads, removes from registry. Optionally removes the agent config and archives the forum.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Agent ID to remove (e.g. 'researcher')" },
          removeAgent: { type: "boolean", description: "Also remove agent from openclaw.json config. Default: false" },
        },
        required: ["id"],
      },
      async execute(_id, params) {
        const { id, removeAgent = false } = params;
        const steps = {};

        // 1. Close all open threads in this mindset's forum
        const fb = getForumBindings();
        const forumId = fb[id];
        if (forumId) {
          try {
            const config = loadConfig();
            const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];
            const { active } = await listForumThreads(guildId, forumId, false);
            let closed = 0;
            for (const t of active) {
              try {
                await ensureClosed(t.id);
                closed++;
              } catch {}
            }
            steps.threads = { ok: true, closed };
          } catch (e) {
            steps.threads = { ok: false, error: e.message };
          }
        }

        // 2. Remove from mindsets.json registry
        try {
          const regPath = join(OPENCLAW_HOME, "mindsets.json");
          let registry = {};
          try { registry = JSON.parse(readFileSync(regPath, "utf-8")); } catch {}
          if (registry.mindsets?.[id]) {
            delete registry.mindsets[id];
            writeFileSync(regPath, JSON.stringify(registry, null, 2));
          }
          steps.registry = { ok: true };
        } catch (e) {
          steps.registry = { ok: false, error: e.message };
        }

        // 3. Optionally remove from config
        if (removeAgent) {
          try {
            const fresh = loadConfig();
            fresh.agents.list = (fresh.agents.list || []).filter(a => a?.id !== id);
            fresh.bindings = (fresh.bindings || []).filter(b => b?.agentId !== id);
            writeFileSync(join(OPENCLAW_HOME, "openclaw.json"), JSON.stringify(fresh, null, 2));
            steps.config = { ok: true, removed: true };
          } catch (e) {
            steps.config = { ok: false, error: e.message };
          }
        }

        return ok({
          ok: true, id, forumId,
          steps,
          note: removeAgent ? "Gateway restart required." : "Mindset removed from registry. Agent config retained.",
        });
      },
    });

    logger.info("openclaw-mindsets: registered all tools");
  },
};
