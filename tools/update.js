/**
 * update — Rename or steer a thread.
 */

import * as discord from "../lib/discord.js";
import { getBotId, listMindsets } from "../lib/config.js";

export default function updateTool(api) {
  return {
    name: "update",
    description: "Update a thread. Rename with title, redirect with steer, or both.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread to update. Omit for current." },
        title: { type: "string", description: "New thread title." },
        steer: { type: "string", description: "Direction to inject into the thread." },
      },
    },
    async execute(_id, { threadId, title, steer } = {}, ctx) {
      const logger = api.logger;

      let target = threadId || ctx?.sessionKey?.match(/discord:channel:(\d+)/)?.[1];
      if (!target) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No threadId" }) }] };

      const results = {};

      if (title) {
        try { await discord.renameThread(target, title, logger); results.renamed = true; }
        catch (e) { results.renameError = e.message; }
      }

      if (steer) {
        const botId = getBotId();
        const mindsets = listMindsets();
        let steered = false;
        for (const m of mindsets) {
          if (!m.webhookUrl) continue;
          try {
            await discord.webhookPost(m.webhookUrl, target, `<@${botId}> ${steer}`, "Justin", null);
            steered = true;
            break;
          } catch { /* wrong forum's webhook — try next */ }
        }
        results.steered = steered;
        if (!steered) results.steerError = "No webhook matched this thread";
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: target, ...results }) }] };
    },
  };
}
