/**
 * lib/session-context.js — Shared session context store.
 *
 * The before_prompt_build hook receives full ctx (including sessionKey).
 * Tool execute() does NOT receive ctx — only (toolCallId, params, signal, onUpdate).
 *
 * This module bridges the gap: the hook writes the current session context,
 * and tools read it back to resolve "self" references.
 *
 * Keyed by sessionKey (not agentId) because a single gateway process handles
 * multiple agents. The "current" getter returns the most recently set context,
 * which is always the active turn's session (tools run synchronously within a turn).
 */

/**
 * Per-agent context map. Keyed by agentId to prevent cross-agent overwrites
 * when multiple agents share the same gateway process.
 *
 * @type {Map<string, { sessionKey: string, channelId: string|null, agentId: string }>}
 */
const _contexts = new Map();

/** @type {string|null} Most recently set agentId — fallback for getCurrentX() */
let _lastAgentId = null;

/**
 * Store session context for the current agent turn.
 * Called from before_prompt_build hook which has full ctx.
 *
 * @param {string} agentId
 * @param {string} sessionKey
 */
export function setSessionContext(agentId, sessionKey) {
  let channelId = null;
  if (sessionKey) {
    const m = sessionKey.match(/:discord:channel:(\d+)$/);
    if (m) channelId = m[1];
  }
  _contexts.set(agentId, { sessionKey, channelId, agentId });
  _lastAgentId = agentId;
}

/**
 * Get the Discord channel ID for the current turn's thread.
 * Called from tool execute() which lacks ctx.
 * Prefers the agent context if available, falls back to last-set.
 *
 * @param {string} [agentId] - Optional agent ID hint
 * @returns {string|null}
 */
export function getCurrentChannelId(agentId) {
  const ctx = agentId ? _contexts.get(agentId) : _contexts.get(_lastAgentId);
  return ctx?.channelId ?? null;
}

/**
 * Get the full session key for the current turn.
 *
 * @param {string} [agentId] - Optional agent ID hint
 * @returns {string|null}
 */
export function getCurrentSessionKey(agentId) {
  const ctx = agentId ? _contexts.get(agentId) : _contexts.get(_lastAgentId);
  return ctx?.sessionKey ?? null;
}

/**
 * Get the agent ID for the current turn.
 *
 * @returns {string|null}
 */
export function getCurrentAgentId() {
  return _lastAgentId;
}

// Backward compat aliases
export function getChannelId(_agentId) { return getCurrentChannelId(_agentId); }
export function getSessionKey(_agentId) { return getCurrentSessionKey(_agentId); }
