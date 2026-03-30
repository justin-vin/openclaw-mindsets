/**
 * close — Archive + lock a thread.
 */

import * as discord from "../lib/discord.js";
import { getAutoSubscribeIds } from "../lib/config.js";

export default function closeTool(api) {
  return {
    name: "close",
    description: 'Close a thread. Pass "self" or omit threadId to close this thread.',
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: 'Thread ID or "self". Omit for self.' },
      },
    },
    async execute(_id, { threadId } = {}, ctx) {
      let target = threadId;
      if (!target || target === "self") {
        target = ctx?.sessionKey?.match(/discord:channel:(\d+)/)?.[1];
        if (!target) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Cannot resolve current thread" }) }] };
      }

      try {
        // Remove auto-subscribed users before archiving
        for (const uid of getAutoSubscribeIds()) {
          try { await discord.removeThreadMember(target, uid, api.logger); }
          catch {}
        }
        await discord.archiveThread(target, api.logger);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: target }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
