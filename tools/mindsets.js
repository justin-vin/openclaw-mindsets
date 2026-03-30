/**
 * mindsets — Manage mindsets: list, inspect.
 */

import { listMindsets, resolveMindset } from "../lib/config.js";

export default function mindsetsTool(api) {
  return {
    name: "mindsets",
    description: "Manage mindsets. Actions: list, inspect.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect"], description: "What to do." },
        name: { type: "string", description: "Mindset name (for inspect)." },
      },
      required: ["action"],
    },
    async execute(_id, { action, name }) {
      const cfg = api.pluginConfig;
      if (action === "list") return { content: [{ type: "text", text: JSON.stringify({ ok: true, mindsets: listMindsets(cfg) }) }] };
      if (action === "inspect") {
        const m = resolveMindset(cfg, name);
        if (!m) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown: ${name}` }) }] };
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, mindset: m }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown action: ${action}` }) }] };
    },
  };
}
