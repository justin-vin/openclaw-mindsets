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

export async function createThread(forumId, title, firstMessage, logger) {
  return api("POST", `/channels/${forumId}/threads`, {
    name: title,
    message: { content: firstMessage },
  }, logger);
}

export async function sendMessage(channelId, content, logger) {
  return api("POST", `/channels/${channelId}/messages`, { content }, logger);
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

export async function webhookPost(webhookUrl, threadId, content, username, avatarUrl, opts = {}) {
  const url = `${webhookUrl}?thread_id=${threadId}`;
  const body = { content, username, avatar_url: avatarUrl };
  if (opts.embeds) body.embeds = opts.embeds;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST: ${res.status} ${text.substring(0, 200)}`);
  }
}
