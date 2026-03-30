/**
 * open — Create a new thread in a mindset's forum.
 *
 * Structured bootstrap: accepts separate fields (prompt, context, done, refs)
 * and concatenates them into a formatted bootstrap message.
 *
 * Flow:
 * 1. Resolve mindset → forum channel ID + webhook
 * 2. Build formatted bootstrap from structured fields
 * 3. Webhook creates forum thread + posts bootstrap (one call)
 *    - Dispatch identity → passes self-filter → agent wakes with content
 * 4. Auto-subscribe configured users (Dom)
 */

import * as discord from "../lib/discord.js";
import { resolveMindset, getAutoSubscribeIds } from "../lib/config.js";

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

      if (!m.webhookUrl) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `No webhook configured for mindset: ${name}` }) }] };
      }

      try {
        const fullBootstrap = buildBootstrap({ prompt, context, done, refs });
        const bootstrap = fullBootstrap.length > 2000 ? fullBootstrap.substring(0, 1997) + "..." : fullBootstrap;

        // Single webhook call: creates forum thread + posts bootstrap from dispatch identity.
        // Dispatch identity passes self-filter → OpenClaw processes as inbound → agent wakes.
        // Embed-only: visually clean for humans, agent reads embed content via OpenClaw extraction
        const result = await discord.webhookPost(
          m.webhookUrl,
          null,  // no thread_id — we're creating one
          null,  // no plain text — embed carries the content
          "Justin",
          null,
          {
            thread_name: title,
            wait: true,  // need response to get thread ID
            embeds: [{
              author: { name: "🎯 Thread Opened" },
              description: bootstrap,
              color: 0x57F287,
            }],
          }
        );

        // The response includes channel_id which is the new thread ID
        const threadId = result.channel_id;
        if (!threadId) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Thread created but no thread ID returned" }) }] };
        }

        // Auto-subscribe configured users (e.g. Dom) so they see new threads
        const subscribeIds = getAutoSubscribeIds();
        for (const uid of subscribeIds) {
          try {
            await discord.addThreadMember(threadId, uid, logger);
          } catch (e) {
            logger.warn(`mindsets: failed to subscribe ${uid} to thread ${threadId}: ${e.message}`);
          }
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId, link: `<#${threadId}>` }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
