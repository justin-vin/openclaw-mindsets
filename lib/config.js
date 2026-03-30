/**
 * lib/config.js — Mindset configuration resolver.
 */

export function resolveMindset(cfg, name) {
  const m = cfg?.mindsets?.[name];
  return m ? { name, ...m } : null;
}

export function listMindsets(cfg) {
  return Object.entries(cfg?.mindsets || {}).map(([name, m]) => ({ name, ...m }));
}

export function isMainSession(ctx, cfg) {
  if (!ctx.agentId || ctx.agentId === "main") return true;
  if (cfg?.mainChannelId && ctx.sessionKey?.includes(cfg.mainChannelId)) return true;
  return false;
}

export function getGuildId(cfg) { return cfg?.guildId; }
export function getBotId(cfg) { return cfg?.botId; }
