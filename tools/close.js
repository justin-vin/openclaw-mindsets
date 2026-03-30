/**
 * close — Archive + lock a thread.
 */

import * as discord from "../lib/discord.js";
import { getAutoSubscribeIds } from "../lib/config.js";
import { getCurrentChannelId } from "../lib/session-context.js";

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
    async execute(_id, { threadId } = {}) {
      let target = threadId;
      if (!target || target === "self") {
        // Note: execute() does NOT receive session ctx as 3rd arg (it's AbortSignal).
        // We read the channel ID from the shared session-context store instead,
        // which is populated by the before_prompt_build hook each turn.
        target = getCurrentChannelId();
        if (!target) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Cannot resolve current thread — no session context available" }) }] };
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
