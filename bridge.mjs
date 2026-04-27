import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { jules, JulesError } from '@google/jules-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { IMAGE_MIME, buildContent, splitMessage } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const julesClient = jules.with({ apiKey: process.env.JULES_API_KEY });

const ACCESS_JSON = process.env.ACCESS_JSON || path.join(__dirname, 'access.json');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);

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
const sessions = new Map();
const turnCounts = new Map();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.sessions || {})) sessions.set(k, v);
    for (const [k, v] of Object.entries(data.turns || {})) turnCounts.set(k, v);
    console.log(`[state] loaded ${sessions.size} sessions from ${STATE_FILE}`);
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

  async send(content) {
    if (this.closed) throw new Error('agent closed');
    if (this.pendingResolve) throw new Error('agent busy with previous turn');
    this._touch();

    // We mock pendingResolve to lock the agent so idle eviction doesn't kill it mid-turn
    this.pendingResolve = true;

    try {
      if (this.sessionId && !this.session) {
        this.session = julesClient.session(this.sessionId);
      } else if (!this.session) {
        this.session = await julesClient.session({ prompt: 'You are a helpful coding agent.' });
        this.sessionId = this.session.id;
        sessions.set(this.channelId, this.sessionId);
        saveState();
        console.log(`[${this.channelId}] session=${this.sessionId}`);
      }

      const reply = await this.session.ask(content);
      this.pendingResolve = null;
      return { text: reply.message };
    } catch (err) {
      this.pendingResolve = null;
      console.error(`[${this.channelId}] stream error: ${err.message}`);

      if (err instanceof JulesError || err.status === 404 || (err.message && err.message.includes('404'))) {
        const previous = this.sessionId;
        this.sessionId = null;
        this.session = null;
        sessions.delete(this.channelId);
        saveState();
        return {
          text: '',
          error: `stale session ${previous || '(unknown)'} cleared — please resend`,
        };
      }

      return { text: '', error: err.message };
    }
  }

  close() {
    this.closed = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
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

    if (baseText === '!!clear') {
      const a = agents.get(channelId);
      if (a) { a.close(); agents.delete(channelId); }
      sessions.delete(channelId);
      turnCounts.delete(channelId);
      saveState();
      console.log(`[${channelId}] cleared by !!clear`);
      await msg.reply('Session cleared. Next message starts fresh.').catch(() => {});
      continue;
    }

    const content = buildContent(baseText, attachments);
    if (!content) continue;

    try {
      await msg.channel.sendTyping().catch(() => {});
      const typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const agent = getAgent(channelId);
      const t0 = Date.now();
      console.log(`[${channelId}] send: ${typeof content === 'string' ? content.slice(0,80) : `[${content.length} blocks]`}`);

      const result = await agent.send(content);
      clearInterval(typingTimer);
      console.log(`[${channelId}] turn ${(turnCounts.get(channelId) ?? 0) + 1} done in ${Date.now() - t0}ms`);

      turnCounts.set(channelId, (turnCounts.get(channelId) || 0) + 1);
      saveState();

      const text = result.text || (result.error ? `Error: ${result.error}` : '*(empty response)*');
      const chunks = splitMessage(text);
      const barEmbed = buildContextEmbed(channelId);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        if (isLast) await msg.reply({ content: chunks[i], embeds: [barEmbed] });
        else await msg.reply(chunks[i]);
      }
    } catch (err) {
      console.error(`[${channelId}] error: ${err.message}`);
      await msg.reply(`Error: ${err.message}`).catch(() => {});
    }
  }

  channelBusy.set(channelId, false);
}

// ----- discord client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Access: ${ACCESS_JSON}`);
  console.log(`State: ${STATE_FILE}`);
  loadAccess();
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
