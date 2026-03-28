/**
 * status — See what's happening.
 */

import * as discord from "../lib/discord.js";
import { getActiveThreads } from "../lib/threads.js";

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
        const threads = await getActiveThreads(ctx?.agentId, logger);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threads }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
