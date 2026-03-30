/**
 * test-fork — Test tool: fork this session and ask the fork a question.
 * Temporary. Delete after testing.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

export default function testForkTool(api) {
  return {
    name: "test_fork",
    description: "Test: fork this session, ask the fork a question, return its answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to ask the forked session." },
      },
      required: ["question"],
    },
    async execute(_id, { question }, ctx) {
      const runtime = api.runtime;
      const logger = api.logger;

      // Resolve current session file
      const agentId = ctx.agentId || "infra";
      const store = runtime.agent.session.loadSessionStore();
      const sessionKey = ctx.sessionKey;
      const entry = store[sessionKey];
      if (!entry?.sessionFile) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No session file found for " + sessionKey }) }] };
      }

      // Branch using SessionManager
      const require = createRequire(import.meta.url);
      const { SessionManager } = require("@mariozechner/pi-coding-agent");
      const mgr = SessionManager.open(entry.sessionFile);
      const leafId = mgr.getLeafId();
      const branchedFile = mgr.createBranchedSession(leafId);
      logger.info(`test-fork: branched ${entry.sessionFile} → ${branchedFile}`);

      try {
        const result = await runtime.agent.runEmbeddedPiAgent({
          sessionId: `fork-test-${Date.now()}`,
          sessionFile: branchedFile,
          workspaceDir: ctx.workspaceDir || runtime.agent.resolveAgentWorkspaceDir(agentId),
          prompt: question,
          disableTools: true,
          timeoutMs: 30000,
          runId: randomUUID(),
        });

        const reply = result?.payloads?.[0]?.text?.trim();
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, reply }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      } finally {
        try { unlinkSync(branchedFile); } catch {}
      }
    },
  };
}
