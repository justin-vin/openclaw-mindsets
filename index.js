/**
 * mindsets — Multiple agents acting as one.
 *
 * Entry point. 6 tools + 1 before_prompt_build hook.
 * No business logic here.
 */

import statusTool from "./tools/status.js";
import openTool from "./tools/open.js";
import closeTool from "./tools/close.js";
import updateTool from "./tools/update.js";
import mindsetsTool from "./tools/mindsets.js";
import debugTool from "./tools/debug.js";
import * as threadLifecycle from "./lifecycle/thread.js";
import * as turnLifecycle from "./lifecycle/turn.js";

export default {
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple agents acting as one. Thread-based context orchestration.",

  register(api) {
    api.logger.info("mindsets v2: registering");

    api.registerTool(statusTool(api));
    api.registerTool(openTool(api));
    api.registerTool(closeTool(api));
    api.registerTool(updateTool(api));
    api.registerTool(mindsetsTool(api));
    api.registerTool(debugTool(api));
    api.on("before_prompt_build", async (event, ctx) => {
      const result = {};

      // Static grounding
      const grounding = threadLifecycle.build(event, ctx, api);
      const mainId = turnLifecycle.getMainIdentity(ctx);
      if (grounding) result.prependSystemContext = grounding;
      if (mainId) result.prependSystemContext = mainId;

      // Per-turn analysis
      const advice = await turnLifecycle.analyze(event, ctx, api);
      if (advice) result.prependContext = advice;

      return Object.keys(result).length ? result : undefined;
    });

    api.logger.info("mindsets v2: registered 6 tools + 1 hook");
  },
};
