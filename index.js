/**
 * openclaw-mindsets — stub extension
 */
export default {
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple AI mindsets, one identity.",
  register(api) {
    api.logger.info("openclaw-mindsets: registering");

    api.registerTool({
      name: "mindset_ping",
      description: "Test tool — confirms the openclaw-mindsets extension is loaded.",
      parameters: { type: "object", properties: {} },
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
};
