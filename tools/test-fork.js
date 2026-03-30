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
        sessionKey: { type: "string", description: "Session key to fork from. Omit for current." },
      },
      required: ["question"],
    },
    async execute(_id, { question, sessionKey: overrideKey }, ctx) {
      const runtime = api.runtime;
      const logger = api.logger;

      // Resolve session file
      const targetKey = overrideKey || ctx.sessionKey;
      const agentId = ctx.agentId || "infra";
      const store = runtime.agent.session.loadSessionStore();
      const entry = store[targetKey];
      if (!entry?.sessionFile) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No session file found for " + targetKey, keys: Object.keys(store).filter(k => k.includes("1488025")).slice(0, 5) }) }] };
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
