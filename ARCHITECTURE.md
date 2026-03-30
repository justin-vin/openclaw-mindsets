# Cross-Agent Communication Architecture

> Owner: Infra. Last updated: 2026-03-29.
> Status: **Validated.** All patterns tested and confirmed working.

## Two Primitives

### 1. Cold Wake: `openclaw agent` CLI

For the first message to a new thread where no session exists yet.

```bash
openclaw agent --agent <mindset> \
  --message "<bootstrap>" \
  --deliver --reply-channel discord \
  --reply-to "channel:<threadId>" \
  --timeout 300
```

The CLI bypasses session delivery context entirely — `--deliver --reply-to` makes the CLI itself call Discord's API directly. This is the only path that works for cold starts.

### 2. Steer: Discord Webhook

For all subsequent messages to threads. One HTTP POST.

```bash
curl -X POST "<webhookUrl>?thread_id=<threadId>" \
  -H "Content-Type: application/json" \
  -d '{"content": "<@BOT_ID> <message>", "username": "Justin", "avatar_url": "<justin_avatar>"}'
```

The webhook posts as a different Discord user identity. OpenClaw's self-filter checks `author.id === botUserId` — the webhook has a different author.id, so it passes. The message is processed as a normal inbound. The agent responds through standard Discord session delivery.

**Urgent steer** (abort current work first):
```js
await webhookPost(threadId, `<@${BOT_ID}> /stop`);
await sleep(1000);
await webhookPost(threadId, `<@${BOT_ID}> ${message}`);
```

## Config Required

```json5
{
  channels: {
    discord: {
      allowBots: true,  // process webhook messages (default: false)
      guilds: {
        "<guildId>": {
          users: [
            "<dom_id_1>", "<dom_id_2>",
            "<infra_webhook_id>",    // one per forum
            "<dev_webhook_id>",
            "<pa_webhook_id>",
            "<wordware_webhook_id>"
          ]
        }
      }
    }
  }
}
```

## Webhook Setup (one-time per forum)

Webhooks are channel-scoped — one per forum channel.

```js
const webhook = await fetch(`https://discord.com/api/v10/channels/${forumId}/webhooks`, {
  method: 'POST',
  headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Justin Dispatch' })
});
// Store webhook.id + webhook.token
// Add webhook.id to guilds.users allowlist
```

### Current Webhooks

| Forum | Channel ID | Webhook ID | Status |
|-------|-----------|------------|--------|
| #infra | 1487085177204379829 | 1487957064914309162 | ✅ Active |
| #pa | 1487085185714618429 | 1487949761666617376 | ✅ Active |
| #dev | 1487085181448884474 | — | Needs creation |
| #wordware | 1487085189300748343 | — | Needs creation |

## The Three Operations

### Open (create thread + cold wake)

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

### Steer (follow-up to existing thread)

```js
await fetch(`${webhookUrl}?thread_id=${threadId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: `<@${BOT_ID}> ${message}`,
    username: 'Justin',
    avatar_url: JUSTIN_AVATAR_URL
  })
});
```

### Cross-thread state sharing

Files. No direct messaging between sessions.

## Validated Test Results (2026-03-29)

| # | Test | Result |
|---|------|--------|
| 1 | CLI cold wake to new PA thread | ✅ 16s |
| 2 | Webhook steer to PA thread (fresh) | ✅ 9s |
| 3 | Webhook steer to Infra thread (fresh) | ✅ |
| 4 | Double steer (two sequential messages) | ✅ Both processed in order |
| 5 | Steer to existing thread | ✅ |
| 6 | Special chars (quotes, backticks, emoji) | ✅ |
| 7 | Race condition (steer while agent busy) | ✅ Queued, processed after current turn |
| 8 | Urgent steer (/stop then message) | ✅ Aborted essay, processed urgent message |
| 9–13 | Batch of 5 fresh thread steers | ✅ All 5 passed |

**Total: 13 tests, 13 passes, 0 failures** (after correct config).

## Why This Works

**Cold wake (CLI):** `--deliver --reply-to` is a direct instruction to the CLI process. No session lookup, no binding resolution. The CLI calls Discord's API itself.

**Steer (webhook):** Discord webhooks post as a different user identity (different `author.id`). OpenClaw's self-filter only checks `author.id === botUserId`. With `allowBots: true` and the webhook ID in the guild users allowlist, the message flows through normal inbound processing. The session's existing delivery binding handles the response.

**Urgent steer:** `/stop` is a native OpenClaw command that aborts the current run and clears the queue. Sent via webhook, it interrupts the active turn. The follow-up steer message is then processed as the next turn.

## Why Everything Else Failed

| Approach | Failure Mode |
|----------|-------------|
| `sessions_send` | Delivers reply to sender, not thread |
| `gateway call agent` | Needs in-memory channel binding (only from Discord inbound) |
| `/hooks/agent` | Agent runs but Discord delivery fails (no delivery context) |
| Bot `message` tool | Self-filter drops it (same author.id) |
| Session file patching | Gateway uses runtime state, ignores persisted files |
| v1 `/mindsets/wake` | Spawned wrong command (`gateway call agent` instead of `openclaw agent`) |

## Rules

1. Cold wake = CLI spawn. Steer = webhook POST. No mixing.
2. One webhook per forum channel. Store ID + token.
3. Webhook messages must @mention the bot.
4. Add all webhook IDs to the guild users allowlist.
5. `which openclaw` for CLI binary path. Never hardcode.
6. CLI spawns are detached with `stdio: 'ignore'`. Extension doesn't wait.
7. Files are the only shared state between threads.
8. Threads are autonomous after creation — steer only when needed.
9. For urgent steers, send `/stop` first, wait 1s, then send the message.
