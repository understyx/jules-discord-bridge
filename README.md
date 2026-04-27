# jules-discord-bridge

A Discord bot that wraps [`@google/jules-sdk`](https://www.npmjs.com/package/@google/jules-sdk) so each Discord channel becomes its own persistent Jules session — with **zero manual channel configuration**.

- **Fully automatic Discord structure.** The bot reads your Jules sources (GitHub repos) and sessions on startup, creates a Discord category per repo, a text channel per session, and a `#new-task` channel per repo for opening new sessions. No channel IDs to copy, no `access.json` to maintain.
- **Live polling.** New Jules sessions and status changes are reflected in Discord automatically (default: every 2 minutes).
- **Create tasks from Discord.** Send any message to a `#new-task` channel to start a new Jules session and get a dedicated channel for it.
- **Native file attachments.** Attached files are saved to `/tmp` with the path injected into the message.
- **Survives restarts.** `state/sessions.json` persists all mappings; on next boot sessions resume where they left off.
- **Turn count embed.** Every reply carries a `Turn N` footer.

> **Status: experimental.** Working in production for the author but there are known limits (see [Known limits](#known-limits)) and the security posture is permissive by design (see [Security](#security)).

---

## Security — read this first

This bot runs the Jules SDK which executes agents in the cloud. They are fully capable coding agents and might read any source or execute commands if instructed.

- **Use `ALLOWED_USER_IDS`** to restrict which Discord user IDs can interact with bot channels. Otherwise anyone who can see the channel can talk to Jules.
- Run the bot as a dedicated, unprivileged user — not your main account.
- Don't run it on a host with secrets you wouldn't paste in a chat.
- If you can, sandbox it (container, VM, separate machine).
- Set channel permissions at the Discord level so only trusted members can see the Jules categories.

---

## Quick start

```bash
git clone <your-fork>
cd jules-discord-bridge
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, JULES_API_KEY, and GUILD_ID
npm start
```

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>.
2. Add a bot, copy its token into `.env` as `DISCORD_TOKEN`.
3. Enable the **Message Content Intent** under "Bot → Privileged Gateway Intents".
4. Invite the bot to your server with the `bot` scope and these permissions:
   - **Send Messages**, **Read Message History**, **View Channels**
   - **Manage Channels** — required to create categories and text channels automatically.
5. Right-click your server → **Copy Server ID** (Developer Mode required) and set it as `GUILD_ID` in `.env`.

That's it. On next start the bot will create the Discord structure for all connected repos and sessions.

---

## How it works

### Auto-managed mode (`GUILD_ID` set)

```
Bot ready
   ↓
syncJulesToDiscord()
   ├─ julesClient.sources()   → one Discord category per GitHub repo
   │                             └─ #new-task channel inside each category
   └─ julesClient.sessions()  → one Discord text channel per Jules session
          └─ posts initial status message if channel is new

Recurring poll (every POLL_INTERVAL_MS)
   └─ same sync — picks up new sessions, posts status-change notifications

User sends message to #new-task
   └─ handleNewTask() creates Jules session + Discord channel, forwards message

User sends message to #task-XXXXXXXX
   └─ normal turn via ChannelAgent (same as legacy mode)
```

```
Discord message (session channel or #new-task)
   ↓
shouldProcess()  ← managed channel check OR access.json fallback
   ↓
queues.get(channelId).push(message)        ← per-channel FIFO
   ↓
processQueue()
   ├─ #new-task channel → handleNewTask() → new session + new channel
   └─ session channel   → ChannelAgent.send() → Jules SDK → reply
```

### Legacy mode (no `GUILD_ID`)

Falls back to `access.json`-based configuration — same behaviour as before.

### Streaming and artifacts

Every turn uses `session.send()` + `session.updates()` (reactive stream). This lets the bridge:

- Detect plan-approval pauses (`planGenerated` + `awaitingPlanApproval`) and show the plan before execution.
- Surface `bashOutput` artifacts as fenced code blocks.
- Surface `changeSet` artifacts as a per-file diff summary (`path: +N -M`).
- Note `media` artifacts inline.

### Plan approval flow

When Jules presents a plan:

1. The bridge sends the numbered plan to Discord and asks for `!!approve`.
2. Sending `!!approve` calls `session.approve()` and resumes the stream.
3. Sending `!!clear` discards the session entirely.

### Session storage

`state/sessions.json` persists all channel → session mappings (including auto-managed ones). On restart, the bot rebuilds its in-memory state from this file and re-registers managed channels without re-querying Discord.

---

## Special commands

These work in any session channel (including auto-managed ones):

| Command | Description |
|---|---|
| `!!clear` | Close the agent, drop the session pointer and turn count. Next message starts a fresh session. |
| `!!approve` | Approve a Jules plan that is waiting for human confirmation. |
| `!!sources` | List all GitHub repos (and other sources) connected to your Jules account. |
| `!!sessions` | Show the five most recent Jules sessions with their states. |

---

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | Bot token from the Discord developer portal |
| `JULES_API_KEY` | *(required)* | API key for Google Jules SDK |
| `GUILD_ID` | — | Discord server ID. **Set this to enable auto-managed mode.** |
| `POLL_INTERVAL_MS` | `120000` | How often (ms) to re-sync Jules → Discord. Min 10 000. |
| `SYNC_SESSION_LIMIT` | `50` | How many most-recent Jules sessions to sync per poll cycle. |
| `ALLOWED_USER_IDS` | — | Comma-separated Discord user IDs allowed in managed channels. Unset = anyone. |
| `ACCESS_JSON` | `./access.json` | Path to legacy access policy JSON (optional when `GUILD_ID` is set) |
| `STATE_DIR` | `./state` | Where `sessions.json` lives |
| `MAX_ATTACHMENT_BYTES` | `26214400` (25 MiB) | Cap on per-attachment download size |
| `MAX_IMAGE_BYTES` | `5242880` (5 MiB) | Cap on per-image attachment |
| `IDLE_MINUTES` | `30` | Close agents idle for this long. State persists; next message resumes. `0` disables. |
| `MAX_ACTIVE_AGENTS` | `8` | Cap on simultaneously-live agents. LRU eviction when exceeded. |

### `access.json` (legacy / optional)

Only needed when `GUILD_ID` is not set. When `GUILD_ID` is set, this file is ignored unless a channel is listed in it — in which case its `allowFrom` / `requireMention` / `systemPrompt` / `source` settings still apply for that channel.

```json
{
  "groups": {
    "<channelId>": {
      "allowFrom": ["<userId>", ...],
      "requireMention": true,
      "systemPrompt": "...",
      "source": { "github": "owner/repo", "baseBranch": "main" }
    }
  }
}
```

---

## Known limits

- **Single-tenant assumption.** All channels share one process, one Discord token.
- **Stale-session recovery costs one turn.** If the bridge restarts pointing at a session that no longer exists, the next message succeeds against a freshly created session.
- **Historical activity not replayed.** The Jules SDK streaming API is real-time only. When a session channel is first created for an already-completed session, only its final state is shown — past messages are not retrieved.
- **Discord rate limits.** Creating many categories/channels at once (e.g., first boot with many existing sessions) may trigger Discord rate limits. The bot retries gracefully but initial sync may take a few seconds.

---

## Architecture notes for forkers

- `bridge.mjs` is intentionally one file. If you're comfortable reading Node, the whole thing fits in your head.
- `ChannelAgent` (the per-channel persistent SDK wrapper) is unchanged from the original design.
- `syncJulesToDiscord` / `syncOneSession` / `handleNewTask` are the new pieces for auto-management.
- `state/sessions.json` now also stores `managedSessions`, `managedCategories`, and `newTaskChannels` so the full Discord structure survives restarts.

---

## License

MIT — see [LICENSE](LICENSE).
