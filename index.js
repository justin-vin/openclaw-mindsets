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
import * as actionBlocks from "./lifecycle/action-blocks.js";
import { setSessionContext } from "./lib/session-context.js";

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
      // Capture session context so tools can resolve "self" references
      if (ctx?.agentId && ctx?.sessionKey) {
        setSessionContext(ctx.agentId, ctx.sessionKey);
      }

      const result = {};

      // Static grounding
      const grounding = threadLifecycle.build(event, ctx, api);
      const mainId = turnLifecycle.getMainIdentity(ctx);
      if (mainId) result.prependSystemContext = mainId;
      else if (grounding) result.prependSystemContext = grounding;

      // Per-turn analysis (returns { appendSystemContext: ... } or null)
      const advice = await turnLifecycle.analyze(event, ctx, api);
      if (advice && typeof advice === "object") {
        Object.assign(result, advice);
      } else if (typeof advice === "string") {
        // Legacy string fallback
        result.appendSystemContext = (result.appendSystemContext ? result.appendSystemContext + "\n\n" : "") + advice;
      }

      return Object.keys(result).length ? result : undefined;
    });

    // Post-turn action blocks
    actionBlocks.setup(api);

    api.logger.info("mindsets v2: registered 6 tools + 2 hooks + action-blocks");
  },
};
