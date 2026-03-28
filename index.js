/**
 * openclaw-mindsets — extension for multi-agent orchestration
 *
 * First-principles approach to autonomous cross-thread task creation.
 */

const OPENCLAW_HOME = "/Users/justin/.openclaw";

function readStore(agentId) {
  const fs = require("fs");
  const path = require("path");
  const storePath = path.join(OPENCLAW_HOME, "agents", agentId, "sessions", "sessions.json");
  return { store: JSON.parse(fs.readFileSync(storePath, "utf-8")), storePath };
}

function writeStore(storePath, store) {
  const fs = require("fs");
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

export default {
  id: "openclaw-mindsets",
  name: "OpenClaw Mindsets",
  description: "Multiple AI mindsets, one identity.",
  register(api) {
    const runtime = api.runtime;
    const logger = api.logger;

    logger.info("openclaw-mindsets: registering");

    // ─── mindset_ping ───────────────────────────────────────────────
    api.registerTool({
      name: "mindset_ping",
      description: "Test tool — confirms the openclaw-mindsets extension is loaded.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify({
            ok: true, extension: "openclaw-mindsets", version: "0.1.0",
            timestamp: new Date().toISOString(),
          })}],
        };
      },
    });

    // ─── mindset_session_probe ───────────────────────────────────────
    api.registerTool({
      name: "mindset_session_probe",
      description: "Probe session store capabilities. Tests: list sessions, read store, check subagent API. Returns raw findings.",
      parameters: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description: "Agent ID to probe session store for (e.g. 'main', 'sysadmin'). Defaults to 'main'.",
          },
        },
      },
      async execute(params) {
        const agentId = params?.agentId || "main";
        const results = { agentId, timestamp: new Date().toISOString(), tests: {} };

        try {
          const { store, storePath } = readStore(agentId);
          const keys = Object.keys(store);
          const withDC = keys.filter(k => store[k]?.deliveryContext?.to);
          results.tests.sessionStore = {
            ok: true, storePath, totalSessions: keys.length,
            withDeliveryTo: withDC.length,
            samples: withDC.slice(0, 3).map(k => ({
              key: k, deliveryContext: store[k].deliveryContext,
            })),
          };
        } catch (e) {
          results.tests.sessionStore = { ok: false, error: e.message };
        }

        try {
          const sa = runtime.subagent;
          results.tests.subagentMethods = {
            ok: true,
            methods: Object.getOwnPropertyNames(sa).filter(k => typeof sa[k] === "function"),
          };
        } catch (e) {
          results.tests.subagentMethods = { ok: false, error: e.message };
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      },
    });

    // ─── mindset_create_task ─────────────────────────────────────────
    // The core test: autonomous cross-thread task creation
    //
    // First principles:
    // 1. Gateway reads deliveryContext from sessions.json at delivery time
    // 2. If the entry has { channel: "discord", to: "channel:<threadId>" },
    //    the reply goes to that Discord thread
    // 3. subagent.run creates a session with an explicit key and runs it
    // 4. We write deliveryContext BEFORE triggering the run
    // 5. If subagent.run doesn't overwrite deliveryContext, the reply
    //    routes to Discord. If it does, we patch after and before delivery.
    //
    api.registerTool({
      name: "mindset_create_task",
      description: "TEST: Create a task session in a target agent's forum thread. Patches deliveryContext for Discord routing. Returns session key and delivery status.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Target agent ID (e.g. 'sysadmin')" },
          threadId: { type: "string", description: "Discord thread ID to bind the session to" },
          message: { type: "string", description: "Task instructions for the agent" },
        },
        required: ["agentId", "threadId", "message"],
      },
      async execute(params) {
        const agentId = params?.agentId;
        const threadId = params?.threadId;
        const message = params?.message;

        logger.info(`create_task: agentId=${agentId} threadId=${threadId}`);

        const sessionKey = `agent:${agentId}:discord:channel:${threadId}`;
        const results = { agentId, threadId, sessionKey, timestamp: new Date().toISOString(), steps: {} };

        // Step 1: Write deliveryContext to session store BEFORE the run
        try {
          const { store, storePath } = readStore(agentId);

          if (!store[sessionKey]) {
            store[sessionKey] = { sessionId: sessionKey, updatedAt: Date.now() };
          }
          store[sessionKey].deliveryContext = {
            channel: "discord",
            to: `channel:${threadId}`,
            accountId: "default",
            threadId: threadId,
          };
          store[sessionKey].lastChannel = "discord";
          store[sessionKey].lastTo = `channel:${threadId}`;
          store[sessionKey].lastAccountId = "default";
          store[sessionKey].lastThreadId = threadId;
          store[sessionKey].channel = "discord";
          store[sessionKey].chatType = "channel";
          store[sessionKey].updatedAt = Date.now();

          writeStore(storePath, store);
          results.steps.patchStore = { ok: true };
          logger.info(`create_task: patched deliveryContext for ${sessionKey}`);
        } catch (e) {
          results.steps.patchStore = { ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 3) };
          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }

        // Step 2: Run the session via subagent.run
        try {
          const { runId } = await runtime.subagent.run({
            sessionKey,
            message,
            deliver: true,
          });
          results.steps.run = { ok: true, runId };
          logger.info(`create_task: subagent.run started, runId=${runId}`);

          // Step 3: Immediately re-patch deliveryContext in case subagent.run overwrote it
          try {
            const { store, storePath } = readStore(agentId);
            if (store[sessionKey]) {
              const dc = store[sessionKey].deliveryContext;
              const needsPatch = !dc || dc.channel !== "discord" || dc.to !== `channel:${threadId}`;
              if (needsPatch) {
                store[sessionKey].deliveryContext = {
                  channel: "discord",
                  to: `channel:${threadId}`,
                  accountId: "default",
                  threadId: threadId,
                };
                store[sessionKey].lastChannel = "discord";
                store[sessionKey].lastTo = `channel:${threadId}`;
                writeStore(storePath, store);
                results.steps.repatch = { ok: true, reason: "subagent.run overwrote deliveryContext" };
              } else {
                results.steps.repatch = { ok: true, reason: "deliveryContext preserved — no repatch needed" };
              }
            }
          } catch (e) {
            results.steps.repatch = { ok: false, error: e.message };
          }

          // Step 4: Wait for completion
          try {
            const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });
            results.steps.wait = {
              ok: true,
              status: result?.status,
              hasReply: !!result?.reply,
              replyPreview: result?.reply?.substring(0, 200),
            };
          } catch (e) {
            results.steps.wait = { ok: false, error: e.message };
          }

          // Step 5: Final verify — did delivery context survive?
          try {
            const { store } = readStore(agentId);
            const entry = store[sessionKey];
            results.steps.verify = {
              ok: entry?.deliveryContext?.to === `channel:${threadId}`,
              deliveryContext: entry?.deliveryContext,
            };
          } catch (e) {
            results.steps.verify = { ok: false, error: e.message };
          }

        } catch (e) {
          results.steps.run = { ok: false, error: e.message };
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      },
    });

    logger.info("openclaw-mindsets: registered all tools");
  },
};
