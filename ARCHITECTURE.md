# Cross-Agent Communication Architecture

> Owner: Infra. Last updated: 2026-03-29.

## Recommendation

One communication primitive: **`openclaw agent` CLI with explicit delivery.**

```bash
openclaw agent \
  --agent <mindset> \
  --message "<text>" \
  --deliver \
  --reply-channel discord \
  --reply-to "channel:<threadId>" \
  --timeout 300
```

This is the only path that works for all cases — cold start, warm wake, cross-agent. It bypasses the gateway's session delivery system entirely and posts directly to Discord. Two real hops: CLI runs agent, CLI delivers to Discord.

Everything else we tested fails. Don't use `/hooks/agent`, `gateway call agent`, `sessions_send`, or session file patching for cross-agent communication. They all break on Discord delivery.

## Why This Works (and nothing else does)

OpenClaw's outbound delivery requires an in-memory channel binding created by a Discord inbound message. No API can create this binding. The CLI sidesteps the problem — `--deliver` + `--reply-to` make the CLI itself call Discord's API, completely bypassing session delivery context.

## The Three Operations

### 1. Open (create thread + start agent)

```
Extension creates Discord thread → posts bootstrap → spawns CLI → done
```

```js
const thread = await discord.createThread(forumId, title);
await discord.sendMessage(thread.id, bootstrap);
spawn(which.sync('openclaw'), [
  'agent', '--agent', mindsetId,
  '--message', bootstrap,
  '--deliver', '--reply-channel', 'discord',
  '--reply-to', `channel:${thread.id}`,
  '--timeout', '300'
], { detached: true, stdio: 'ignore' });
```

Fire-and-forget. Extension returns immediately.

### 2. Steer (send follow-up to existing thread)

Post a message in the thread via the `message` tool. This creates a real Discord inbound — the session picks it up and the agent responds through normal delivery. No CLI spawn needed.

```js
await api.tools.message({ action: 'send', channel: 'discord', target: `channel:${threadId}`, message: steerText });
```

This only works when posted as a human (not the bot — bots ignore their own messages). For programmatic steering, the CLI cold-wake path works for the first message only. After that, the thread is autonomous — steer it by posting in Discord.

### 3. Cross-thread state sharing

Files. No direct messaging between sessions.

```
Thread A writes → workspace file → Thread B reads
```

Bootstrap tells each thread which shared files to use. Read-before-write.

## Silent Failure Modes

The CLI spawn is fire-and-forget. If it fails, nobody knows.

- **Binary not found / spawn error** → silent. Extension already returned success.
- **Gateway down** → CLI exits to void. Silent.
- **Model error** → gateway logs show it, but nothing in Discord.

**Mitigation:** The `debug` tool checks for threads with bootstrap posted but no agent response after 5 minutes. That's the only safety net.

## Rules

1. Always use `openclaw agent` CLI for cross-agent communication. No exceptions.
2. Always `which openclaw` for the binary path. Never hardcode.
3. Always detached spawn with `stdio: 'ignore'`. Extension must not wait.
4. Files are the only shared state between threads.
5. Main reads thread status from Discord messages. Never injects into thread sessions.
6. Threads escalate to main by posting in #justin via the `message` tool.
