/**
 * lib/threads.js — Active threads listing (shared between status tool and turn.js).
 */

import * as discord from "./discord.js";
import { listMindsets, getGuildId, getAutoSubscribeIds } from "./config.js";

/**
 * Get all active threads grouped by mindset.
 * @param {string} [currentAgentId] - If provided, this mindset's threads come first.
 * @param {object} [logger]
 * @returns {Promise<{[mindset: string]: {id: string, title: string, subscribed: boolean}[]}>}
 */
export async function getActiveThreads(currentAgentId, logger) {
  const mindsetList = listMindsets();
  const forumIds = new Set(mindsetList.map(m => m.forumId));
  const { threads } = await discord.listActiveThreads(getGuildId(), logger);

  // Filter to forum threads first
  const forumThreads = (threads || []).filter(t => forumIds.has(t.parent_id));

  // Fetch thread members in parallel to check owner subscription
  const ownerIds = new Set(getAutoSubscribeIds());
  const memberResults = await Promise.all(
    forumThreads.map(t =>
      discord.getThreadMembers(t.id, logger).catch(() => [])
    )
  );

  const subscribedThreadIds = new Set();
  for (let i = 0; i < forumThreads.length; i++) {
    const members = memberResults[i];
    if ((members || []).some(m => ownerIds.has(m.user_id))) {
      subscribedThreadIds.add(forumThreads[i].id);
    }
  }

  const grouped = {};
  for (const t of forumThreads) {
    const name = mindsetList.find(m => m.forumId === t.parent_id)?.name || "unknown";
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push({ id: t.id, title: t.name, subscribed: subscribedThreadIds.has(t.id) });
  }

  // Order: current mindset first, then others
  const ordered = {};
  if (currentAgentId && grouped[currentAgentId]) ordered[currentAgentId] = grouped[currentAgentId];
  for (const [k, v] of Object.entries(grouped)) if (k !== currentAgentId) ordered[k] = v;

  return ordered;
}

/**
 * Format active threads as a string for prompt injection.
 */
export function formatThreadsForPrompt(threads) {
  const lines = [];
  for (const [mindset, list] of Object.entries(threads)) {
    const subCount = list.filter(t => t.subscribed).length;
    lines.push(`#${mindset} (${subCount}/${list.length} subscribed):`);
    for (const t of list) {
      const tag = t.subscribed ? "✓" : "○";
      lines.push(`  ${tag} "${t.title}" (${t.id})`);
    }
  }
  return lines.join("\n");
}
