/**
 * status — See what's happening.
 */

import * as discord from "../lib/discord.js";
import { listMindsets, getGuildId } from "../lib/config.js";

export default function statusTool(api) {
  return {
    name: "status",
    description: "See active threads. No params = list all. Pass threadId for deep-dive.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread ID to inspect." },
      },
    },
    async execute(_id, { threadId } = {}, ctx) {
      const logger = api.logger;
      const cfg = api.pluginConfig;

      if (threadId) {
        try {
          const messages = await discord.api("GET", `/channels/${threadId}/messages?limit=10`, null, logger);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId, messages: messages.map(m => ({
            author: m.author?.username, content: m.content?.substring(0, 200), timestamp: m.timestamp,
          })) }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
        }
      }

      try {
        const mindsetList = listMindsets(cfg);
        const forumIds = new Set(mindsetList.map(m => m.forumId));
        const { threads } = await discord.listActiveThreads(getGuildId(cfg), logger);

        const grouped = {};
        for (const t of (threads || []).filter(t => forumIds.has(t.parent_id))) {
          const name = mindsetList.find(m => m.forumId === t.parent_id)?.name || "unknown";
          if (!grouped[name]) grouped[name] = [];
          grouped[name].push({ id: t.id, title: t.name });
        }

        const ordered = {};
        if (ctx?.agentId && grouped[ctx.agentId]) ordered[ctx.agentId] = grouped[ctx.agentId];
        for (const [k, v] of Object.entries(grouped)) if (k !== ctx?.agentId) ordered[k] = v;

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threads: ordered }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
