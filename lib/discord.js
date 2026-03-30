/**
 * lib/discord.js — Shared Discord REST helper.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DISCORD_API = "https://discord.com/api/v10";

function getToken() {
  const home = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
  const cfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf-8"));
  return cfg.channels?.discord?.token;
}

export async function api(method, path, body, logger) {
  const token = getToken();
  if (!token) throw new Error("Discord bot token not found in openclaw.json");

  const opts = {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  if (logger) logger.debug(`discord: ${method} ${path}`);

  const res = await fetch(`${DISCORD_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord ${method} ${path}: ${res.status} ${text.substring(0, 200)}`);
  }
  if (method === "DELETE" || res.status === 204) return {};
  return res.json();
}

export async function sendMessage(channelId, content, logger) {
  return api("POST", `/channels/${channelId}/messages`, { content }, logger);
}

export async function sendEmbed(channelId, embed, logger) {
  return api("POST", `/channels/${channelId}/messages`, { embeds: [embed] }, logger);
}

export async function addThreadMember(threadId, userId, logger) {
  return api("PUT", `/channels/${threadId}/thread-members/${userId}`, null, logger);
}

export async function removeThreadMember(threadId, userId, logger) {
  return api("DELETE", `/channels/${threadId}/thread-members/${userId}`, null, logger);
}

export async function archiveThread(threadId, logger) {
  return api("PATCH", `/channels/${threadId}`, { archived: true, locked: true }, logger);
}

export async function renameThread(threadId, name, logger) {
  return api("PATCH", `/channels/${threadId}`, { name }, logger);
}

export async function listActiveThreads(guildId, logger) {
  return api("GET", `/guilds/${guildId}/threads/active`, null, logger);
}

export async function getThreadMembers(threadId, logger) {
  return api("GET", `/channels/${threadId}/thread-members`, null, logger);
}

/**
 * Low-level webhook POST. Callers should prefer sendToThread/createThreadViaWebhook.
 */
async function webhookPost(webhookUrl, body, opts = {}) {
  const params = new URLSearchParams();
  if (opts.threadId) params.set("thread_id", opts.threadId);
  if (opts.wait) params.set("wait", "true");
  const url = `${webhookUrl}?${params}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST: ${res.status} ${text.substring(0, 200)}`);
  }
  if (opts.wait && res.status !== 204) return res.json();
  return {};
}

/**
 * Send a message to an existing thread via webhook.
 * Resolves the correct webhook by trying each until one matches the thread's forum.
 *
 * @param {string} text - Message content (rendered as embed with optional header)
 * @param {string} threadId - Target thread ID
 * @param {Array} webhooks - Array of {webhookUrl} from listMindsets()
 * @param {object} [opts] - Optional: header (embed author name), color (embed color)
 * @returns {Promise<boolean>} true if delivered
 */
export async function sendToThread(text, threadId, webhooks, opts = {}) {
  const { header = null, color = 0x5865F2 } = opts;
  const embed = { description: text, color };
  if (header) embed.author = { name: header };

  for (const wh of webhooks) {
    if (!wh.webhookUrl) continue;
    try {
      const body = {
        content: null,
        username: opts.username || "Justin",
        embeds: [embed],
      };
      if (opts.avatarUrl) body.avatar_url = opts.avatarUrl;
      await webhookPost(wh.webhookUrl, body, { threadId, wait: false });
      return true;
    } catch { /* wrong forum's webhook — try next */ }
  }
  return false;
}

/**
 * Create a new forum thread via webhook. One call: creates thread + posts bootstrap.
 * Dispatch identity passes self-filter → agent wakes with content.
 *
 * @param {string} webhookUrl - Webhook URL for the target forum
 * @param {string} title - Thread title
 * @param {string} text - Bootstrap content (rendered as embed)
 * @param {object} [opts] - Optional: header, color, applied_tags
 * @returns {Promise<{threadId: string}>} Created thread ID
 */
export async function createThreadViaWebhook(webhookUrl, title, text, opts = {}) {
  const { header = "Thread Opened", color = 0x2b2d31, applied_tags } = opts;
  const embed = { description: text, color };
  if (header) embed.author = { name: header };

  const body = {
    content: null,
    username: "Justin",
    embeds: [embed],
    thread_name: title,
  };
  if (applied_tags) body.applied_tags = applied_tags;

  const result = await webhookPost(webhookUrl, body, { wait: true });

  const threadId = result.channel_id;
  if (!threadId) throw new Error("Thread created but no thread ID returned");
  return { threadId };
}
