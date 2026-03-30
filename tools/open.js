/**
 * open — Create a new thread in a mindset's forum.
 *
 * Structured bootstrap: accepts separate fields (prompt, context, done, refs)
 * and concatenates them into a formatted bootstrap message. This enforces
 * completeness — agents can't skip sections.
 *
 * Flow:
 * 1. Resolve mindset → forum channel ID + webhook
 * 2. Build formatted bootstrap from structured fields
 * 3. Create Discord forum thread with bootstrap as first message
 * 4. Auto-subscribe configured users (Dom)
 * 5. Wake via webhook steer
 */

import * as discord from "../lib/discord.js";
import { resolveMindset, getBotId, getAutoSubscribeIds } from "../lib/config.js";

function buildBootstrap({ prompt, context, done, refs }) {
  const sections = [];

  // Always include the core task
  sections.push(`**Task**\n${prompt}`);

  if (context) {
    sections.push(`**Context**\n${context}`);
  }

  if (done) {
    sections.push(`**Done when**\n${done}`);
  }

  if (refs) {
    sections.push(`**References**\n${refs}`);
  }

  return sections.join("\n\n");
}

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
        context: { type: "string", description: "Background, prior work, or why this matters. Optional but recommended." },
        done: { type: "string", description: "Acceptance criteria — what 'done' looks like. Optional but recommended." },
        refs: { type: "string", description: "File paths, URLs, or thread links to reference. Optional." },
      },
      required: ["mindset", "title", "prompt"],
    },
    async execute(_id, { mindset: name, title, prompt, context, done, refs }) {
      const logger = api.logger;
      const m = resolveMindset(null, name);
      if (!m) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown mindset: ${name}` }) }] };

      try {
        const fullBootstrap = buildBootstrap({ prompt, context, done, refs });
        const bootstrap = fullBootstrap.length > 2000 ? fullBootstrap.substring(0, 1997) + "..." : fullBootstrap;
        const thread = await discord.createThread(m.forumId, title, bootstrap, logger);

        // Auto-subscribe configured users (e.g. Dom) so they see new threads
        const subscribeIds = getAutoSubscribeIds();
        for (const uid of subscribeIds) {
          try {
            await discord.addThreadMember(thread.id, uid, logger);
          } catch (e) {
            logger.warn(`mindsets: failed to subscribe ${uid} to thread ${thread.id}: ${e.message}`);
          }
        }

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
