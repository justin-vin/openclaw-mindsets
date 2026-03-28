import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

export default definePluginEntry({
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple AI mindsets, one identity. Multi-agent orchestration via Discord forum threads.",
  register(api) {
    api.logger.info("openclaw-mindsets: registering");

    // 1.8: Stub tool to verify extension loads and tools are callable
    api.registerTool({
      name: "mindset_ping",
      description: "Test tool — confirms the openclaw-mindsets extension is loaded and responsive.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                extension: "openclaw-mindsets",
                version: "0.1.0",
                timestamp: new Date().toISOString(),
              }),
            },
          ],
        };
      },
    });

    api.logger.info("openclaw-mindsets: registered mindset_ping tool");
  },
});
