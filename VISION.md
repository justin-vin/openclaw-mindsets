# Mindsets v2 — Vision Document

> Living doc. All mindsets contribute. Last updated: 2026-03-29.

## The Insight

Task management doesn't work for agents. Completion criteria, blockers, status tracking — it's ambiguous, requires heavy taxonomy thinking, and agents (and humans) struggle with it.

What *does* work: **optimized context windows.** Each thread is a focused conversation space, primed with exactly the context it needs. The attention mechanism works best when the context window is scoped to a single topic.

## Core Mental Model

**Threads are context spaces, not tasks.**

- Each thread is an independent, primed context window about one topic
- Main is a **dispatcher**, not a coordinator — it routes, it doesn't orchestrate
- Once a thread is spawned, it's **autonomous** — no report-back-to-main flow
- Main maintains **board awareness** for answering "what's going on?" and cleanup
- No project management semantics: no task states, no blockers, no completion criteria

## Key Capabilities

### 1. Dispatch (Main only)

**Triage** — an ephemeral routing agent that reads inbound messages, checks active threads and mindset descriptions, and decides:
- Route to existing thread (`continue`)
- Create new thread (`topic`)
- Reply directly (no specialist needed)

**Topic** — create a new thread in the right forum with a **bootstrap message** that primes the context window.

### 2. Bootstrap / Prime

Every new context window gets seeded with structured context:
- What this thread is about
- The scope and constraints
- Relevant context from the dispatch
- What the mindset should focus on
- Guard rails

This is the key differentiator. A well-primed context window is dramatically more effective than a cold start.

### 3. Board Awareness (Main + all mindsets?)

Main knows what's active across all forums. Used for:
- Answering "what's everyone working on?"
- Spotting cleanup opportunities (stale threads)
- Avoiding duplicate threads on the same topic

### 4. Refocus / Fork (Any thread)

Any thread can split itself when the conversation would benefit:
- **Reframe** (1 new thread) — close current, open cleaner version
- **Fork** (2+ new threads) — decompose into parallel conversations
- **Side chat** — spawn a related thread without closing current
- Carries forward relevant context to new thread(s)

**Open question:** Should this be limited to within own mindset, or cross-mindset too? Leaning toward cross-mindset — a sysadmin thread might realize part of the discussion is a design-engineer concern.

### 5. Cleanup (Main)

- Close stale threads
- Archive resolved conversations
- No task-state ceremony — just "this conversation is done"

## What's Gone (vs v1)

- ❌ Task states (blocked, in-progress, done, cancelled)
- ❌ Completion criteria
- ❌ Main waiting for / coordinating responses
- ❌ `report` tool — no reporting. Threads are autonomous. If the user needs something from a thread, they go to it.
- ❌ `query` tool — no silent querying. Instead, main surfaces existing relevant threads to the user ("go discuss this over there, it'll be a better fit" + link).
- ❌ Project management semantics
- ❌ Session store management (lean on OpenClaw native sessions)

## Tool Inventory (v2 Final)

### All threads get (5 tools):

- **`open`** — Create a new thread in any mindset's forum with a bootstrap message. Three params: mindset, title, prompt. For forking, call `open` multiple times. For reframing, call `open` then `close`. Subsumes v1's `topic` and `refocus` into one tool.
- **`close`** — Close a thread. No threadId = close yourself. Pass a threadId = close that one. Can close multiple. No reporting, no ceremony.
- **`threads`** — Two modes. No params = list all active threads across all mindsets (the board view). Pass a threadId = dive into that thread and read its recent messages/context. Replaces v1's `board` and `inspect` in one tool. Also injected per-turn via grounding (list mode), so agents often already know the high-level state without calling this.
- **`rename`** — Update a thread's title to reflect the current conversation state. (Not available to main — main isn't a thread.)
- **`health`** — System health check, used on heartbeats.

### Main only gets (2 extra tools):

- **`add_mindset`** — Create a new mindset (forum + agent + workspace).
- **`remove_mindset`** — Delete a mindset.

### How routing works (no tool needed)

Main does NOT have a routing/triage tool. Instead:
- The per-turn grounding injection includes the active threads list (from `before_prompt_build`)
- Main already knows what threads exist every turn
- When a message fits an existing thread, main just replies with a link: "let's continue this in <#threadId>"
- When a new context window is needed, main calls `open`
- No triage subagent. No routing tool. Just the agent being smart with the context it has.

This eliminates the Sonnet subagent token burn from v1's triage tool and removes the continue/route/triage complexity.

### What's gone from v1

- ~~`triage`~~ — routing intelligence lives in main's grounding prompt + per-turn thread injection
- ~~`topic`~~ — merged into `open`
- ~~`refocus`~~ — merged into `open` (with `closeCurrent: true`)
- ~~`continue`~~ — main surfaces links to existing threads instead of posting into them
- ~~`board`~~ — renamed to `threads`
- ~~`report`~~ — no reporting. Threads are autonomous.
- ~~`query`~~ — no silent querying. Main surfaces links instead.
- ~~`inspect`~~ — removed (was a debug tool)
- ~~`recover`~~ — removed (lean on native session recovery)

**7 tools total.** Down from 13 in v1.

## Bootstrap Message (Critical — get this right)

The bootstrap is the first message in every thread — visible in Discord to both Dom and the agent. It's what makes primed context windows dramatically better than cold starts.

### It's a free-form string

The bootstrap is generated by the calling agent as a plain string. No rigid schema, no enforced fields. The agent decides how much structure each thread needs. Simple threads get a short prompt. Complex threads get a detailed brief.

### Recommended format (guidance for the agent, not enforced)

```
## [title]

**Scope:** What this thread is about
**Constraints:** What this thread should NOT touch
**Closes when:** When this conversation is done

**Context:**
Relevant background from the parent conversation or dispatch.
Must be self-contained — the new thread cannot see the parent's history.

**Priming:**
- Read: [relevant files or skills]

---
⚠️ Do not implement until user confirms intent.
```

The guard rail ("do not implement until user confirms intent") should be included in every bootstrap by default. Prevents threads from sprinting to implementation before Dom has weighed in.

### Cross-thread collaboration (when needed)
When multiple threads work on related things, the bootstrap should mention:
- Shared files to collaborate through (not direct thread-to-thread comms)
- Read-before-write protocol
- No `sessions_send` between threads — all coordination via shared files

### The `open` tool builds this

```
open({
  mindset: "sysadmin",              // which forum to create the thread in
  title: "DNS migration plan",      // thread title
  prompt: "## DNS migration...",    // the bootstrap message (free-form string)
})
```

Three params. That's it. If the agent wants to reframe (close current + open new), it just calls `open` then `close` — two tool calls, no special param needed. The agent is smart enough to compose.

## Wake Mechanism (✅ Validated — 2026-03-29)

### The Problem

OpenClaw's Discord integration is **reactive**: a message arrives in a thread, bindings match it to an agent, the agent runs a turn, and the reply goes back to the same thread. There is no native primitive for "trigger an agent turn in thread X without an inbound user message." But that's exactly what the extension needs — when main dispatches work to a mindset forum, something must make that mindset start responding in the new thread.

### The Solution

```bash
openclaw agent --agent <mindset> \
  --message "<bootstrap brief>" \
  --deliver \
  --reply-channel discord \
  --reply-to "channel:<threadId>" \
  --timeout 300
```

This runs a full agent turn using the specified mindset's workspace and persona, then delivers the reply to the target Discord thread. One process spawn, one command, deterministic delivery.

**Binary resolution:** Use `which openclaw` at extension startup (or `process.execPath` from Node), never hardcode `/opt/homebrew/bin/openclaw`.

### Why This Works

The `openclaw agent` CLI runs the agent via the **embedded runner** (same runtime as gateway-hosted turns, but invoked locally). The `--deliver` flag with `--reply-channel discord --reply-to channel:<id>` explicitly tells the runner where to send the output, bypassing the need for a pre-existing session route.

The agent gets the full workspace context (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, skills) because `--agent <mindset>` resolves the mindset's workspace directory. The `--message` content becomes the user turn, so the bootstrap brief is what the agent responds to.

### What Was Tested

All tests ran against real Discord threads in the #sysadmin forum (2026-03-29):

| Scenario | Result | Notes |
|----------|--------|-------|
| **Cold wake** (brand new thread, no prior session) | ✅ | Agent responds in thread it has never seen before |
| **Warm wake** (thread with existing session) | ✅ | Agent continues in thread with prior context |
| **Post-reset wake** (session deleted, simulating 2h idle reset) | ✅ | Re-creates session and delivers normally |
| **Concurrent wakes** (two threads simultaneously) | ✅ | Both deliver to correct threads, no cross-contamination |
| **Long multi-paragraph brief** (97 words, markdown, headers, lists) | ✅ | Full content delivered and understood by agent |
| **Special characters** (quotes, backticks, emoji, newlines, tabs) | ✅ | All handled correctly |
| **Cross-agent delivery** (design-engineer agent → sysadmin forum thread) | ✅ | `--agent` controls who runs, `--reply-to` controls where output goes |
| **Duplicate idempotency key** (via `gateway call agent`) | ✅ | Returns same result, no duplicate turn |
| **Missing required params** | ✅ | Properly rejected with clear error |

### What Was Ruled Out

| Approach | Why It Doesn't Work |
|----------|-------------------|
| `gateway call agent` with `deliver: true` | Fails: `Outbound not configured for channel: discord`. The gateway RPC agent method doesn't wire up Discord outbound for programmatic calls. |
| `gateway call agent` with `replyChannel` / `replyTo` | Same error — these params aren't supported on the gateway RPC path. |
| `gateway call agent` with just `sessionKey` | Only works if the session already has a `lastRoute` from a prior Discord inbound. Fails on cold wake (new threads). |
| `sessions_send` | Delivers to the session but doesn't control which channel the response goes to. Creates phantom binding conflicts. |
| `api.runtime.subagent.run()` | Designed for subagent session keys (`agent:<id>:subagent:<uuid>`), not channel session keys. Untested for `agent:<id>:discord:channel:<threadId>` — may work but unvalidated. |

### Known Behaviors

1. **No thread history on cold wake.** The embedded runner doesn't read Discord thread messages — the agent only sees what's in its session transcript plus the `--message` content. This means the bootstrap brief must be self-contained. This is fine because the extension controls what goes in `--message`.

2. **Incomplete session metadata after CLI wake.** The session created by `openclaw agent` has `deliveryContext: { channel: "discord" }` but no `to` or `accountId`. The first real Discord inbound (e.g., Dom replying in the thread) populates the full delivery context. This doesn't affect functionality — subsequent user messages in the thread trigger normal Discord inbound handling.

3. **Session persistence varies.** The embedded runner doesn't always persist the session to the gateway's session store. This is harmless because each wake via `openclaw agent` is self-contained and doesn't depend on prior session state.

### Implementation in the Extension

The wake flow from the extension's perspective:

1. **Create thread** — use Discord message tool (`thread-create` on the forum channel)
2. **Post bootstrap** — the thread-create message IS the bootstrap (thread title + body)
3. **Wake the mindset** — spawn `openclaw agent` as a detached child process:
   ```typescript
   const bin = execSync("which openclaw").toString().trim();
   const child = spawn(bin, [
     "agent",
     "--agent", mindsetId,
     "--message", briefText,
     "--deliver",
     "--reply-channel", "discord",
     "--reply-to", `channel:${threadId}`,
     "--timeout", "300"
   ], { detached: true, stdio: "ignore" });
   child.unref();
   ```
4. **Return immediately** — the tool handler returns `{ ok: true, threadId }` to main without waiting for the mindset to finish

Error detection: check `child.pid` exists. For optional verification, poll the thread for a new message after N seconds. But fire-and-forget is the recommended default — the agent either responds or it doesn't, and the user can see the thread directly.

### Future Improvement

If OpenClaw adds `api.runtime.agent.runTurn({ agentId, sessionKey, message, deliver: { channel, to } })` to the plugin SDK, the extension can drop the CLI spawn entirely and go in-process. This would be zero-hop, zero-latency, with native promise-based error handling. Until then, the CLI path is reliable and well-tested.

## Assumptions (to be validated)

- **Thread creation requires raw Discord API.** `sessions_spawn({ thread: true })` only creates threads in the requester's current channel — it cannot target a specific forum. So the extension must keep using raw Discord API to create threads in mindset forums. Needs re-verification if OpenClaw adds a `channelId` param to `sessions_spawn`.
- **Native routing handles thread → agent mapping.** `bindings[]` + parent-peer inheritance means threads in #sysadmin auto-route to the sysadmin agent. No custom routing code needed in the extension.

## Dead Code Confirmed Removed

- **`thread-bindings.json`** — empty file, never used by any tool. `focusThread()` / `unfocusThread()` functions are dead. Native `bindings[]` + parent-peer inheritance handles routing. Kill all of it.
- **`sessions_send` between main and mindset threads** — removed from allowed tools. Was creating phantom `agent:main` session entries in mindset thread channels, causing binding conflicts.

## Discovery Link-Back

When main dispatches to a thread (new or existing), it should post `<#threadId>` back in the originating channel. The user should always see where the conversation went without hunting through forums.

Example: User asks about DNS in #justin → main routes to #sysadmin → posts "Let's discuss this in <#1234567890>" in #justin.

## Context Prompting (Session-Injected, Not Visible in Thread)

A meta-skill/system prompt section injected into every session's context but NOT shown in the Discord thread. Covers:
- When to split a conversation into a new thread
- How to think about parallel work across threads
- Shared file collaboration protocol (read-before-write)
- Awareness of other active threads (via `board`)

This applies to main AND all mindset threads. It's the "how to be a good thread citizen" guide.

## Typing Indicator

The agent should show typing when it starts working on a response. But:
- Need to understand what OpenClaw does natively (does the Discord channel already show typing during agent turns?)
- If native typing works, don't add a custom typing loop
- If custom typing is needed, it MUST stop when the agent finishes (current v1 bug: `stopTypingLoop()` never called, typing shows for up to 120s after reply)

## Self-Close (Thread tool)

Threads need the ability to close themselves. When a conversation is done — the question is answered, the work is complete, the topic is resolved — the thread should be able to mark itself as closed.

**Tool: `close` (existing tool — extend to all threads)**

Already works in v1 for main. The only change: make it available to mindset threads too. Same tool, wider scope.

- Can close own thread (omit `threadId`) or any other thread (pass `threadId`)
- No reporting to main. No ceremony. Direct action.
- Archives + locks the Discord thread, posts brief summary, cleans up session.

## Thread Grounding (Per-Thread System Prompt)

Every thread session needs to be grounded into the same mental model. This is different from the bootstrap message (which is topic-specific) — this is the **shared worldview** that every thread gets.

### What every thread should know (injected via `before_prompt_build` or session system prompt)

```
You are a thread within a mindset, within a larger system.

- You are one context window focused on one topic
- You are part of Justin, a multi-mindset AI identity
- Your mindset is [sysadmin/design-engineer/pa/wordware]
- Your thread: "[thread title]"
- You are autonomous — no one coordinates you, no one waits for your output
- The human (Dom) interacts with you directly in this thread
- Other threads exist in parallel — you can see them via `board` but don't coordinate with them
- If this conversation drifts or should split, use `refocus` to fork
- If this conversation is done, use `close` to archive it
- If the title no longer reflects the conversation, rename it
- Collaborate with other threads ONLY through shared files (read-before-write)
```

This grounding prompt replaces the v1 "STOP. REFOCUS." injection, but it's:
- **Role-aware** — different for main vs mindset threads
- **Dynamic** — includes the thread title, mindset, active thread count
- **Empowering** — tells threads what they CAN do (close, refocus, rename) not just what they can't

### Two layers, two delivery mechanisms

| Layer | Where it lives | Visible in Discord? | Purpose |
|-------|---------------|---------------------|---------|
| **Bootstrap** | First Discord message in thread | ✅ Yes — Dom sees it | Topic, scope, constraints, context. The thread's "about" page. |
| **Grounding** | `before_prompt_build` injection | ❌ No — session context only | Agent worldview. "You are a thread, you are autonomous, here's your toolkit." |

Bootstrap is for the human AND the agent. Grounding is for the agent only.

## Thread Model: Flat Siblings

**Threads are flat. There is no hierarchy.**

- Forked threads are independent the moment they're created
- No parent/child relationship. No ownership chain. No reporting back.
- A thread that forks into 3 new threads creates 3 independent peers, not 3 children
- The original thread can optionally stay open as an informal reference, but it has no authority over the forks
- This is a deliberate design choice — hierarchy creates coordination overhead that agents are bad at

## Per-Message Context Injection (`before_prompt_build`)

The extension hooks into every agent turn via `api.on("before_prompt_build")` to inject a system-level reminder. This is critical — it's what keeps agents on-task every single turn, not just at session start.

### Current implementation (v1)
A single hardcoded string appended to the system context for **every** agent (main and mindsets alike):
```
STOP. REFOCUS. You manage forum threads. Your obsession is giving the user the right context session...
```

### Problems with v1
- **Same prompt for main and mindsets.** Main needs "route messages to threads" reminders. Mindsets need "stay focused on your topic" reminders. They get the same thing.
- **No dynamic context.** Doesn't include the current board state, thread name, or any live information. It's static.
- **No collaboration awareness.** Doesn't tell the agent about related threads working on similar things, or shared files to coordinate through.
- **Too aggressive.** "NEVER edit files, run commands, or do work directly" makes sense for main but completely breaks mindset threads that need to do actual work.

### Vision for v2
The `before_prompt_build` hook should inject **role-specific, dynamic context** each turn:

**For main (heavier — main needs this for routing):**
- Full active threads list (titles, mindsets, activity) — main needs this every turn to make routing decisions
- Reminder to route/dispatch, not implement
- Any threads that need attention (stale, unanswered)

**For mindset threads (lightweight — keep context lean):**
- Grounding only: "you are a thread, you are autonomous, here are your tools"
- NO threads list injected — if a thread needs board awareness, it calls `threads` on demand
- This keeps mindset context windows focused on their topic, not loaded with unrelated thread metadata

This is one of the most impactful parts of the extension — a well-tuned per-turn injection keeps every context window focused and aware.

## Thread Title Management

Thread titles drift as conversations evolve. Currently there's no mechanism to update them.

**New tool: `rename` (or fold into per-message injection)**
- Threads should always reflect the *current* state of the conversation, not just the opening topic
- Could be a tool the agent calls explicitly, OR
- Could be automatic — the per-message `before_prompt_build` hook evaluates whether the title still fits and renames if needed
- Leaning toward making it part of the per-message injection: every N turns, check if the title is still accurate

**Implementation:** `discordApi("PATCH", `/channels/${threadId}`, { name: newTitle })` — it's a simple API call, the question is when/how to trigger it.

## Prompting Landscape (Consolidation Needed)

The current prompting is scattered across many files. A session gets influenced by all of these, and it's confusing to reason about what's active:

### Where prompts live today

| Layer | File | Scope | What it does |
|-------|------|-------|-------------|
| **Workspace** | `workspace-*/AGENTS.md` | Per-agent | Session startup rules, memory protocol, heartbeat guidance |
| **Workspace** | `workspace-*/SOUL.md` | Per-agent | Persona and tone for each mindset |
| **Workspace** | `workspace-*/USER.md` | Per-agent | Info about Dom |
| **Workspace** | `workspace-*/IDENTITY.md` | Per-agent | Role definition, place in the system |
| **Workspace** | `workspace-*/HEARTBEAT.md` | Per-agent | What to check on heartbeat |
| **Global skill** | `skills/justin/SKILL.md` | All agents (always:true) | Core Justin identity, mindset architecture, task management via `tasks` CLI |
| **Global skill** | `skills/proactivity/SKILL.md` | All agents | Proactive behavior guidance |
| **Global skill** | `skills/heartbeat/SKILL.md` | All agents | Heartbeat design patterns |
| **Extension skill** | `openclaw-mindsets/skills/mindsets/SKILL.md` | All agents (always:true) | Orchestration rules — triage flow, visible vs invisible tools, thread lifecycle |
| **Extension hook** | `before_prompt_build` | All agents, every turn | Per-message "STOP. REFOCUS." injection |
| **Bootstrap** | (planned, not built) | Per-thread | Structured seed message when thread is created |

### Problems
1. **Overlap and contradiction.** `justin/SKILL.md` talks about task management (`tasks` CLI, tickets, blockers). `mindsets/SKILL.md` talks about thread orchestration. They partly contradict each other on workflow.
2. **No clear hierarchy.** Which wins when SOUL.md says one thing and the mindsets skill says another?
3. **`before_prompt_build` overrides SOUL.md behavior.** The per-turn injection tells every agent "NEVER edit files" — but that's only appropriate for main.
4. **Stale references.** `justin/SKILL.md` still references `tasks` CLI and ticket-based workflow which we're moving away from.
5. **Too many injection points.** Workspace files + global skills + extension skills + per-turn hooks = hard to debug.

### v2 Goal: Consolidate
- **One source of truth per concern.** Thread orchestration rules in ONE place, not split across skill + hook + workspace.
- **Role-specific prompting.** Main gets orchestrator prompts. Mindsets get worker prompts. Not the same thing for both.
- **Audit trail.** A single doc (maybe this section of VISION.md, maybe a separate PROMPTS.md) that maps out exactly what every agent sees.
- **Kill stale references.** Update `justin/SKILL.md` to reflect context-space model, not task management.

## Architecture Goals

- **Clean, modular code.** No 1800-line monolith. Split by concern.
- **Minimal state management.** Lean on OpenClaw's native session lifecycle.
- **No dead code.** No backup files, no stubs, no unused layers.
- **TypeScript source of truth**, compiled to JS. No raw JS editing.
- **Bootstrap messages are first-class.** The prime/seed message format should be well-defined and extensible.

## UX Principles

- Threads are entry points — each one about a single topic, easy to find
- No ceremony — threads open fast, close clean
- Context carries forward — refocus/fork doesn't lose important context
- Board is the overview — one glance shows everything active

---

## Contributors

This is a shared doc. All mindsets should contribute their perspective:
- **Sysadmin** — extension architecture, session lifecycle, deployment
- **Design Engineer** — code structure, TypeScript setup, build pipeline
- **Main** — orchestration UX, triage logic, dispatch flow
- **PA** — user-facing experience, thread discoverability

## Next Steps

1. All mindsets review and annotate this doc
2. Resolve open questions
3. Define bootstrap message format
4. Write the new extension from scratch
