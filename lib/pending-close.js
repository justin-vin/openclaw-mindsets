/**
 * lib/pending-close.js — Deferred thread archive queue.
 *
 * The close tool queues thread IDs here instead of archiving immediately.
 * The agent_end hook drains the queue AFTER all messages have been sent,
 * preventing Discord from auto-unarchiving when the bot posts a response.
 */

/** @type {Map<string, Set<string>>} sessionKey → Set of threadIds to archive */
const _pending = new Map();

/**
 * Queue a thread for deferred archive+lock.
 * @param {string} sessionKey
 * @param {string} threadId
 */
export function queueClose(sessionKey, threadId) {
  if (!_pending.has(sessionKey)) _pending.set(sessionKey, new Set());
  _pending.get(sessionKey).add(threadId);
}

/**
 * Drain and return all pending thread IDs for a session, clearing the queue.
 * @param {string} sessionKey
 * @returns {string[]}
 */
export function drainPending(sessionKey) {
  const set = _pending.get(sessionKey);
  if (!set || set.size === 0) return [];
  const ids = [...set];
  _pending.delete(sessionKey);
  return ids;
}

/**
 * Check if a thread is queued for close (useful for suppressing further messages).
 * @param {string} threadId
 * @returns {boolean}
 */
export function isPendingClose(threadId) {
  for (const set of _pending.values()) {
    if (set.has(threadId)) return true;
  }
  return false;
}
