/**
 * debug — System introspection. Health + zombie detection.
 */

import * as discord from "../lib/discord.js";
import { listMindsets, getGuildId } from "../lib/config.js";

export default function debugTool(api) {
  return {
    name: "debug",
    description: "System introspection. Health, zombies, sessions, cost, recovery.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["health", "zombies", "sessions", "cost", "recover"], description: "What to inspect." },
      },
      required: ["action"],
    },
    async execute(_id, { action }) {
      const logger = api.logger;
      const cfg = api.pluginConfig;

      if (action === "health") {
        const checks = { mindsets: {} };
        for (const m of listMindsets(cfg)) {
          try { await discord.api("GET", `/channels/${m.forumId}`, null, logger); checks.mindsets[m.name] = "ok"; }
          catch (e) { checks.mindsets[m.name] = e.message.substring(0, 100); }
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, health: checks }) }] };
      }

      if (action === "zombies") {
        const mindsets = listMindsets(cfg);
        const forumIds = new Set(mindsets.map(m => m.forumId));
        const { threads } = await discord.listActiveThreads(getGuildId(cfg), logger);
        const zombies = [];

        for (const t of (threads || []).filter(t => forumIds.has(t.parent_id))) {
          try {
            const msgs = await discord.api("GET", `/channels/${t.id}/messages?limit=5`, null, logger);
            const hasAgentReply = msgs.some(m => m.author?.bot && msgs.length > 1);
            const first = msgs[msgs.length - 1];
            const age = Date.now() - new Date(first?.timestamp).getTime();
            if (!hasAgentReply && age > 5 * 60 * 1000) {
              zombies.push({ id: t.id, title: t.name, ageMin: Math.round(age / 60000) });
            }
          } catch {}
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, zombies }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `${action} not yet implemented` }) }] };
    },
  };
}
