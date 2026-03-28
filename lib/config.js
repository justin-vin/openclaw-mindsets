/**
 * lib/config.js — Mindset configuration resolver.
 *
 * Derives the mindset list from existing config rather than maintaining a duplicate.
 * Sources of truth:
 *   - openclaw.json bindings → agent ↔ forum mapping
 *   - webhooks.json → forum → webhook URL
 *   - Agent workspace SOUL.md / IDENTITY.md → description
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;

function loadConfig() {
  return JSON.parse(readFileSync(join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
}

export function loadWebhooks() {
  const p = join(OPENCLAW_HOME, "extensions", "openclaw-mindsets", "webhooks.json");
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch { return {}; }
}

function readAgentDescription(agentId) {
  const config = loadConfig();
  const agent = (config.agents?.list || []).find(a => a?.id === agentId);
  const workspace = agent?.workspace || join(OPENCLAW_HOME, `workspace-${agentId}`);
  
  for (const file of ["SOUL.md", "IDENTITY.md"]) {
    const p = join(workspace, file);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        // Extract first paragraph after the heading as description
        const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        return lines.slice(0, 2).join(" ").substring(0, 200);
      } catch {}
    }
  }
  return agentId;
}

/** Build the full mindset list from bindings + webhooks + workspace files. */
export function listMindsets() {
  const config = loadConfig();
  const webhooks = loadWebhooks();
  const mindsets = [];

  for (const binding of (config.bindings || [])) {
    const peer = binding.match?.peer;
    if (peer?.kind !== "channel" || !binding.agentId) continue;
    if (binding.agentId === "main") continue;

    const forumId = peer.id;
    const wh = webhooks[forumId] || {};
    const webhookUrl = wh.webhookId && wh.webhookToken
      ? `https://discord.com/api/webhooks/${wh.webhookId}/${wh.webhookToken}`
      : null;

    mindsets.push({
      name: binding.agentId,
      forumId,
      webhookUrl,
      webhookId: wh.webhookId || null,
      description: readAgentDescription(binding.agentId),
    });
  }

  return mindsets;
}

/** Resolve a single mindset by name. */
export function resolveMindset(cfg, name) {
  // cfg param kept for API compat but we derive from config files
  const all = listMindsets();
  return all.find(m => m.name === name) || null;
}

/** Is this the main session? */
export function isMainSession(ctx) {
  if (!ctx.agentId || ctx.agentId === "main") return true;
  return false;
}

/** Get guild ID from config. */
export function getGuildId() {
  const config = loadConfig();
  return Object.keys(config.channels?.discord?.guilds || {})[0] || null;
}

/** Get bot user ID. */
export function getBotId() {
  const config = loadConfig();
  // Try to find bot ID from the Discord token (or fallback to known ID)
  // The bot ID is the application ID — stored in the token's first segment
  const token = config.channels?.discord?.token;
  if (token) {
    try {
      const decoded = Buffer.from(token.split(".")[0], "base64").toString();
      if (/^\d+$/.test(decoded)) return decoded;
    } catch {}
  }
  // Fallback: read from agents or return null
  return null;
}

/** Get user IDs to auto-subscribe to new threads. */
export function getAutoSubscribeIds() {
  const config = loadConfig();
  const pluginConfig = config.plugins?.entries?.["openclaw-mindsets"]?.config || {};
  return pluginConfig.autoSubscribe || [];
}

/** Whether to post visible housekeeping/routing embeds in Discord. Default: false. */
export function getShowHousekeeping() {
  const config = loadConfig();
  const pluginConfig = config.plugins?.entries?.["openclaw-mindsets"]?.config || {};
  return pluginConfig.show_housekeeping === true;
}

/** Get the display name for webhook posts (configurable, defaults to bot username or "Mindsets"). */
export function getDisplayName() {
  const config = loadConfig();
  const pluginConfig = config.plugins?.entries?.["openclaw-mindsets"]?.config || {};
  if (pluginConfig.displayName) return pluginConfig.displayName;
  // Try to extract from bot token or agent config
  const mainAgent = (config.agents?.list || []).find(a => a?.id === "main");
  if (mainAgent?.name) return mainAgent.name;
  return "Mindsets";
}

/** Get the main channel ID. */
export function getMainChannelId() {
  const config = loadConfig();
  const guilds = config.channels?.discord?.guilds || {};
  const guildId = Object.keys(guilds)[0];
  if (!guildId) return null;
  const channels = guilds[guildId]?.channels || {};
  for (const [chId, ch] of Object.entries(channels)) {
    if (ch.allow && !("includeThreadStarter" in ch)) return chId;
  }
  return null;
}
