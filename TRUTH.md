# TRUTH.md — Mindsets v2

> ⚠️ This is the source of truth. Do not update without explicit permission.
> Every claim in this document has been discussed, debated, and decided.
> If something here conflicts with code, the code is wrong.

Last updated: 2026-03-29.

---

## What This Is

An OpenClaw extension that gives one agent multiple thinking modes via Discord forum threads.

## The Insight

Task management doesn't work for agents. What works: **optimized context windows.** Each thread is a focused conversation space. The attention mechanism works best when the context window is tightly scoped.

## Core Mental Model

**Threads are context spaces, not tasks.**

- Each thread is an independent, primed context window
- Main is a **dispatcher** — it routes, it doesn't orchestrate
- Once a thread is spawned, it's **autonomous** — no report-back-to-main flow
- No project management semantics: no task states, no blockers, no completion criteria
- Threads are **flat siblings** — no hierarchy, no parent/child, no ownership chain
- Forked threads are independent the moment they're created
- Threads don't push to main. Main pulls when needed. The user bridges contexts.

## UX — What the User Experiences

The user talks to one agent in one place: **main**. A linear, single-threaded conversation. This is their persistent relationship with the agent.

When a conversation needs focused attention or parallelism, **main opens threads** in mindset forums. The user can jump into any open thread and talk there directly.

**The user never creates threads.** Forum threads in Discord are annoying — title + body. The agent handles all of that. The user just talks.

### The flow

1. User talks in main. "Set up DNS and fix that CSS bug."
2. Main opens threads for both. Links appear.
3. User clicks into a thread (or stays in main). Work is happening.
4. User talks in a thread directly. Thread agent handles it.
5. User comes back to main. "What's going on?" Main checks status, summarizes.

### What main does

Main's only real job is **parallelization.** It decides:
- Single thing? → Open a thread (or steer an existing one)
- Multiple things? → Open multiple threads
- Casual/simple? → Answer directly
- Status request? → Check threads and summarize

Main doesn't implement. It doesn't do deep thinking. It's a concierge.

### Thread names are the entire UX surface

The Discord sidebar is the user's map. Thread titles are the only thing they see.

- **Names must be clear and specific.** Scannable at a glance.
- **Names must disambiguate.** When a thread splits, rename BOTH. "DNS setup" alone was fine — once monitoring splits off, it becomes "DNS — records" and "DNS — monitoring."
- **Names evolve.** "Investigate bug" → "Auth token expiry fix."
- **The per-turn analysis recommends renames** alongside routing advice.

### Dependencies — no state, just messages

"Before you do that, first research X":
1. New thread opens for the research
2. Current thread gets a visible block:

> ⏸️ **Paused** — waiting on <#threadId> (research X) before continuing

No state machine. The thread is "paused" because the last message says so.

## Identity

All mindsets are one identity. Different thinking modes, one agent. Opening a thread in #infra is organizational filing — keeping Discord tidy — not delegation to a separate agent. Say "let me open this in #infra" not "let me delegate to sysadmin."

## Tools (6)

All tools available to all agents. No tool is main-only. Main's special behavior comes entirely from prompting.

### `status`(threadId?)
See what's happening. No params = list all active threads. Pass threadId = deep-dive.

When called from a thread: prioritize the current mindset's threads first as a block, then show other mindsets' threads separately. Orient the agent to its own context while maintaining awareness of everything.

### `open`(mindset, title, prompt, context?, done?, refs?)
Create a new thread. Structured bootstrap — the tool concatenates fields into a formatted post.

**Parameters:**
- `mindset` (required) — target mindset name
- `title` (required) — thread title, short and scannable
- `prompt` (required) — the core task/objective
- `context` (optional) — background, prior work, why this matters
- `done` (optional) — acceptance criteria, what "done" looks like
- `refs` (optional) — file paths, URLs, thread links to reference

The tool formats these into a compact bootstrap: prompt first (no label — the task IS the message), then inline `**Background:**`, `**Target:**`, and `**Refs:**` sections. Only provided fields are included. This keeps bootstraps conversational rather than form-like.

Auto-subscribes configured users (Dom) to every new thread.

For forking: call multiple times. For reframing: call `open` then `close`.

### `close`(threadId?)
Close a thread. No threadId or "self" = close yourself. Pass a threadId = close that one. When the user says "done" — wrap up briefly. Don't be ceremonial.

### `update`(threadId?, title?, steer?)
Rename or steer a thread. `title` = rename. `steer` = inject direction.

✅ `steer` uses Discord webhook POST. See Architecture section. Validated 2026-03-29.

### `mindsets`(action, ...)
Manage mindsets: list, add, remove, inspect, rename/reframe.

Renaming a mindset is complex — it means updating the config, the forum channel name, and the agent ID mapping. Reframing (changing what a mindset covers) is harder — existing threads may no longer belong. This needs careful thought. For v1 of this tool: list, add, remove, inspect only. Rename/reframe is future work.

### `debug`(...)
Deep introspection. Not just threads — the full system:
- Health: overall system status
- Zombies: threads with bootstrap but no agent response (>5min)
- Sessions: session state behind threads, relationship between sessions and threads
- Bindings: channel binding state
- Wakes: recent wake attempts and outcomes
- Cost: token spend per thread, per mindset, total
- Recovery: re-wake interrupted threads

This is the tool that makes everything surfaceable. Accept any arguments. Get funky.

## Lifecycle Hooks (2)

### `lifecycle/thread.js` — Session-level grounding

Injected once at session start for thread sessions. Not for main.

This is the thread's entire universe. It defines who the agent is in a thread, how it behaves, what it can do, and how it relates to other threads and mindsets. **This injection is not short.** It's comprehensive — this is how we design the system's behavior. It goes at the top of the session context.

Contains:
- Thread identity and autonomy rules
- **Plan-first workflow** — read → plan → wait for approval → execute. Never jump straight to implementation. User sees the approach and agrees before anything changes.
- Scope management
- Identity bridge (one agent, multiple modes)
- Collaboration model (files, not messages)
- Closing behavior
- Dynamic context: which mindset, thread metadata (injected dynamically from session key)

Whether tool descriptions should differ for thread vs main contexts is an open question — tools might be used slightly differently in each context.

### `lifecycle/turn.js` — Per-turn message analysis

Fires on every user message for both main and thread sessions.

For main: injects dispatcher identity + active threads list + routing advice.
For threads: injects routing advice + scope context.

**The analysis mechanism:**
1. Gathers active threads list (names, mindsets, last activity)
2. Forks the current conversation into an ephemeral subagent
3. Subagent has: the user's message, current thread scope, all active threads, all mindsets
4. Subagent returns structured advice: routing + naming + parallelism recommendations
5. Advice is POSTED as a visible block in Discord (user sees it, can override)
6. Advice is also injected into the agent's turn context

The fork-and-analyze mechanism uses `runtime.agent.runEmbeddedPiAgent` — an in-process native agent run. The implementation:
1. Copy the current session JSONL to a temp file (fork)
2. Call `runEmbeddedPiAgent` with the fork + analysis prompt + `disableTools: true`
3. Read `result.payloads[0].text` for the analysis
4. Delete the temp file

This runs natively through OpenClaw — model resolution, auth profiles, usage tracking all work. The forked session has the full conversation history. 3-10s latency. Use a cheaper model for analysis to keep it fast.

On failure: fall back to no advice rather than blocking the turn.

**Visible analysis block example:**

> 📋 **Message analysis**
> - This mindset's threads: "DNS — records" (active), "DNS — monitoring" (paused)
> - Other mindsets: "CSS grid refactor" in #design-engineer (active)
> - Recommendation: answer directly — this is in scope

## Architecture — Cross-Agent Communication

> Validated 2026-03-29. 17 tests, 0 failures across all 4 mindsets.
> Research: #wake-path-fragility thread in #infra forum.

Two primitives. Nothing else works — see "Why everything else failed" below.

### Primitive 1: Webhook Thread Creation

For opening new threads. Single webhook POST with `thread_name` creates the forum thread and posts the bootstrap as the opening message — all from the dispatch identity.

```js
await discord.webhookPost(webhookUrl, null, null, "Justin", null, {
  thread_name: title,
  wait: true,
  embeds: [{ author: { name: "Thread Opened" }, description: bootstrap, color: 0x57F287 }],
});
```

Dispatch identity passes self-filter → OpenClaw processes as inbound → session established → agent wakes with full bootstrap in context. OpenClaw extracts embed content. No bot mention needed. No CLI cold wake.

**Known Discord quirk (#6839):** Sometimes the webhook message isn't the "original post" — shows as "Original message was deleted." Content still arrives and agent still wakes. Cosmetic only.

### Primitive 2: Steer (Discord Webhook)

For all subsequent messages to threads. One HTTP POST.

```bash
curl -X POST "<webhookUrl>?thread_id=<threadId>" \
  -H "Content-Type: application/json" \
  -d '{"content": "<@BOT_ID> <message>", "username": "Justin", "avatar_url": "<avatar>"}'
```

The webhook posts as a different Discord user identity (`author.id` ≠ bot's user ID). OpenClaw's self-filter passes it. With `allowBots: true` and the webhook ID in the guild users allowlist, the message is processed as a normal inbound. The agent responds through standard Discord session delivery.

**Urgent steer** (abort current work first):
```js
await webhookPost(threadId, `<@${BOT_ID}> /stop`);
await sleep(1000);
await webhookPost(threadId, `<@${BOT_ID}> ${message}`);
```

### Config required

```json5
{
  channels: {
    discord: {
      allowBots: true,  // process webhook messages (default: false)
      guilds: {
        "<guildId>": {
          users: [
            "<human_ids>",
            "<webhook_id_per_forum>"  // one per forum channel
          ]
        }
      }
    }
  }
}
```

### Webhook setup

One webhook per forum channel (Discord scopes webhooks to their parent channel). Created once during `mindsets add`, stored in extension config.

```js
const wh = await discord.createWebhook(forumId, { name: 'Justin Dispatch' });
// Store wh.id + wh.token
// Add wh.id to guilds.users allowlist in openclaw.json
```

### The three operations

**1. Open** — Single webhook POST creates forum thread + posts bootstrap. Done.

```js
// One call: webhook creates thread, posts bootstrap as embed from dispatch identity.
// Dispatch identity passes self-filter → OpenClaw processes as inbound → agent wakes.
// Agent reads embed content via OpenClaw extraction. No bot mention needed.
const result = await discord.webhookPost(webhookUrl, null, null, "Justin", null, {
  thread_name: title,
  wait: true,  // returns thread ID
  embeds: [{ author: { name: "Thread Opened" }, description: bootstrap, color: 0x57F287 }],
});
const threadId = result.channel_id;
```

**2. Steer** — Webhook POST to existing thread.

```js
await fetch(`${webhookUrl}?thread_id=${threadId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: `<@${BOT_ID}> ${message}`, username: 'Justin', avatar_url: AVATAR })
});
```

**3. Cross-thread state sharing** — Files. No direct messaging between sessions.

### Why everything else failed

| Approach | Failure |
|----------|---------|
| `sessions_send` | Delivers reply to sender, not thread |
| `gateway call agent` | Needs in-memory channel binding (only from Discord inbound) |
| `/hooks/agent` | Agent runs but Discord delivery fails (no delivery context) |
| Bot `message` tool | Self-filter drops it (same `author.id`) |
| Session file patching | Gateway uses runtime state, ignores persisted files |
| v1 `/mindsets/wake` | Spawned wrong command (`gateway call agent` not `openclaw agent`) |

### Silent failure modes (cold wake only)

CLI spawn is fire-and-forget. If it fails, nobody knows.

**Mitigation:** `debug` tool detects zombies (bootstrap posted, no agent response >5min).

Webhook steers are observable — Discord returns 204 on success, errors on failure.

### Steer concurrency

Steers queue behind active turns. OpenClaw's session lane serializes them — the agent finishes its current work, then processes the steer. Steers do not interrupt.

For urgent steers, send `/stop` via webhook first. `/stop` aborts the current run and clears the queue. Then send the steer message. Two webhook POSTs, ~1s apart.

### Known issue: stuck delivery queue

When agent runs fail to deliver to Discord (e.g., from `gateway call agent` or `/hooks/agent` — approaches that don't work), failed entries accumulate in `~/.openclaw/delivery-queue/`. These retry constantly, triggering plugin re-registration every ~5 seconds, degrading gateway performance.

The `debug` tool should detect entries in `delivery-queue/` with `lastError: "Outbound not configured for channel: discord"` and move them to `delivery-queue/failed/`.

### Rules

1. Thread creation = webhook POST with `thread_name`. Steer = webhook POST with `thread_id`. Both are webhooks.
2. One webhook per forum channel. Store ID + token.
5. Files are the only shared state between threads.
6. Main pulls via `status`. Never injects into thread sessions.
7. Threads don't push to main. The user bridges contexts.
8. Steers queue behind active turns. Use `/stop` + steer for urgent.
9. Monitor `delivery-queue/` for stuck entries — clean immediately.

## File Structure

```
mindsets/
  index.js                         — entry point: imports + registers
  openclaw.plugin.json             — plugin manifest
  package.json                     — npm metadata (zero dependencies)
  TRUTH.md                         — this document (source of truth)
  README.md                        — public-facing

  tools/
    status.js
    open.js
    close.js
    update.js
    mindsets.js
    debug.js

  lifecycle/
    thread.js
    turn.js
```

12 files. Tools in `tools/`, lifecycle hooks in `lifecycle/` with prompts inlined.

## Confirmed Architecture (validated against OpenClaw source)

### Hook API — `before_prompt_build`

**Signature:** `(event: { prompt, messages }, ctx: { agentId, sessionKey, sessionId, workspaceDir, channelId, trigger }) => { systemPrompt?, prependContext?, prependSystemContext?, appendSystemContext? }`

The hook receives full session context including `agentId`, `sessionKey`, and `channelId`. Thread detection is possible by parsing `sessionKey` (format: `agent:<agentId>:discord:channel:<threadId>`).

**Four injection points:**
- `prependSystemContext` — prepended to system prompt, cacheable by providers. Use for static grounding (`thread.js`).
- `appendSystemContext` — appended to system prompt, cacheable. 
- `prependContext` — per-turn dynamic text, before messages. Use for routing advice (`turn.js`).
- `systemPrompt` — replaces entire system prompt (don't use).

**Mapping:**
- `thread.js` → `prependSystemContext` (static thread grounding, cacheable)
- `turn.js` main identity → `prependSystemContext` (static main identity, cacheable)  
- `turn.js` routing advice → `prependContext` (dynamic, per-turn)

### Subagent API — `api.runtime.subagent`

**Confirmed working** in v1's triage tool:
```js
const { runId } = await runtime.subagent.run({
  sessionKey: `agent:main:subagent:triage-${Date.now()}`,
  message: userMessage,
  systemPrompt: "...",
  deliver: false,
  model: "anthropic/claude-sonnet-4-20250514",
  idempotencyKey: crypto.randomUUID(),
});
const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 15000 });
await runtime.subagent.deleteSession({ sessionKey });
```

Supports: custom model, system prompt, deliver:false, cleanup.

**❌ CANNOT use `runtime.subagent` inside `before_prompt_build`.** Error: "Plugin runtime subagent methods are only available during a gateway request." Subagent API is scoped to tool handlers only.

**✅ CONFIRMED: `runtime.agent.runEmbeddedPiAgent` works inside `before_prompt_build`.** This is the native, in-process way to run an agent turn from within a hook. Uses OpenClaw's model resolution, auth profiles, and usage tracking — no API bypass.

**Session forking mechanism:**
1. Locate the current thread's session JSONL file (from session store)
2. Copy it to a temp file (`cpSync`)
3. Call `runEmbeddedPiAgent` with the forked session file + analysis prompt
4. Get reply from `result.payloads[0].text`
5. Delete the temp file

The forked agent sees the full conversation history because it's reading the same JSONL format. Tested: the embedded agent correctly analyzed the thread's content. 3-10s latency depending on context size. Native model resolution picked the configured default (claude-opus-4-6).

For production, pass a cheaper/faster model to keep analysis latency low.

### Discord API

Direct REST with bot token from config. No special plugin API needed:
```js
const token = loadConfig().channels?.discord?.token;
fetch(`https://discord.com/api/v10/channels/${id}/messages`, {
  headers: { Authorization: `Bot ${token}` }
});
```

### Thread Detection

Parse `ctx.sessionKey` from the hook's second argument:
- Main: `agent:main:discord:channel:<mainChannelId>`
- Thread: `agent:<mindsetId>:discord:channel:<threadId>`

Compare against known main channel ID or check if the channel has a parent forum.

## Open Questions

- ~~**`steer` delivery:**~~ RESOLVED. Discord webhook POST. Webhook has different `author.id` from bot → passes self-filter. Requires `allowBots: true` + webhook ID in guild users allowlist. Validated: 17 tests, 0 failures. Urgent steer supported via `/stop` + message.
- ~~**Subagent in hook:**~~ RESOLVED. `runtime.subagent` doesn't work in hooks. `runtime.agent.runEmbeddedPiAgent` works natively — fork session JSONL, run embedded agent, get reply. 3-10s latency. Full OpenClaw model resolution, auth, and usage tracking.
- **Tool descriptions:** Should they differ for main vs thread contexts?
- **Mindset rename/reframe:** Complex operation. Deferred to future work.
