/**
 * lib/threads.js — Active threads listing (shared between status tool and turn.js).
 */

import * as discord from "./discord.js";
import { listMindsets, getGuildId } from "./config.js";

/**
 * Get all active threads grouped by mindset.
 * @param {string} [currentAgentId] - If provided, this mindset's threads come first.
 * @param {object} [logger]
 * @returns {Promise<{[mindset: string]: {id: string, title: string}[]}>}
 */
export async function getActiveThreads(currentAgentId, logger) {
  const mindsetList = listMindsets();
  const forumIds = new Set(mindsetList.map(m => m.forumId));
  const { threads } = await discord.listActiveThreads(getGuildId(), logger);

  const grouped = {};
  for (const t of (threads || []).filter(t => forumIds.has(t.parent_id))) {
    const name = mindsetList.find(m => m.forumId === t.parent_id)?.name || "unknown";
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push({ id: t.id, title: t.name });
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
    lines.push(`#${mindset} (${list.length}):`);
    for (const t of list) lines.push(`  - "${t.title}" (${t.id})`);
  }
  return lines.join("\n");
}
