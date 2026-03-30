/**
 * open — Create a new thread in a mindset's forum.
 *
 * Single webhook call creates the forum thread and posts the bootstrap.
 * Dispatch identity passes self-filter → agent wakes with full content.
 */

import { createThreadViaWebhook, addThreadMember } from "../lib/discord.js";
import { resolveMindset, getAutoSubscribeIds } from "../lib/config.js";

function buildBootstrap({ prompt, context, done, refs }) {
  // Prompt first, no label — the task IS the message.
  const lines = [prompt];
  if (context) lines.push('', `**Background:** ${context}`);
  if (done) lines.push('', `**Target:** ${done}`);
  if (refs) lines.push('', `**Refs:** ${refs}`);
  return lines.join('\n');
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
      if (!m.webhookUrl) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `No webhook configured for mindset: ${name}` }) }] };

      try {
        const fullBootstrap = buildBootstrap({ prompt, context, done, refs });
        const bootstrap = fullBootstrap.length > 4000 ? fullBootstrap.substring(0, 3997) + "..." : fullBootstrap;

        const { threadId } = await createThreadViaWebhook(m.webhookUrl, title, bootstrap);

        // Auto-subscribe configured users (e.g. Dom)
        for (const uid of getAutoSubscribeIds()) {
          try { await addThreadMember(threadId, uid, logger); }
          catch (e) { logger.warn(`mindsets: failed to subscribe ${uid} to ${threadId}: ${e.message}`); }
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId, link: `<#${threadId}>` }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
