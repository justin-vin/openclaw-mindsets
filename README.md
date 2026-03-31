# openclaw-mindsets

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![OpenClaw](https://img.shields.io/badge/OpenClaw-extension-blue)](https://openclaw.ai)

Multiple agents acting as one. Thread-based multi-agent orchestration for [OpenClaw](https://openclaw.ai) on Discord.

> Looking for hosted agents? Try [sauna.ai](https://sauna.ai)

## What it does

Give an AI agent too many jobs and it gets worse at all of them. The fix is multiple agents — but then you're talking to "DevBot" and "OpsBot" like they're appliances. What you actually want is **one identity that thinks in different modes.**

A **mindset** is a thinking mode — a focused context window scoped to a domain (infra, design, PA, etc). Each mindset runs in its own Discord forum. **Threads** within those forums are autonomous context windows — not tasks, not tickets. The agent opens, steers, and closes threads as the conversation evolves.

**What you get:**

- 🧠 **One identity, multiple modes** — the agent says "I'll handle this in #infra", not "delegating to InfraBot"
- 🧵 **Forum threads as context windows** — each thread is primed with exactly the context it needs
- 🔀 **Automatic routing** — every message is analyzed and routed to the right place
- 🎯 **Predictive action blocks** — post-turn buttons that anticipate what you'll say next
- 📋 **Thread lifecycle** — open, steer, rename, close, with deferred archiving

## Install

```bash
git clone https://github.com/justin-vin/openclaw-mindsets.git \
  ~/.openclaw/extensions/openclaw-mindsets

openclaw gateway restart
```

The extension auto-discovers your existing OpenClaw config. No additional setup files — it reads agent definitions, bindings, and Discord config directly from `openclaw.json`.

### Create your first mindset

Once installed, tell your agent:

> "Create a mindset called research for literature reviews and deep research tasks"

The agent calls `mindsets("create", ...)` which handles everything automatically:
1. Creates a Discord forum channel
2. Sets up a webhook for thread creation
3. Registers the agent in `openclaw.json`
4. Creates a binding so Discord routes messages correctly
5. Seeds a workspace with starter files (SOUL.md, IDENTITY.md, etc.)
6. Restarts the gateway

No manual configuration needed.

### Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- A Discord bot with permissions: Manage Channels, Manage Webhooks, Send Messages, Create Public Threads, Manage Threads, Read Message History
- At least one agent configured in `openclaw.json`

## Configuration

Plugin config in `openclaw.json` under `plugins.entries.openclaw-mindsets.config`:

```json
{
  "autoSubscribe": ["YOUR_DISCORD_USER_ID"],
  "displayName": "MyAgent",
  "categoryId": "DISCORD_CATEGORY_ID"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `autoSubscribe` | `string[]` | Discord user IDs to auto-add to every new thread. Ensures you see threads the agent creates. |
| `displayName` | `string` | Name shown on webhook posts (thread creation, action blocks, recovery). Defaults to the main agent's name or "Mindsets". |
| `categoryId` | `string` | Discord category ID where new mindset forum channels are created. Auto-detected from existing forums if omitted. |

### How config is derived

The extension **does not maintain its own mindset registry.** It derives the mindset list from existing OpenClaw config:

- **`openclaw.json` bindings** → which agent maps to which Discord forum
- **`webhooks.json`** (auto-generated) → forum-to-webhook mapping for thread creation
- **Agent workspace files** (`SOUL.md`, `IDENTITY.md`) → mindset descriptions

Adding or removing a mindset changes one place — the extension picks it up automatically.

### Discord config requirements

```json5
{
  "channels": {
    "discord": {
      "allowBots": true,  // required: process webhook messages
      "guilds": {
        "<guildId>": {
          "users": [
            "<human_user_ids>",
            "<webhook_id_per_forum>"  // one per forum, added by mindsets create
          ]
        }
      }
    }
  }
}
```

Each forum channel needs one webhook. The webhook's user ID must be in the guild `users` allowlist so OpenClaw processes webhook messages as inbound. `mindsets("create")` handles this automatically.

---

## Core concepts

### Mindsets

A mindset is a thinking mode — not a separate agent. The same AI identity operates across all mindsets. The difference is the context window: each mindset's forum gives its threads a focused scope. Opening a thread in #infra is organizational filing, not delegation.

### Threads are context spaces, not tasks

Each forum thread is an independent, primed context window. Threads:
- Are autonomous once created (no report-back-to-main flow)
- Have their own session with injected grounding
- Can open threads in other mindsets via `open()`
- Collaborate through files, not direct communication
- Are flat siblings — no hierarchy, no parent/child, no ownership chain
- Close when the user says "done"

There are no project management semantics: no task states, no blockers, no completion criteria.

### Main vs threads

**Main** is the dispatcher. Its only real job is **parallelization:**
- Single thing needing focus → open a thread
- Multiple things → open multiple threads in parallel
- Casual/simple → answer directly
- Status request → `status()` and summarize

Main doesn't implement. It doesn't do deep thinking. It's a concierge.

**Threads** are workers. They own their context, work autonomously, and close when done. They don't report to main. Main pulls via `status()` when it needs to know.

### Thread titles are the UX

The Discord sidebar is the user's map. Thread titles are the only navigation.

- Emoji + 2-4 words. No em-dashes, no subtitles.
- ✅ Good: "🔧 Action block expiry", "📡 DNS records"
- ❌ Bad: "🔧 Discord action blocks — mobile UX"
- Rename when focus shifts. If splitting, rename BOTH.
- Titles evolve: "Investigate bug" → "Auth token expiry fix"

### Dependencies between threads

No state machine. The thread posts a visible block and waits:

> ⏸️ **Paused** — waiting on <#threadId> before continuing

The user bridges contexts. Threads never message each other directly.

### The user flow

1. User talks in main. "Set up DNS and fix that CSS bug."
2. Main opens threads for both. Links appear.
3. User clicks into a thread (or stays in main). Work is happening.
4. User talks in a thread directly. Thread agent handles it.
5. User comes back to main. "What's going on?" Main checks status, summarizes.

**The user never creates threads.** The agent handles titles, bootstraps, routing — the user just talks.

---

## Tools (6)

All tools available to all agents. No tool is main-only. Main's special behavior comes entirely from prompt injection.

### `status`(threadId?)

List all active threads across mindsets, or deep-dive into a specific thread's recent messages. When called from a thread, the current mindset's threads appear first.

### `open`(mindset, title, prompt, context?, done?, refs?)

Create a new forum thread with a structured bootstrap message.

| Param | Required | Description |
|-------|----------|-------------|
| `mindset` | ✅ | Target mindset name |
| `title` | ✅ | Thread title, short and scannable |
| `prompt` | ✅ | Core task/objective |
| `context` | | Background, prior work, why this matters |
| `done` | | Acceptance criteria — what "done" looks like |
| `refs` | | File paths, URLs, thread links to reference |

The tool formats these into a compact bootstrap: prompt first (no label — the task IS the message), then `**Background:**`, `**Target:**`, and `**Refs:**` sections. Only provided fields are included.

Auto-subscribes configured users to every new thread. For forking: call multiple times. For reframing: call `open` then `close`.

### `close`(threadId?)

Close a thread. No `threadId` or `"self"` = close yourself. Pass a threadId = close that one.

Close is **deferred** — the thread ID is queued and archived by the `agent_end` hook after all messages are sent. This prevents Discord from auto-unarchiving when the bot posts its goodbye message.

### `update`(threadId?, title?, steer?)

Rename or steer a thread. `title` renames the Discord thread. `steer` injects a directional message via webhook.

Steers queue behind active turns (session lane serialization). The agent finishes current work, then processes the steer. For urgent steers, send `/stop` first, then the steer.

### `mindsets`(action, ...)

Manage mindsets. Four actions:

| Action | Description |
|--------|-------------|
| `list` | List all mindsets with forum IDs, webhooks, descriptions |
| `inspect` | Deep-dive into a specific mindset |
| `create` | Create a new mindset (6 automated steps: Discord forum → webhook → agent config → binding → workspace → gateway restart) |
| `reframe` | Rename/refocus a mindset. Two-phase: first returns current vs proposed state for adjacency evaluation (dev→design-engineer ✅, dev→cookery ❌), then executes with `confirm: true`. Handles 8 touch points: Discord rename, agent ID, binding, webhooks, config, workspace dir, SOUL.md, IDENTITY.md. |

Both `create` and `reframe` backup `openclaw.json` and `webhooks.json` before any writes. On failure, create rolls back the Discord forum. Backups are timestamped.

### `debug`(action, target?)

System introspection and recovery.

| Action | Description |
|--------|-------------|
| `health` | Check config consistency, webhook validity, forum accessibility, LaunchAgents, delivery queue |
| `zombies` | Detect threads with no agent response (>15min) or stale user messages (>2h) |
| `sessions` | Session state per agent: count, type, cost, tokens, model, compactions |
| `cost` | Token spend per agent, per session, total. Top 5 most expensive sessions. Cache stats. |
| `recover` | Three modes: `failed-queue` (archive failed deliveries), `action-blocks` (clean stale entries >24h), or a thread ID (re-wake with recovery embed + re-subscribe users) |

---

## Lifecycle hooks

### Thread grounding (`lifecycle/thread.js`)

**Hook:** `before_prompt_build` → `prependSystemContext`

Injected once per session for thread sessions. Main sessions get a different identity (see turn.js). This is the thread's entire universe — comprehensive, not short.

Contains:
- Thread identity and autonomy rules
- Brevity rules (Discord replies ≤100 words, overflow to file attachments)
- Plan-first workflow (research → plan → wait for approval → execute)
- Scope management and routing advice handling
- Identity bridge ("one agent, multiple modes")
- Collaboration model (files, not messages)
- Closing behavior
- Dynamic context: mindset name and session key (injected from `ctx`)

### Per-turn routing (`lifecycle/turn.js`)

**Hook:** `before_prompt_build` → `prependSystemContext` (identity) + `appendSystemContext` (routing advice)

Fires on every user message for both main and thread sessions. Two outputs:

**1. Identity injection** — For main: dispatcher identity + cross-agent memory paths. For threads: handled by thread.js instead.

**2. Routing analysis** — Forks the session into an ephemeral subagent:
1. Copy current session JSONL to a temp file
2. Run `runtime.agent.runEmbeddedPiAgent` with analysis prompt + `disableTools: true`
3. Subagent classifies: "answer directly" or routing bullets (open/close/rename/split)
4. Delete temp file

If advice is "answer directly": posts a green "✅ Thread on track" embed.
If advice has actions: posts a footer-only embed with recommendations AND injects into agent context as `## Routing Advice`.

**Guards:** Skips non-user triggers, bot's own messages, webhook messages, recursive analysis calls. 10s cooldown per thread. On failure, falls back to no advice (never blocks the turn). Adds 2-5s latency.

### Action blocks (`lifecycle/action-blocks.js`)

**Hooks:** `agent_end` (generate), `message_received` (cleanup)

After each user-triggered agent turn, predicts 2-3 likely follow-up messages and posts them as Discord component buttons.

**How it works:**
1. Reads last 6 messages from the session JSONL file
2. Runs an embedded subagent with a prediction prompt (12s timeout)
3. Posts buttons as a Discord container component with accent color
4. Registers an interactive handler (namespace: `action-blocks`)

**When a button is clicked:**
1. Deletes the button message
2. Looks up the clicking user's avatar and display name
3. Posts the selected text as a webhook message impersonating the user
4. Dispatches a system event to trigger an agent turn
5. Cleans up in-memory and persisted state

**Key behaviors:**
- Buttons reflect the conversation — if the agent asked "A or B?", buttons are "A" and "B"
- Auto-deleted when the user types manually (via `message_received` hook)
- Persist across gateway restarts (component entries saved to `.action-blocks-state.json`)
- Different prompts for main (orchestration actions) vs threads (task-specific responses)
- 24h TTL on persisted entries

---

## Architecture

```
                    Discord
                      │
         ┌────────────┼────────────┐
         │            │            │
      #main      #infra (forum) #design (forum)
         │            │            │
         │         ┌──┴──┐      ┌──┴──┐
         │       thread thread thread thread
         │
    ┌────┴────┐
    │ Router  │  ← before_prompt_build hook
    │(turn.js)│    analyzes every message
    └────┬────┘
         │
    routes to correct mindset via open/steer/close
```

### Cross-agent communication

Two primitives. Nothing else works reliably.

**Primitive 1: Webhook thread creation** — For opening new threads. Single webhook POST with `thread_name` creates the forum thread and posts the bootstrap as the opening message. The dispatch identity passes OpenClaw's self-filter → processed as inbound → session established → agent wakes with bootstrap in context. No bot mention needed. No CLI cold wake.

```js
const result = await webhookPost(webhookUrl, {
  thread_name: title,
  embeds: [{ author: { name: "Thread Opened" }, description: bootstrap, color: 0x2b2d31 }],
}, { wait: true });
const threadId = result.channel_id;
```

**Primitive 2: Webhook steer** — For messages to existing threads. One HTTP POST to the webhook URL with `thread_id` parameter. The webhook posts as a different Discord user identity (webhook user ID ≠ bot user ID), so it passes the self-filter.

```js
await fetch(`${webhookUrl}?thread_id=${threadId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    embeds: [{ description: message, color: 0x5865F2 }],
    username: displayName,
  }),
});
```

**Cross-thread state sharing** — Files. Threads share state through workspace files. No direct messaging between sessions.

### Why other approaches failed

| Approach | Failure mode |
|----------|-------------|
| `sessions_send` | Delivers reply to sender, not thread |
| `gateway call agent` | Needs in-memory channel binding (only from Discord inbound) |
| `/hooks/agent` | Agent runs but Discord delivery fails (no delivery context) |
| Bot `message` tool | Self-filter drops it (same `author.id`) |
| Session file patching | Gateway uses runtime state, ignores persisted files |

### Hook API reference

**`before_prompt_build`** signature:
```
(event: { prompt, messages }, ctx: { agentId, sessionKey, sessionId, workspaceDir, channelId, trigger })
→ { prependSystemContext?, appendSystemContext?, prependContext?, systemPrompt? }
```

Four injection points:
- `prependSystemContext` — prepended to system prompt, cacheable. Used for static grounding.
- `appendSystemContext` — appended to system prompt, cacheable. Used for routing advice.
- `prependContext` — per-turn dynamic text before messages.
- `systemPrompt` — replaces entire system prompt (don't use).

**`agent_end`** — fires after agent completes. Used for deferred close and action block generation.

**`message_received`** — fires on inbound messages. Used for stale action block cleanup.

### Embedded subagent API

`runtime.agent.runEmbeddedPiAgent` — in-process agent run. Works inside `before_prompt_build` hooks (unlike `runtime.subagent` which only works in tool handlers).

```js
const result = await runtime.agent.runEmbeddedPiAgent({
  sessionId: `analysis-${Date.now()}`,
  sessionFile: forkedSessionPath,
  workspaceDir: ctx.workspaceDir,
  prompt: analysisPrompt,
  disableTools: true,
  timeoutMs: 15000,
  runId: randomUUID(),
  extraSystemPrompt: "You are a routing classifier...",
});
const reply = result?.payloads?.[0]?.text?.trim();
```

Uses OpenClaw's model resolution, auth profiles, and usage tracking. The forked session file gives the subagent full conversation history. 3-10s latency.

### Session context bridge

`before_prompt_build` has access to full session context (`ctx.agentId`, `ctx.sessionKey`). Tool `execute()` does not — it receives only `(toolCallId, params, signal, onUpdate)`.

`lib/session-context.js` bridges the gap: the hook writes the current context to an in-memory map keyed by agent ID, and tools read it back. This is safe because tools run synchronously within a turn.

### Thread detection

Parse `ctx.sessionKey`:
- Main: `agent:main:discord:channel:<mainChannelId>`
- Thread: `agent:<mindsetId>:discord:channel:<threadId>`

The extension checks `ctx.agentId` — if it's `"main"` or absent, it's the main session. Otherwise it's a mindset thread.

---

## File structure

```
openclaw-mindsets/
├── index.js                     # Entry point: imports tools + hooks, registers everything
├── openclaw.plugin.json         # Plugin metadata + config schema
├── package.json                 # NPM metadata (ESM, MIT, zero dependencies)
│
├── lib/
│   ├── config.js                # Mindset registry (derived from openclaw.json + webhooks.json)
│   ├── discord.js               # Discord REST helpers (messages, threads, webhooks)
│   ├── threads.js               # Active thread listing with subscription state
│   ├── session-context.js       # Bridges before_prompt_build context to tool execute()
│   └── pending-close.js         # Deferred thread archive queue
│
├── lifecycle/
│   ├── thread.js                # Thread/main grounding (prependSystemContext)
│   ├── turn.js                  # Per-turn routing analysis (appendSystemContext)
│   └── action-blocks.js         # Post-turn predictive buttons + interactive handler
│
├── tools/
│   ├── status.js                # List threads / deep-dive
│   ├── open.js                  # Create thread + bootstrap + auto-subscribe
│   ├── close.js                 # Deferred archive + lock
│   ├── update.js                # Rename + steer via webhook
│   ├── mindsets.js              # List / inspect / create / reframe
│   └── debug.js                 # Health / zombies / sessions / cost / recovery
│
└── skills/
    └── mindsets/
        └── SKILL.md             # Agent skill (always-injected orchestration rules)
```

## Contributing

1. Fork the repo
2. Clone into `~/.openclaw/extensions/openclaw-mindsets`
3. Make changes — restart gateway to reload (`openclaw gateway restart`)
4. Test with a real Discord server

### Development notes

- ESM only (`"type": "module"`)
- No build step — raw JS, runs directly in Node
- No dependencies beyond Node builtins + OpenClaw runtime
- `webhooks.json` is runtime state (auto-generated by `mindsets create`), gitignored
- `.action-blocks-state.json` is runtime state, gitignored
- Config backups are created automatically before any write operation

## License

MIT
