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

/** @type {{ sessionKey: string, channelId: string|null, agentId: string|null } | null} */
let _current = null;

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
  _current = { sessionKey, channelId, agentId };
}

/**
 * Get the Discord channel ID for the current turn's thread.
 * Called from tool execute() which lacks ctx.
 *
 * @returns {string|null}
 */
export function getCurrentChannelId() {
  return _current?.channelId ?? null;
}

/**
 * Get the full session key for the current turn.
 *
 * @returns {string|null}
 */
export function getCurrentSessionKey() {
  return _current?.sessionKey ?? null;
}

/**
 * Get the agent ID for the current turn.
 *
 * @returns {string|null}
 */
export function getCurrentAgentId() {
  return _current?.agentId ?? null;
}

// Backward compat aliases (keyed lookups that just return current)
export function getChannelId(_agentId) { return getCurrentChannelId(); }
export function getSessionKey(_agentId) { return getCurrentSessionKey(); }
