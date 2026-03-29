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

## Tool Inventory (Draft)

### Main thread tools
| Tool | Purpose |
|------|---------|
| `triage` | Ephemeral routing agent — decides: route to existing thread, create new thread, or reply directly. When an existing thread is the best fit, returns a "surface" action with a link for the user instead of silently routing. |
| `topic` | Create new primed thread in a forum |
| `board` | See all active threads across all mindsets |
| `close` | Shut down a conversation thread |

### Any thread tools
| Tool | Purpose |
|------|---------|
| `refocus` | Fork/reframe the current conversation |
| `board` | See what's active (for context, not coordination) |

### System tools (Main, on heartbeat)
| Tool | Purpose |
|------|---------|
| `health` | System health check |
| `recover` | Re-wake interrupted sessions |

### Resolved
- **`report`** — cut. No reporting flow. Threads are autonomous.
- **`query`** — cut. Replaced by main surfacing relevant thread links to the user instead of querying behind the scenes.

### Open questions
- **`inspect`** — deep dive on one thread. Debugging tool. Keep or make it a dev-only thing?
- **Cross-mindset refocus** — should a sysadmin thread be able to spawn a design-engineer thread?
- **Triage for mindsets** — should mindset threads also get triage to route sub-topics?

## Bootstrap Message (Critical — get this right)

The bootstrap/prime message is the most important part of this extension. It's what makes primed context windows dramatically better than cold starts.

### What it contains
- **Topic** — what this thread is about
- **Scope** — boundaries of this conversation
- **Constraints** — what's in/out of scope
- **Context** — relevant background from the dispatch or parent thread
- **Priming** — how the mindset should think about this
- **Guard rails** — what to avoid

### Cross-thread collaboration section
When multiple threads are working on related things, the bootstrap must include:
- **Shared artifacts** — point to a shared file/doc that threads collaborate through (not direct thread-to-thread comms)
- **Coordination protocol** — how to avoid stepping on each other's toes
- **Read-before-write** — always read shared state before modifying
- File-based collaboration is the safe default (like this VISION.md)

> 🔴 TODO: Find and incorporate the bootstrap discussion from the other conversation thread. This needs to be very nuanced.

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
