/**
 * mindsets — Manage mindsets: list, inspect, create, reframe.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listMindsets, resolveMindset, loadWebhooks, getGuildId, getAutoSubscribeIds, getDisplayName } from "../lib/config.js";
import { api as discordApi, renameThread } from "../lib/discord.js";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
const WEBHOOKS_PATH = join(OPENCLAW_HOME, "extensions", "openclaw-mindsets", "webhooks.json");
const CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

// --- helpers ---

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function saveWebhooks(webhooks) {
  writeFileSync(WEBHOOKS_PATH, JSON.stringify(webhooks, null, 2) + "\n", "utf-8");
}

function backupFile(path) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${path}.bak-${ts}`;
  writeFileSync(bak, readFileSync(path, "utf-8"), "utf-8");
  return bak;
}

/** Get the Justin HQ category ID (parent of first forum channel). */
function getCategoryId(config) {
  const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];
  if (!guildId) return null;
  // We can't easily get parent_id from config alone. Use the plugin config or fallback.
  const pluginConfig = config.plugins?.entries?.["openclaw-mindsets"]?.config || {};
  return pluginConfig.categoryId || null;
}

function ok(data) { return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] }; }
function err(error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }] }; }

// --- workspace templates ---

function seedWorkspace(workspace, name, description) {
  mkdirSync(workspace, { recursive: true });

  const titleName = name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  const displayName = getDisplayName();
  const files = {
    "SOUL.md": `# Mindset: ${titleName}\n\n${description}\n`,
    "IDENTITY.md": [
      `# IDENTITY.md — ${titleName}\n`,
      `- **Name:** ${displayName} (${titleName} mindset)`,
      `- **Role:** ${description.split(".")[0]}`,
      `- **Mindset ID:** \`${name}\``,
      `- **Part of:** ${displayName} — a mindset, not a separate agent\n`,
    ].join("\n"),
    "AGENTS.md": (() => {
      try { return readFileSync(join(OPENCLAW_HOME, "workspace-infra", "AGENTS.md"), "utf-8"); }
      catch { return `# AGENTS.md\n\nNo agent guidelines configured yet.\n`; }
    })(),
    "USER.md": (() => {
      try { return readFileSync(join(OPENCLAW_HOME, "workspace-infra", "USER.md"), "utf-8"); }
      catch { return `# USER.md\n\nNo user profile configured yet.\n`; }
    })(),
    "MEMORY.md": `# MEMORY.md — ${titleName}\n\nFreshly created mindset. No memories yet.\n`,
    "HEARTBEAT.md": `# HEARTBEAT.md — ${titleName}\n\nNo heartbeat tasks configured. Reply HEARTBEAT_OK.\n`,
  };

  for (const [filename, content] of Object.entries(files)) {
    const p = join(workspace, filename);
    if (!existsSync(p)) writeFileSync(p, content, "utf-8");
  }
}

// --- actions ---

async function createMindset({ name, description }, logger) {
  // Validate
  if (!name || !description) return err("Both name and description are required.");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return err("Name must be lowercase alphanumeric with hyphens (e.g. 'research-ops').");
  if (name.length > 32) return err("Name must be 32 characters or fewer.");
  if (resolveMindset(null, name)) return err(`Mindset '${name}' already exists.`);

  const config = loadConfig();
  const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];
  if (!guildId) return err("No Discord guild configured.");

  // Find the category by looking at an existing forum channel's parent
  let categoryId = getCategoryId(config);
  if (!categoryId) {
    // Auto-detect: query Discord for an existing forum's parent_id
    const existingMindsets = listMindsets();
    if (existingMindsets.length > 0) {
      try {
        const ch = await discordApi("GET", `/channels/${existingMindsets[0].forumId}`, null, logger);
        categoryId = ch.parent_id;
      } catch {}
    }
  }

  // Backup before any writes
  const configBak = backupFile(CONFIG_PATH);
  const webhooksBak = backupFile(WEBHOOKS_PATH);

  let forumId, webhookId, webhookToken;

  try {
    // 1. Create Discord forum channel
    const forumBody = { name, type: 15, topic: description.substring(0, 1024) };
    if (categoryId) forumBody.parent_id = categoryId;
    const forum = await discordApi("POST", `/guilds/${guildId}/channels`, forumBody, logger);
    forumId = forum.id;
    if (!forumId) throw new Error("Forum created but no ID returned.");

    // If parent_id didn't stick (Discord quirk), move it
    if (categoryId && forum.parent_id !== categoryId) {
      try { await discordApi("PATCH", `/channels/${forumId}`, { parent_id: categoryId }, logger); }
      catch (e) { logger?.warn?.(`mindsets: could not move forum to category: ${e.message}`); }
    }

    // 2. Create webhook on the forum
    const wh = await discordApi("POST", `/channels/${forumId}/webhooks`, { name: getDisplayName() }, logger);
    webhookId = wh.id;
    webhookToken = wh.token;
    if (!webhookId || !webhookToken) throw new Error("Webhook created but missing ID/token.");

  } catch (e) {
    // Rollback: delete forum if created
    if (forumId) {
      try { await discordApi("DELETE", `/channels/${forumId}`, null, logger); }
      catch {}
    }
    return err(`Discord setup failed: ${e.message}`);
  }

  try {
    // 3. Update openclaw.json — agent, binding, channel, guild user
    const workspace = join(OPENCLAW_HOME, `workspace-${name}`);
    config.agents = config.agents || {};
    config.agents.list = config.agents.list || [];
    config.agents.list.push({
      id: name,
      workspace,
      model: { primary: "anthropic/claude-opus-4-6" },
      heartbeat: { every: "0", target: "none", to: forumId },
      subagents: { allowAgents: ["*"] },
      tools: { alsoAllow: ["message", "status", "open", "close", "update", "mindsets", "debug"] },
    });

    config.bindings = config.bindings || [];
    config.bindings.push({
      agentId: name,
      match: { channel: "discord", peer: { kind: "channel", id: forumId } },
    });

    const guild = config.channels.discord.guilds[guildId];
    guild.channels = guild.channels || {};
    guild.channels[forumId] = { allow: true, includeThreadStarter: false };
    guild.users = guild.users || [];
    if (!guild.users.includes(webhookId)) guild.users.push(webhookId);

    saveConfig(config);

    // 4. Update webhooks.json
    const webhooks = loadWebhooks();
    webhooks[forumId] = { forum: name, webhookId, webhookToken };
    saveWebhooks(webhooks);

    // 5. Seed workspace
    seedWorkspace(workspace, name, description);

    // 6. Restart gateway
    const { execSync } = await import("node:child_process");
    try { execSync("openclaw gateway restart", { timeout: 15000, stdio: "pipe" }); }
    catch (e) { logger?.warn?.(`mindsets: gateway restart returned non-zero (may still be restarting): ${e.message}`); }

    return ok({
      created: name,
      forumId,
      webhookId,
      workspace,
      backups: { config: configBak, webhooks: webhooksBak },
      link: `<#${forumId}>`,
      note: "Gateway restarting — agent will be available in ~10 seconds.",
    });

  } catch (e) {
    return err(`Config update failed (backups at ${configBak}): ${e.message}`);
  }
}

async function reframeMindset({ name, newName, newDescription, confirm }, logger) {
  if (!name) return err("Current mindset name is required.");
  if (!newName) return err("New name is required.");
  if (!/^[a-z][a-z0-9-]*$/.test(newName)) return err("New name must be lowercase alphanumeric with hyphens.");
  if (newName.length > 32) return err("New name must be 32 characters or fewer.");

  const current = resolveMindset(null, name);
  if (!current) return err(`Mindset '${name}' not found.`);
  if (name !== newName && resolveMindset(null, newName)) return err(`Mindset '${newName}' already exists.`);

  // Phase 1: Return current state for LLM adjacency evaluation
  if (!confirm) {
    return ok({
      phase: "evaluate",
      currentName: name,
      currentDescription: current.description,
      proposedName: newName,
      proposedDescription: newDescription || "(unchanged)",
      instruction: "Evaluate whether the proposed reframe is adjacent to the current domain. " +
        "A reframe should be a natural evolution or refinement — not a complete domain change. " +
        "Examples: dev→design-engineer ✅, infra→security-ops ✅, dev→cookery ❌, pa→quantum-physics ❌. " +
        "If adjacent, call reframe again with confirm: true. If not, explain why and refuse.",
    });
  }

  // Phase 2: Execute the reframe
  const configBak = backupFile(CONFIG_PATH);
  const webhooksBak = backupFile(WEBHOOKS_PATH);

  try {
    const config = loadConfig();
    const guildId = Object.keys(config.channels?.discord?.guilds || {})[0];

    // 1. Rename Discord forum channel
    await discordApi("PATCH", `/channels/${current.forumId}`, { name: newName }, logger);

    // 2. Update agents.list
    const agent = config.agents.list.find(a => a.id === name);
    if (!agent) throw new Error(`Agent '${name}' not found in agents.list`);
    agent.id = newName;
    const oldWorkspace = agent.workspace;
    const newWorkspace = join(OPENCLAW_HOME, `workspace-${newName}`);
    agent.workspace = newWorkspace;

    // 3. Update binding
    const binding = config.bindings.find(b => b.agentId === name);
    if (binding) binding.agentId = newName;

    // 4. Update webhooks.json
    const webhooks = loadWebhooks();
    if (webhooks[current.forumId]) webhooks[current.forumId].forum = newName;
    saveWebhooks(webhooks);

    // 5. Save config
    saveConfig(config);

    // 6. Rename workspace directory
    const { renameSync } = await import("node:fs");
    if (existsSync(oldWorkspace) && oldWorkspace !== newWorkspace) {
      renameSync(oldWorkspace, newWorkspace);
    }

    // 7. Update SOUL.md and IDENTITY.md if new description provided
    const titleName = newName.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (newDescription) {
      const soulPath = join(newWorkspace, "SOUL.md");
      if (existsSync(soulPath)) {
        writeFileSync(soulPath, `# Mindset: ${titleName}\n\n${newDescription}\n`, "utf-8");
      }
    }
    const idPath = join(newWorkspace, "IDENTITY.md");
    if (existsSync(idPath)) {
      let idContent = readFileSync(idPath, "utf-8");
      idContent = idContent.replace(new RegExp(name.replace(/-/g, "\\-"), "g"), newName);
      // Update title references
      const oldTitle = name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      idContent = idContent.replace(new RegExp(oldTitle, "g"), titleName);
      writeFileSync(idPath, idContent, "utf-8");
    }

    // 8. Restart gateway
    const { execSync } = await import("node:child_process");
    try { execSync("openclaw gateway restart", { timeout: 15000, stdio: "pipe" }); }
    catch (e) { logger?.warn?.(`mindsets: gateway restart returned non-zero: ${e.message}`); }

    return ok({
      reframed: { from: name, to: newName },
      forumId: current.forumId,
      workspace: newWorkspace,
      backups: { config: configBak, webhooks: webhooksBak },
      note: "Gateway restarting — reframed mindset will be available in ~10 seconds.",
    });

  } catch (e) {
    return err(`Reframe failed (backups at ${configBak}): ${e.message}`);
  }
}

// --- tool export ---

export default function mindsetsTool(api) {
  return {
    name: "mindsets",
    description: "Manage mindsets. Actions: list, inspect, create, reframe.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect", "create", "reframe"], description: "What to do." },
        name: { type: "string", description: "Mindset name (for inspect, create, reframe)." },
        description: { type: "string", description: "Mindset description / scope (for create, reframe)." },
        newName: { type: "string", description: "New name (for reframe)." },
        newDescription: { type: "string", description: "New description (for reframe, optional)." },
        confirm: { type: "boolean", description: "Confirm reframe after adjacency evaluation." },
      },
      required: ["action"],
    },
    async execute(_id, { action, name, description, newName, newDescription, confirm }) {
      const logger = api.logger;

      if (action === "list") return ok({ mindsets: listMindsets() });

      if (action === "inspect") {
        const m = resolveMindset(null, name);
        if (!m) return err(`Unknown: ${name}`);
        return ok({ mindset: m });
      }

      if (action === "create") {
        return createMindset({ name, description }, logger);
      }

      if (action === "reframe") {
        return reframeMindset({ name, newName, newDescription, confirm }, logger);
      }

      return err(`Unknown action: ${action}`);
    },
  };
}
