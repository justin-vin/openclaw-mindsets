/**
 * open — Create a new thread in a mindset's forum.
 */

import { execSync, spawn } from "node:child_process";
import * as discord from "../lib/discord.js";
import { resolveMindset } from "../lib/config.js";

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

        let binaryPath;
        try { binaryPath = execSync("which openclaw", { encoding: "utf-8" }).trim(); }
        catch { return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: thread.id, warning: "Thread created but wake failed — openclaw not in PATH" }) }] }; }

        const child = spawn(binaryPath, [
          "agent", "--agent", name, "--message", bootstrap,
          "--deliver", "--reply-channel", "discord", "--reply-to", `channel:${thread.id}`, "--timeout", "300",
        ], { detached: true, stdio: "ignore" });
        child.unref();

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, threadId: thread.id, link: `<#${thread.id}>` }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    },
  };
}
