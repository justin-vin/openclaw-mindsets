/**
 * open — Create a new thread in a mindset's forum.
 *
 * 1. Resolve mindset → forum channel ID + webhook
 * 2. Create Discord forum thread with bootstrap as first message
 * 3. Wake via webhook steer (not CLI) — this creates Discord inbound,
 *    which establishes the session delivery context natively.
 *
 * Why webhook, not CLI:
 *   CLI `openclaw agent --deliver` fails for new threads because no
 *   Discord session/delivery context exists yet. The gateway says
 *   "Outbound not configured for channel: discord". Webhook steer
 *   creates a real Discord inbound message → session is established
 *   with correct delivery context → agent responds in the thread.
 */

import * as discord from "../lib/discord.js";
import { resolveMindset, getBotId } from "../lib/config.js";

export default function openTool(api) {
  return {
    name: "open",
    description: "Open a new thread in a mindset's forum. Creates thread, posts bootstrap, wakes agent.",
    parameters: {
      type: "object",
      properties: {
        mindset: { type: "string", description: "Mindset name (e.g. 'infra', 'design-engineer')." },
        title: { type: "string", description: "Thread title. Short, specific, scannable." },
        prompt: { type: "string", description: "Bootstrap message. Sets the thread's scope and context." },
      },
      required: ["mindset", "title", "prompt"],
    },
    async execute(_id, { mindset: name, title, prompt }) {
      const logger = api.logger;
      const m = resolveMindset(null, name);
      if (!m) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown mindset: ${name}` }) }] };

      try {
        const bootstrap = prompt.length > 2000 ? prompt.substring(0, 1997) + "..." : prompt;
        const thread = await discord.createThread(m.forumId, title, bootstrap, logger);

        // Wake via webhook steer — this creates Discord inbound which
        // establishes the session with correct delivery context
        const botId = getBotId();
        if (m.webhookUrl && botId) {
          try {
            await discord.webhookPost(
              m.webhookUrl,
              thread.id,
              `<@${botId}> ${bootstrap}`,
              "Justin",
              null
            );
          } catch (e) {
            // Webhook failed — thread exists but agent won't wake
            return { content: [{ type: "text", text: JSON.stringify({
              ok: true, threadId: thread.id, link: `<#${thread.id}>`,
              warning: `Thread created but wake failed: ${e.message}`
            }) }] };
          }
        } else {
          return { content: [{ type: "text", text: JSON.stringify({
            ok: true, threadId: thread.id, link: `<#${thread.id}>`,
            warning: "Thread created but no webhook configured — agent won't wake"
          }) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: thread.id, link: `<#${thread.id}>` }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
