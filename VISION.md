# Mindsets v2 — Vision Document

> Living doc. Last updated: 2026-03-29.

## The Insight

Task management doesn't work for agents. Completion criteria, blockers, status tracking — it's ambiguous, and agents struggle with it.

What works: **optimized context windows.** Each thread is a focused conversation space, primed with exactly the context it needs. The attention mechanism works best when the context window is scoped to a single topic.

## Core Mental Model

**Threads are context spaces, not tasks.**

- Each thread is an independent, primed context window about one topic
- Main is a **dispatcher** — it routes, it doesn't orchestrate
- Once a thread is spawned, it's **autonomous** — no report-back-to-main flow
- No project management semantics: no task states, no blockers, no completion criteria
- Threads are **flat siblings** — no hierarchy, no parent/child, no ownership chain
- Forked threads are independent the moment they're created

## Tools (6 total)

All tools available to all agents. No tool is main-only. Main's special behavior comes entirely from prompting.

### `status`(threadId?)
See what's happening. No params = list all active threads across all mindsets. Pass a threadId = deep-dive into that thread's messages and context.

### `open`(mindset, title, prompt)
Create a new thread in a mindset's forum with a bootstrap message. Three params, that's it. For forking, call `open` multiple times. For reframing, call `open` then `close`.

### `close`(threadId?)
Close a thread. No threadId = close yourself. Pass a threadId = close that one. Two modes, same tool:
- **"We're done here"** — natural wrap-up. Brief summary, archive, move on.
- **"Close those threads"** — managing other threads deliberately.

Prompting teaches the distinction: when Dom says "done", just wrap up. Don't be ceremonial.

### `update`(threadId?, title?, steer?)
Update an existing thread. Two capabilities, one tool:

- **`title`** — rename the thread.
- **`steer`** — inject direction into the thread's conversation. Main tells the thread what to do next without Dom having to context-switch.

Examples:
- `update(threadId, title: "DNS cleanup — TTLs")` — rename only
- `update(threadId, steer: "Also check TTL values on the A records")` — steer only
- `update(threadId, title: "...", steer: "...")` — both

**How `steer` works under the hood:**
The extension decides the delivery mechanism — wake the session if idle, inject if active. The agent doesn't care about that distinction. It just says "steer this thread toward X" and the plumbing handles it.

**Why `steer` and not `message`:** This is directional guidance from main, not a chat message. The thread knows it's a course correction, not Dom typing directly. The naming communicates intent.

Extensible later: tags, priority, shared state, cross-thread links — same tool.

### `mindsets`(action, ...)
Manage mindsets. Subcommands: add, remove, list, inspect. Prompting discourages use from threads — practically a main concern.

### `debug`(...)
Deep introspection. Health check, zombie detection, session state, log inspection, binding state, wake history, prompt injection state, session recovery. The "look under the hood" tool. Heartbeat calls this. Always in prod, never pollutes.

### How routing works (`consider` — lifecycle hook, not a tool)

Every turn gets automatic message analysis before the agent starts thinking. The `consider` hook:

1. Fires on every user message (via `before_prompt_build` or similar)
2. Spawns an ephemeral subagent with: the message, thread scope/mindset, active threads, available mindsets
3. Subagent returns structured advice: "answer directly" / "open thread in X mindset" / "split into A and B" / "continue in existing thread Y"
4. Advice is injected inline into the turn context — agent sees it before it starts responding
5. Agent acts accordingly using `open`, `update`, or just answers

**No tool call needed.** The analysis happens automatically. The agent never decides "should I check routing?" — it's always checked.

**The identity bridge:** The subagent's prompt frames routing as organizational filing — "we want things in the right place in Discord" — not delegation to a separate agent. The agent says "let me open this in #infra" not "let me delegate to sysadmin." Mindsets are thinking modes, not people.

**Latency:** Adds 2-5s per turn for the ephemeral subagent. Accepted tradeoff for consistent routing. Can optimize later (cheaper model, caching).

**What it replaces from v1:** `triage` tool (now automatic, not agent-initiated, and available for all agents not just main).

**Standard routing still applies on top:**
- `main-turn.js` injects the active threads list every turn — main already knows what exists
- **Dom wants to go there himself?** Reply with a link: "let's continue this in <#threadId>"
- **Dom wants something passed along?** Call `update(threadId, steer: "...")` — inject direction without Dom leaving main
- **New context needed?** Call `open`

### What's gone from v1 (13 → 6 tools + 1 hook)

`triage` → `consider` lifecycle hook (automatic, not a tool) | `topic` → `open` | `refocus` → `open` + `close` | `continue` → `update(steer:)` | `board` → `status` | `report` → cut | `query` → cut | `inspect` → `status(threadId)` + `debug` | `recover` → `debug` | `health` → `debug` | `rename` → `update(title:)` | `steer` → `update(steer:)` | `add_mindset` / `remove_mindset` → `mindsets`

## Bootstrap Message

The first message in every thread — visible in Discord to both Dom and the agent.

**It's a free-form string.** Generated by the calling agent. No rigid schema. The agent decides how much structure each thread needs.

### Recommended format (guidance, not enforced)

```
## [title]

**Scope:** What this thread is about
**Constraints:** What this thread should NOT touch
**Closes when:** When this conversation is done

**Context:**
Relevant background. Must be self-contained — the new thread can't see the parent's history.

**Priming:**
- Read: [relevant files]

---
⚠️ Do not implement until user confirms intent.
```

### Cross-thread collaboration
When multiple threads work on related things, the bootstrap should mention:
- Shared files to collaborate through (no direct thread-to-thread comms)
- Read-before-write protocol

## Prompt Architecture

Every prompt is a separate file. Change one, test one. No prompt buried in code.

### Two layers, two delivery mechanisms

| Layer | Where it lives | Visible in Discord? | Purpose |
|-------|---------------|---------------------|---------|
| **Bootstrap** | First Discord message in thread | ✅ Yes | Topic, scope, context. The thread's "about" page. |
| **Grounding** | Session/turn injection | ❌ No | Agent worldview. "You are a thread, here's your toolkit." |

### Injection architecture

**Static markdown (root):**
- `main.md` — main's identity as dispatcher. Routing philosophy, mindset awareness.
- `thread.md` — thread grounding. "You are a thread within a mindset." Tools, autonomy, collaboration.

**Dynamic lifecycle hooks (`lifecycle/`):**
- `thread.js` — session-level: imports `thread.md`, layers on dynamic context (mindset info, thread metadata)
- `turn.js` — per-turn: runs ephemeral message analysis, detects main vs thread, injects routing advice + context. For main: includes active threads list. For threads: includes scope info. One file handles both contexts.

**Key design choice:** Main gets the full threads list every turn (it's the dispatcher). Mindset threads get grounding only — no threads list. If a thread needs awareness, it calls `status` on demand. This keeps thread context windows lean.

### No skill file

The v1 skill (`mindsets/SKILL.md`) is gone. Everything is injected directly via `before_prompt_build`. No skill description size limits, no split between "always injected" and "read on demand." Static markdown + dynamic lifecycle hooks ARE the injection — reliable, complete, no workarounds.

### Prompt landscape (what we control vs native)

**We control (iterate on these):**
- `main.md`, `thread.md` (static identity)
- `lifecycle/*.js` (dynamic injection + consider)
- Tool descriptions in code

**Native OpenClaw (don't touch from extension):**
- `workspace-*/AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`
- `skills/justin/SKILL.md` (needs updating separately to remove stale task management refs)
- `skills/proactivity/SKILL.md`, `skills/heartbeat/SKILL.md`

## Wake Mechanism

> See `TRUTH.md` for the validated cross-agent communication architecture.
> Two primitives: CLI cold wake + Discord webhook steer. 17 tests, 0 failures.
> Research history: thread #wake-path-fragility in #infra forum.

### What works today

```bash
openclaw agent --agent <mindset> \
  --message "<bootstrap brief>" \
  --deliver \
  --reply-channel discord \
  --reply-to "channel:<threadId>" \
  --timeout 300
```

Validated 2026-03-29: cold wake, warm wake, post-reset, concurrent, cross-agent, special characters — all pass. Binary resolution via `which openclaw`, never hardcoded.

### The `open` flow
1. Create thread via Discord API in the mindset's forum
2. Post bootstrap message as the first message
3. Spawn `openclaw agent` as detached child process (fire-and-forget)
4. Return immediately with `{ ok: true, threadId }`
5. Post `<#threadId>` link back in the originating channel

## Assumptions

- **Thread creation requires raw Discord API.** `sessions_spawn({ thread: true })` can't target a specific forum. Needs re-check if OpenClaw adds this.
- **Native routing handles thread → agent mapping.** `bindings[]` + parent-peer inheritance. No custom routing needed.

## Dead Code (remove from v1)

- `thread-bindings.json` + `focusThread()` / `unfocusThread()` — dead, never used
- `sessions_send` between main and threads — removed, caused phantom bindings
- `index.js.refactored`, `index.js.backup-*`, `src/index.ts` — stale files

## Implementation

### Strategy: separate extension

Build `openclaw-mindsets-v2` alongside v1. Test, then swap. If it breaks, swap back.

### File structure

```
openclaw-mindsets-v2/
  index.js                         — thin entry point: imports tools + lifecycle, registers hooks
  openclaw.plugin.json
  package.json
  VISION.md                        — this document
  main.md                          — static: main's identity, routing philosophy
  thread.md                        — static: thread grounding, autonomy, collaboration

  tools/
    status.js                      — status tool (list threads / deep-dive)
    open.js                        — open tool (create thread + bootstrap + wake)
    close.js                       — close tool (archive + lock + cleanup)
    update.js                      — update tool (title, extensible)
    mindsets.js                    — mindsets tool (add/remove/list/inspect)
    debug.js                       — debug tool (health/zombies/logs/recovery)

  lifecycle/
    thread.js                      — session-level: imports thread.md + dynamic context
    turn.js                        — per-turn: message analysis + context injection (main + thread)
```

14 files. Tools in `tools/`, dynamic lifecycle hooks in `lifecycle/` (JS functions that compute injection strings), static identity/grounding as `main.md` + `thread.md` in root. No skill directory — everything injected via `before_prompt_build`.

### Phases

1. **Scaffold** — extension structure, tool registration, prompt files
2. **Core tools** — `open`, `close`, `status`, `update`
3. **Prompt injection** — wire `before_prompt_build`, iterate on wording
4. **Structural** — `mindsets`, `debug`
5. **Skill consolidation** — rewrite skill files, update stale refs
6. **Swap** — disable v1, enable v2, test, clean up

## Typing Indicator

- Check what OpenClaw does natively first
- If custom typing needed, MUST stop when agent finishes (v1 bug: typing persists 120s)
- Test during build (Phase 2)
