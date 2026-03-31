/**
 * close — Queue a thread for archive + lock (deferred to agent_end).
 *
 * The actual archive happens in the agent_end hook (index.js) AFTER
 * all messages have been sent, preventing Discord auto-unarchive.
 */

import { getAutoSubscribeIds } from "../lib/config.js";
import { getCurrentChannelId, getCurrentAgentId, getCurrentSessionKey } from "../lib/session-context.js";
import { queueClose } from "../lib/pending-close.js";
import * as discord from "../lib/discord.js";

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
        const agentId = getCurrentAgentId();
        target = getCurrentChannelId(agentId);
        if (!target) {
          return { content: [{ type: "text", text: JSON.stringify({
            ok: false,
            error: "Cannot resolve current thread — no session context available. Pass threadId explicitly.",
            hint: "Use status() to find thread IDs"
          }) }] };
        }
      }

      try {
        // Remove auto-subscribed users before archiving
        for (const uid of getAutoSubscribeIds()) {
          try { await discord.removeThreadMember(target, uid, api.logger); }
          catch {}
        }

        // Queue for deferred archive (agent_end hook will execute it)
        const sessionKey = getCurrentSessionKey();
        if (sessionKey) {
          queueClose(sessionKey, target);
          api.logger.info(`close: queued deferred archive for thread ${target} (session: ${sessionKey})`);
        } else {
          // Fallback: archive immediately if no session context (shouldn't happen)
          api.logger.warn(`close: no session context, archiving thread ${target} immediately`);
          await discord.archiveThread(target, api.logger);
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: target, deferred: !!sessionKey }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message, threadId: target }) }] };
      }
    },
  };
}
