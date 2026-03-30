/**
 * update — Rename or steer a thread.
 */

import { renameThread, sendToThread } from "../lib/discord.js";
import { listMindsets } from "../lib/config.js";
import { getCurrentChannelId } from "../lib/session-context.js";

export default function updateTool(api) {
  return {
    name: "update",
    description: "Update a thread. Rename with title, redirect with steer, or both.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread to update. Omit for current." },
        title: { type: "string", description: "New thread title. 2-4 words max." },
        steer: { type: "string", description: "Direction to inject into the thread." },
      },
    },
    async execute(_id, { threadId, title, steer } = {}) {
      const logger = api.logger;
      // Resolve "self" via shared session-context store (execute() doesn't receive ctx)
      const target = threadId || getCurrentChannelId();
      if (!target) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No threadId" }) }] };

      const results = {};

      if (title) {
        try { await renameThread(target, title, logger); results.renamed = true; }
        catch (e) { results.renameError = e.message; }
      }

      if (steer) {
        const webhooks = listMindsets();
        const sent = await sendToThread(steer, target, webhooks, { header: "🔀 Steer" });
        results.steered = sent;
        if (!sent) results.steerError = "No webhook matched this thread";
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: target, ...results }) }] };
    },
  };
}
