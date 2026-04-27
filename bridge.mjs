import { Client, GatewayIntentBits, Partials, EmbedBuilder, ChannelType } from 'discord.js';
import { jules, JulesError } from '@google/jules-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { IMAGE_MIME, buildContent, splitMessage, formatArtifacts, formatPlan } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const julesClient = jules.with({ apiKey: process.env.JULES_API_KEY });

const ACCESS_JSON = process.env.ACCESS_JSON || path.join(__dirname, 'access.json');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);

// Auto-sync / managed mode — enabled when GUILD_ID is set.
// The bot discovers Jules sources and sessions and builds the full Discord
// category / channel structure automatically; access.json is not required.
const GUILD_ID = process.env.GUILD_ID || null;
// How often (ms) to re-poll Jules for new/updated sessions. Min 10 s.
const POLL_INTERVAL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS || 120_000));
// How many sessions to retrieve per sync cycle (most-recent N).
const SYNC_SESSION_LIMIT = Math.max(1, Number(process.env.SYNC_SESSION_LIMIT || 50));
// Optional comma-separated Discord user IDs allowed to interact with managed
// channels. Leave unset to allow everyone who can see the channel.
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

// Name used for the per-repo "create a new task" control channel.
const NEW_TASK_CHANNEL_NAME = 'new-task';

// Agent lifecycle. Each ChannelAgent holds a persistent session.
// MCP children, costing ~500-600MB resident. To keep memory bounded:
//   - Idle agents are closed after IDLE_MINUTES of inactivity. Their session
//     pointer persists in state/sessions.json, so the next message resumes
//     the conversation (paying an ~8s cold start once).
//   - Active agents are capped at MAX_ACTIVE_AGENTS. When the cap is reached
//     and a new channel needs an agent, the LRU non-busy agent is evicted.
//     If every agent is mid-turn, the cap is exceeded temporarily; idle
//     eviction will trim back next time anything goes idle.
const IDLE_MS = Math.max(0, Number(process.env.IDLE_MINUTES || 30)) * 60 * 1000;
const MAX_ACTIVE_AGENTS = Math.max(1, Number(process.env.MAX_ACTIVE_AGENTS || 8));

fs.mkdirSync(STATE_DIR, { recursive: true });

// ----- state -----
const sessions = new Map();       // Discord channelId → Jules sessionId
const turnCounts = new Map();     // Discord channelId → turn count

// Auto-managed state (populated by syncJulesToDiscord / handleNewTask):
//   managedSessions:   Jules sessionId → { channelId, repo, state }
//   managedCategories: "owner/repo"    → Discord categoryId
//   newTaskChannels:   Discord channelId → "owner/repo"
const managedSessions = new Map();
const managedCategories = new Map();
const newTaskChannels = new Map();

// Reference to the Discord guild used in auto-managed mode (set on ready).
let managedGuild = null;

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.sessions || {})) sessions.set(k, v);
    for (const [k, v] of Object.entries(data.turns || {})) turnCounts.set(k, v);
    for (const [k, v] of Object.entries(data.managedSessions || {})) managedSessions.set(k, v);
    for (const [k, v] of Object.entries(data.managedCategories || {})) managedCategories.set(k, v);
    for (const [k, v] of Object.entries(data.newTaskChannels || {})) newTaskChannels.set(k, v);
    // Rebuild the channelId → sessionId map from managed sessions so that
    // ChannelAgent can resume sessions without access.json entries.
    for (const [sessionId, info] of managedSessions) {
      if (!sessions.has(info.channelId)) sessions.set(info.channelId, sessionId);
    }
    console.log(`[state] loaded ${sessions.size} sessions, ${managedSessions.size} managed from ${STATE_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[state] load failed: ${err.message}`);
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = {
      sessions: Object.fromEntries(sessions),
      turns: Object.fromEntries(turnCounts),
      managedSessions: Object.fromEntries(managedSessions),
      managedCategories: Object.fromEntries(managedCategories),
      newTaskChannels: Object.fromEntries(newTaskChannels),
    };
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (err) {
      console.error(`[state] save failed: ${err.message}`);
    }
  }, 500);
}

// ----- access policy -----
let accessCache = { mtime: 0, data: null };
function loadAccess() {
  try {
    const stat = fs.statSync(ACCESS_JSON);
    if (stat.mtimeMs !== accessCache.mtime) {
      accessCache = { mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(ACCESS_JSON, 'utf8')) };
      console.log(`[access] reloaded (${Object.keys(accessCache.data.groups || {}).length} channels)`);
    }
    return accessCache.data;
  } catch (err) {
    console.error(`[access] load failed: ${err.message}`);
    return { groups: {} };
  }
}

async function shouldProcess(message, clientUserId) {
  if (message.author.bot) return false;

  // Optional allowlist for auto-managed mode.
  if (ALLOWED_USER_IDS && !ALLOWED_USER_IDS.has(message.author.id)) return false;

  // Auto-managed channels: any Discord channel that maps to a known Jules
  // session or is a "new-task" control channel.
  if (GUILD_ID) {
    if (newTaskChannels.has(message.channel.id)) return true;
    const channelSessionId = sessions.get(message.channel.id);
    if (channelSessionId && managedSessions.has(channelSessionId)) return true;
  }

  // Legacy access.json path (still supported when access.json exists).
  const access = loadAccess();
  const group = access.groups?.[message.channel.id];
  if (!group) return false;
  if (group.allowFrom?.length && !group.allowFrom.includes(message.author.id)) return false;
  if (group.requireMention) {
    if (message.mentions.has(clientUserId)) return true;
    if (message.reference) {
      try {
        const ref = await message.fetchReference();
        if (ref.author.id === clientUserId) return true;
      } catch {}
    }
    return false;
  }
  return true;
}

// ----- attachment handling -----

async function fetchAttachments(msg) {
  if (msg.attachments.size === 0) return [];
  const out = [];
  for (const att of msg.attachments.values()) {
    try {
      const isImage = att.contentType && IMAGE_MIME.test(att.contentType);
      const cap = isImage ? Math.min(MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES) : MAX_ATTACHMENT_BYTES;
      if (att.size > cap) {
        const sizeMb = (att.size / 1024 / 1024).toFixed(1);
        const capMb = (cap / 1024 / 1024).toFixed(1);
        throw new Error(
          isImage
            ? `image ${sizeMb}MB exceeds ${capMb}MB Jules API limit`
            : `attachment ${sizeMb}MB exceeds ${capMb}MB limit`
        );
      }
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({ name: att.name, type: att.contentType, size: att.size, data: buf });
    } catch (err) {
      console.error(`[${msg.channel.id}] att fail: ${att.name}: ${err.message}`);
      out.push({ name: att.name, type: att.contentType, size: att.size, error: err.message });
    }
  }
  return out;
}

// ----- per-channel agent -----
class ChannelAgent {
  constructor(channelId) {
    this.channelId = channelId;
    this.closed = false;
    this.busy = false;
    this.sessionId = sessions.get(channelId) || null;
    this.pendingResolve = null;
    this.lastActivity = Date.now();
    this._idleTimer = null;
    this.session = null;
    // Plan-approval state: set when the Jules session pauses for approval.
    this.awaitingApproval = false;
    this.pendingPlan = null;
    this._scheduleIdleClose();
  }

  _touch() {
    this.lastActivity = Date.now();
    this._scheduleIdleClose();
  }

  _scheduleIdleClose() {
    if (IDLE_MS <= 0 || this.closed) return;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    const t = setTimeout(() => {
      if (this.pendingResolve) { this._scheduleIdleClose(); return; }
      const idleMin = Math.round((Date.now() - this.lastActivity) / 60000);
      console.log(`[${this.channelId}] idle ${idleMin}min — closing agent (session ${this.sessionId} preserved)`);
      this.close();
      if (agents.get(this.channelId) === this) agents.delete(this.channelId);
    }, IDLE_MS);
    t.unref?.();
    this._idleTimer = t;
  }

  /**
   * Collect activities from `session.updates()` until the session completes or
   * pauses for plan approval.  Returns an object describing the outcome.
   *
   * @returns {Promise<{text:string, artifacts:Array, awaitingApproval:boolean, plan:object|null}>}
   */
  async _collectStream() {
    const messages = [];
    const artifacts = [];

    for await (const activity of this.session.updates()) {
      if (activity.type === 'agentMessaged') {
        messages.push(activity.message);
      }

      if (activity.type === 'planGenerated') {
        // Ask the session whether it needs human approval before proceeding.
        const info = await this.session.info();
        if (info.state === 'awaitingPlanApproval') {
          this.awaitingApproval = true;
          this.pendingPlan = activity.plan;
          return {
            text: messages.join('\n\n'),
            artifacts,
            awaitingApproval: true,
            plan: activity.plan,
          };
        }
      }

      for (const artifact of activity.artifacts || []) {
        artifacts.push(artifact);
      }

      if (activity.type === 'sessionCompleted') {
        break;
      }
    }

    return { text: messages.join('\n\n'), artifacts, awaitingApproval: false, plan: null };
  }

  /**
   * Send a user message to the Jules session and stream the response.
   *
   * @param {string|Array} content  Formatted message content.
   * @param {string} systemPrompt   Used only when creating a brand-new session.
   * @param {object|null} source    Jules source object (e.g. `{ github: 'org/repo', baseBranch: 'main' }`).
   */
  async send(content, systemPrompt = 'You are a helpful coding agent.', source = null) {
    if (this.closed) throw new Error('agent closed');
    if (this.pendingResolve) throw new Error('agent busy with previous turn');
    this._touch();

    // We mock pendingResolve to lock the agent so idle eviction doesn't kill it mid-turn
    this.pendingResolve = true;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (this.sessionId && !this.session) {
          this.session = julesClient.session(this.sessionId);
        } else if (!this.session) {
          const opts = { prompt: systemPrompt };
          if (source) opts.source = source;
          this.session = await julesClient.session(opts);
          this.sessionId = this.session.id;
          sessions.set(this.channelId, this.sessionId);
          saveState();
          console.log(`[${this.channelId}] session=${this.sessionId}${source ? ` source=${JSON.stringify(source)}` : ''}`);
        }

        // Fire-and-forget the user message, then stream the agent's activities.
        await this.session.send(content);
        const result = await this._collectStream();
        this.pendingResolve = null;
        return result;
      } catch (err) {
        const is404 = err instanceof JulesError || err.status === 404 || (err.message && err.message.includes('404'));
        if (is404 && attempt === 1) {
          const previous = this.sessionId;
          console.warn(`[${this.channelId}] stale session ${previous || '(unknown)'} — retrying with fresh session`);
          this.sessionId = null;
          this.session = null;
          sessions.delete(this.channelId);
          saveState();
          continue; // retry
        }

        this.pendingResolve = null;
        console.error(`[${this.channelId}] stream error: ${err.message}`);
        return { text: '', artifacts: [], awaitingApproval: false, plan: null, error: err.message };
      }
    }
  }

  /**
   * Approve a pending Jules plan and stream the agent's subsequent activities.
   * Only valid when `this.awaitingApproval` is true.
   *
   * @returns {Promise<{text:string, artifacts:Array, awaitingApproval:boolean, plan:object|null}>}
   */
  async approve() {
    if (!this.awaitingApproval) throw new Error('no plan awaiting approval');
    if (this.pendingResolve) throw new Error('agent busy');
    this._touch();
    this.pendingResolve = true;
    try {
      await this.session.approve();
      this.awaitingApproval = false;
      this.pendingPlan = null;
      const result = await this._collectStream();
      this.pendingResolve = null;
      return result;
    } catch (err) {
      this.pendingResolve = null;
      console.error(`[${this.channelId}] approve error: ${err.message}`);
      return { text: '', artifacts: [], awaitingApproval: false, plan: null, error: err.message };
    }
  }

  close() {
    this.closed = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
}

// ----- auto-sync helpers -----

/** Produce a valid Discord channel/category name from an arbitrary string. */
function sanitizeChannelName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** Discord category name for a given "owner/repo" string. */
function repoCategoryName(repo) {
  return sanitizeChannelName(`jules-${repo}`);
}

/** Discord channel name for a Jules session. */
function sessionChannelName(sessionId) {
  return `task-${sessionId.slice(0, 8)}`;
}

/**
 * Extract the "owner/repo" string from a Jules session object.
 * Handles both the `githubRepo` shape and the plain `github` string.
 */
function extractRepo(session) {
  if (!session?.source) return null;
  if (session.source.githubRepo) {
    const { owner, repo } = session.source.githubRepo;
    return `${owner}/${repo}`;
  }
  if (typeof session.source.github === 'string') return session.source.github;
  return null;
}

/** Find or create a Discord category for a repo. */
async function getOrCreateCategory(guild, repo) {
  const name = repoCategoryName(repo);
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name,
  );
  if (existing) return existing;
  console.log(`[sync] creating category: ${name}`);
  return guild.channels.create({ name, type: ChannelType.GuildCategory });
}

/**
 * Ensure the special `#new-task` control channel exists inside `categoryId`.
 * Registers it in `newTaskChannels` so messages there trigger session creation.
 */
async function ensureNewTaskChannel(guild, repo) {
  const categoryId = managedCategories.get(repo);
  if (!categoryId) return;

  const existing = guild.channels.cache.find(
    (c) => c.parentId === categoryId && c.name === NEW_TASK_CHANNEL_NAME,
  );
  let ch = existing;
  if (!ch) {
    ch = await guild.channels.create({
      name: NEW_TASK_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Send any message here to open a new Jules task for ${repo}.`,
    });
    console.log(`[sync] created #${NEW_TASK_CHANNEL_NAME} for ${repo}: ${ch.id}`);
  }

  if (!newTaskChannels.has(ch.id)) {
    newTaskChannels.set(ch.id, repo);
    saveState();
  }
}

/**
 * Reconcile a single Jules session with Discord:
 *   - If we already track it and its state changed, post a notification.
 *   - If it is new, create (or find) the text channel and register it.
 */
async function syncOneSession(guild, session) {
  const sessionId = session.id;
  const newState = session.state;

  if (managedSessions.has(sessionId)) {
    const managed = managedSessions.get(sessionId);
    if (managed.state !== newState) {
      managed.state = newState;
      saveState();
      try {
        const ch = guild.channels.cache.get(managed.channelId);
        if (ch) {
          await ch.send(`ℹ️ **Status updated:** \`${newState}\``).catch((err) => {
            console.error(`[sync] status update send failed for ${sessionId}: ${err.message}`);
          });
        }
      } catch (err) {
        console.error(`[sync] status update error for ${sessionId}: ${err.message}`);
      }
    }
    return;
  }

  // New session — determine which repo/category it belongs to.
  const repo = extractRepo(session);
  let categoryId = repo ? managedCategories.get(repo) : null;

  if (repo && !categoryId) {
    try {
      const cat = await getOrCreateCategory(guild, repo);
      managedCategories.set(repo, cat.id);
      saveState();
      categoryId = cat.id;
      await ensureNewTaskChannel(guild, repo);
    } catch (err) {
      console.error(`[sync] category for ${repo}: ${err.message}`);
    }
  }

  const chName = sessionChannelName(sessionId);
  // Use an exact category match; if categoryId is null, look for a top-level
  // channel (parentId is null) to avoid false matches across categories.
  const existing = guild.channels.cache.find(
    (c) => c.name === chName && c.parentId === (categoryId ?? null),
  );

  try {
    let ch = existing;
    if (!ch) {
      ch = await guild.channels.create({
        name: chName,
        type: ChannelType.GuildText,
        parent: categoryId ?? undefined,
        topic: `Jules session ${sessionId}${repo ? ` — ${repo}` : ''}`,
      });
      const repoLine = repo ? `\nRepo: \`${repo}\`` : '';
      await ch
        .send(
          `📋 **Jules Session** \`${sessionId}\`\n` +
            `Status: **${newState}**${repoLine}\n\n` +
            `Send a message here to interact with this session.`,
        )
        .catch(() => {});
    }

    managedSessions.set(sessionId, { channelId: ch.id, repo: repo ?? null, state: newState });
    sessions.set(ch.id, sessionId);
    saveState();
    console.log(`[sync] session ${sessionId} → #${ch.name} (${ch.id})`);
  } catch (err) {
    console.error(`[sync] failed for session ${sessionId}: ${err.message}`);
  }
}

/**
 * Full Jules → Discord sync:
 *   1. Enumerate Jules sources → create/find categories + #new-task channels.
 *   2. Enumerate Jules sessions → create/find per-session text channels.
 */
async function syncJulesToDiscord(guild) {
  console.log('[sync] Jules → Discord sync starting');

  // Refresh the guild channel cache once per sync cycle.
  await guild.channels.fetch();

  // Step 1: sources → categories.
  try {
    for await (const source of julesClient.sources()) {
      if (source.type === 'githubRepo') {
        const repo = `${source.githubRepo.owner}/${source.githubRepo.repo}`;
        if (!managedCategories.has(repo)) {
          try {
            const cat = await getOrCreateCategory(guild, repo);
            managedCategories.set(repo, cat.id);
            saveState();
          } catch (err) {
            console.error(`[sync] category for ${repo}: ${err.message}`);
          }
        }
        await ensureNewTaskChannel(guild, repo);
      }
    }
  } catch (err) {
    console.error(`[sync] sources error: ${err.message}`);
  }

  // Step 2: sessions → channels.
  try {
    const sessionList = await julesClient.select({
      from: 'sessions',
      order: 'desc',
      limit: SYNC_SESSION_LIMIT,
    });
    for (const session of sessionList ?? []) {
      await syncOneSession(guild, session);
    }
  } catch (err) {
    console.error(`[sync] sessions error: ${err.message}`);
  }

  console.log(
    `[sync] done — ${managedSessions.size} sessions, ${managedCategories.size} repos`,
  );
}

/** Schedule recurring re-syncs so new Jules sessions surface in Discord. */
let _pollTimer = null;
function schedulePoll(guild) {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = setTimeout(async () => {
    _pollTimer = null;
    try {
      await syncJulesToDiscord(guild);
    } catch (err) {
      console.error(`[poll] sync error: ${err.message}`);
    }
    schedulePoll(guild);
  }, POLL_INTERVAL_MS);
  _pollTimer.unref?.();
}

/**
 * Handle a message sent to a `#new-task` channel.
 * Creates a new Jules session for the associated repo, opens a dedicated text
 * channel for it, and forwards the user's message as the first turn.
 * Only called when `managedGuild` is set (GUILD_ID is configured).
 */
async function handleNewTask(msg, repo, baseText, attachments) {
  const content = buildContent(baseText, attachments);
  if (!content) {
    await msg.reply('Please include a task description.').catch(() => {});
    return;
  }

  try {
    await msg.channel.sendTyping().catch(() => {});

    const categoryId = managedCategories.get(repo);

    // Build the Jules source object. repo is always "owner/repo" format here
    // (populated from extractRepo / newTaskChannels.set), so the slash is guaranteed.
    const source = { github: repo, baseBranch: 'main' };
    const systemPrompt = `You are a helpful coding agent working on ${repo}.`;

    // Create the Jules session.
    const sessionOpts = { prompt: systemPrompt, source };
    const newSession = await julesClient.session(sessionOpts);

    // Create the Discord text channel for this session.
    const chName = sessionChannelName(newSession.id);
    const ch = await managedGuild.channels.create({
      name: chName,
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      topic: `Jules session ${newSession.id} — ${repo}`,
    });

    managedSessions.set(newSession.id, { channelId: ch.id, repo, state: 'created' });
    sessions.set(ch.id, newSession.id);
    saveState();
    console.log(`[new-task] ${repo} → session ${newSession.id} → #${ch.name} (${ch.id})`);

    await msg
      .reply(`✅ Opened <#${ch.id}> for \`${repo}\`. Sending your task now…`)
      .catch(() => {});

    // Forward the user's message as the first turn inside the new channel.
    const agent = getAgent(ch.id);
    const t0 = Date.now();
    const result = await agent.send(content, systemPrompt, source);
    console.log(`[new-task] first turn done in ${Date.now() - t0}ms`);

    if (result.awaitingApproval) {
      const planText = formatPlan(result.plan);
      const preText = result.text ? `${result.text}\n\n` : '';
      await ch
        .send(
          `${preText}**Jules has generated a plan and is waiting for your approval:**\n${planText}\n\n` +
            'Reply with `!!approve` to proceed, or `!!clear` to cancel.',
        )
        .catch(() => {});
      return;
    }

    turnCounts.set(ch.id, (turnCounts.get(ch.id) || 0) + 1);
    saveState();

    const mainText = result.text || (result.error ? `Error: ${result.error}` : '*(empty response)*');
    const artifactText = formatArtifacts(result.artifacts || []);
    const fullText = artifactText ? `${mainText}\n\n${artifactText}` : mainText;
    const chunks = splitMessage(fullText);
    const barEmbed = buildContextEmbed(ch.id);
    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) await ch.send({ content: chunks[i], embeds: [barEmbed] });
      else await ch.send(chunks[i]);
    }
  } catch (err) {
    console.error(`[new-task] ${repo}: ${err.message}`);
    await msg.reply(`Error creating session: ${err.message}`).catch(() => {});
  }
}

// ----- bridge -----
const agents = new Map();
const queues = new Map();
const channelBusy = new Map();

function _evictLRU() {
  // Find the least-recently-used agent that isn't currently mid-turn.
  let oldest = null;
  for (const a of agents.values()) {
    if (a.pendingResolve) continue;
    if (!oldest || a.lastActivity < oldest.lastActivity) oldest = a;
  }
  if (oldest) {
    const idleMin = Math.round((Date.now() - oldest.lastActivity) / 60000);
    console.log(`[${oldest.channelId}] LRU evict (idle ${idleMin}min, cap ${MAX_ACTIVE_AGENTS}, session ${oldest.sessionId} preserved)`);
    oldest.close();
    agents.delete(oldest.channelId);
    return true;
  }
  console.warn(`[evict] all ${agents.size} agents busy, exceeding cap ${MAX_ACTIVE_AGENTS} temporarily`);
  return false;
}

function getAgent(channelId) {
  let a = agents.get(channelId);
  if (a && !a.closed) {
    a._touch();
    return a;
  }
  if (agents.size >= MAX_ACTIVE_AGENTS) _evictLRU();
  a = new ChannelAgent(channelId);
  agents.set(channelId, a);
  return a;
}

function buildContextEmbed(channelId) {
  const turn = turnCounts.get(channelId) || 0;
  const footer = `Turn ${turn}`;
  const color = 0x57f287;
  return new EmbedBuilder().setColor(color).setFooter({ text: footer });
}

async function processQueue(channelId) {
  if (channelBusy.get(channelId)) return;
  channelBusy.set(channelId, true);
  const queue = queues.get(channelId) || [];

  while (queue.length > 0) {
    const msg = queue.shift();
    const baseText = msg.content.replace(/<@!?\d+>/g, '').trim();
    const attachments = await fetchAttachments(msg);
    if (!baseText && attachments.length === 0) continue;

    // ----- special commands -----
    if (baseText === '!!clear') {
      const a = agents.get(channelId);
      if (a) { a.close(); agents.delete(channelId); }
      const sessionId = sessions.get(channelId);
      sessions.delete(channelId);
      turnCounts.delete(channelId);
      // Clean up managed-session tracking so the channel is no longer treated as active.
      if (sessionId) managedSessions.delete(sessionId);
      saveState();
      console.log(`[${channelId}] cleared by !!clear`);
      await msg.reply('Session cleared. Next message starts fresh.').catch(() => {});
      continue;
    }

    if (baseText === '!!approve') {
      const a = agents.get(channelId);
      if (!a || !a.awaitingApproval) {
        await msg.reply('There is no plan awaiting approval in this channel.').catch(() => {});
        continue;
      }
      try {
        await msg.channel.sendTyping().catch(() => {});
        const typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
        const t0 = Date.now();
        const result = await a.approve();
        clearInterval(typingTimer);
        console.log(`[${channelId}] approved, turn ${(turnCounts.get(channelId) ?? 0) + 1} done in ${Date.now() - t0}ms`);
        await _handleTurnResult(msg, channelId, result);
      } catch (err) {
        console.error(`[${channelId}] approve error: ${err.message}`);
        await msg.reply(`Error during approval: ${err.message}`).catch(() => {});
      }
      continue;
    }

    if (baseText === '!!sources') {
      try {
        const lines = [];
        for await (const source of julesClient.sources()) {
          if (source.type === 'githubRepo') {
            const { owner, repo, isPrivate } = source.githubRepo;
            lines.push(`• **${owner}/${repo}**${isPrivate ? ' 🔒' : ''}`);
          } else {
            lines.push(`• ${source.type} (id: ${source.id})`);
          }
        }
        const text = lines.length
          ? `**Connected Jules sources:**\n${lines.join('\n')}`
          : 'No connected sources found.';
        await msg.reply(text).catch(() => {});
      } catch (err) {
        await msg.reply(`Error listing sources: ${err.message}`).catch(() => {});
      }
      continue;
    }

    if (baseText === '!!sessions') {
      try {
        const recent = await julesClient.select({
          from: 'sessions',
          order: 'desc',
          limit: 5,
        });
        if (!recent || recent.length === 0) {
          await msg.reply('No cached sessions found.').catch(() => {});
        } else {
          const lines = recent.map((s) => `• \`${s.id}\` — **${s.state}**`);
          await msg.reply(`**Recent Jules sessions:**\n${lines.join('\n')}`).catch(() => {});
        }
      } catch (err) {
        await msg.reply(`Error querying sessions: ${err.message}`).catch(() => {});
      }
      continue;
    }

    // ----- new-task channel -----
    // Messages in a #new-task channel create a brand-new Jules session and
    // open a dedicated text channel for it — skip all normal session logic.
    if (newTaskChannels.has(channelId)) {
      await handleNewTask(msg, newTaskChannels.get(channelId), baseText, attachments);
      continue;
    }

    // ----- normal turn -----
    const content = buildContent(baseText, attachments);
    if (!content) continue;

    const access = loadAccess();
    const group = access.groups?.[channelId] || {};
    const systemPrompt = group.systemPrompt;
    const source = group.source || null;

    try {
      await msg.channel.sendTyping().catch(() => {});
      const typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const agent = getAgent(channelId);
      const t0 = Date.now();
      console.log(`[${channelId}] send: ${typeof content === 'string' ? content.slice(0, 80) : `[${content.length} blocks]`}`);

      const result = await agent.send(content, systemPrompt, source);
      clearInterval(typingTimer);
      console.log(`[${channelId}] turn ${(turnCounts.get(channelId) ?? 0) + 1} done in ${Date.now() - t0}ms`);

      await _handleTurnResult(msg, channelId, result);
    } catch (err) {
      console.error(`[${channelId}] error: ${err.message}`);
      await msg.reply(`Error: ${err.message}`).catch(() => {});
    }
  }

  channelBusy.set(channelId, false);
}

/**
 * Send the result of a Jules turn (or approval) back to Discord.
 * Handles plan-approval pauses, artifact formatting, and message splitting.
 *
 * @param {import('discord.js').Message} msg
 * @param {string} channelId
 * @param {{text:string, artifacts:Array, awaitingApproval:boolean, plan:object|null, error?:string}} result
 */
async function _handleTurnResult(msg, channelId, result) {
  if (result.awaitingApproval) {
    // Jules generated a plan and is waiting for human approval.
    const planText = formatPlan(result.plan);
    const preText = result.text ? `${result.text}\n\n` : '';
    await msg
      .reply(
        `${preText}**Jules has generated a plan and is waiting for your approval:**\n${planText}\n\n` +
          'Reply with `!!approve` to proceed, or `!!clear` to cancel.'
      )
      .catch(() => {});
    return;
  }

  // Increment turn count only for completed turns.
  turnCounts.set(channelId, (turnCounts.get(channelId) || 0) + 1);
  saveState();

  const mainText = result.text || (result.error ? `Error: ${result.error}` : '*(empty response)*');
  const artifactText = formatArtifacts(result.artifacts || []);
  const fullText = artifactText ? `${mainText}\n\n${artifactText}` : mainText;

  const chunks = splitMessage(fullText);
  const barEmbed = buildContextEmbed(channelId);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    if (isLast) await msg.reply({ content: chunks[i], embeds: [barEmbed] });
    else await msg.reply(chunks[i]);
  }
}

// ----- discord client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Access: ${ACCESS_JSON}`);
  console.log(`State: ${STATE_FILE}`);
  loadAccess();

  if (GUILD_ID) {
    try {
      managedGuild = await client.guilds.fetch(GUILD_ID);
      await managedGuild.channels.fetch();
      await syncJulesToDiscord(managedGuild);
      schedulePoll(managedGuild);
      console.log(`[sync] auto-managed mode active (guild ${GUILD_ID}, poll every ${POLL_INTERVAL_MS / 1000}s)`);
    } catch (err) {
      console.error(`[sync] guild setup failed: ${err.message}`);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!(await shouldProcess(message, client.user?.id))) return;
  if (!queues.has(message.channel.id)) queues.set(message.channel.id, []);
  queues.get(message.channel.id).push(message);
  processQueue(message.channel.id);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — closing agents');
  for (const a of agents.values()) a.close();
  client.destroy().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

loadState();
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
