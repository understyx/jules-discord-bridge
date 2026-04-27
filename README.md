# jules-discord-bridge

A Discord bot that wraps [`@google/jules-sdk`](https://www.npmjs.com/package/@google/jules-sdk) so each Discord channel becomes its own persistent Jules session.

- **Persistent sessions per channel.** Each channel gets its own Jules SDK session.
- **Native file attachments.** Attached files get saved to `/tmp` with a path injected in the text.
- **File-based access control.** A JSON file says which Discord channels are wired up, who can talk in them, and whether `@mention` is required.
- **Survives restarts.** A small pointer file (`state/sessions.json`) maps `channelId → sessionId`; on next boot the SDK resumes the session.
- **Turn count embed.** Every reply gets a tiny `Turn 12` footer so you can see where you are in the conversation.

> **Status: experimental.** Working in production for the author, but there are known bugs (see [Known issues](#known-issues)) and the security posture is permissive by design (see [Security](#security)).

---

## Security — read this first

This bot runs the Jules SDK which executes agents in the cloud. They are fully capable coding agents and might read any source or execute commands if instructed.

Treat your `access.json` like an SSH `authorized_keys` file. Specifically:

- Use `allowFrom` to whitelist specific Discord user IDs. Don't leave channels open to "anyone in the server".
- Run the bot as a dedicated, unprivileged user — not your main account.
- Don't run it on a host with secrets you wouldn't paste in a chat.
- If you can, sandbox it (container, VM, separate machine).

If this isn't the trade-off you want, this is the wrong project. A version with restricted permissions and an explicit allow-list of tools would be a meaningful fork.

---

## Quick start

```bash
git clone <your-fork>
cd jules-discord-bridge
npm install
cp .env.example .env             # add your DISCORD_TOKEN and JULES_API_KEY
cp access.json.example access.json  # add your channel IDs and user IDs
npm start
```

To run the smoke test (exercises ChannelAgent against a stale session ID):

```bash
npm test
```

To run as a systemd user service:

```bash
cp jules-discord-bridge.service.example ~/.config/systemd/user/jules-discord-bridge.service
# edit paths inside, then
systemctl --user daemon-reload
systemctl --user enable --now jules-discord-bridge.service
journalctl --user -u jules-discord-bridge -f
```

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>.
2. Add a bot, copy its token into `.env` as `DISCORD_TOKEN`.
3. Enable the **Message Content Intent** under "Bot → Privileged Gateway Intents".
4. Invite the bot to your server with the `bot` scope and `Send Messages` + `Read Message History` permissions.
5. Right-click each channel you want to enable → "Copy Channel ID" (Developer Mode required) → put the IDs in `access.json`.

---

## How it works

```
Discord message
   ↓
discord.js messageCreate
   ↓
shouldProcess()  ← access.json check (group, allowFrom, requireMention)
   ↓
queues.get(channelId).push(message)        ← per-channel FIFO
   ↓
processQueue()  ← channelBusy guard, one turn at a time per channel
   ↓
buildContent(text, attachments)
   → string
   ↓
getAgent(channelId)  ← reuse the persistent ChannelAgent
   ↓
agent.send(content, systemPrompt, source)
   ↓
session.send(content) + session.updates() stream
   ↓
Jules SDK uses Jules API
   ↓
receives agentMessaged / planGenerated / artifacts / sessionCompleted activities
   ↓
_handleTurnResult()  ← formats text + artifacts, handles plan approval pause
   ↓
msg.reply(text) + turn count embed
```

Each channel gets one `ChannelAgent` instance, which keeps a Jules session active.

### Streaming and artifacts

Every turn now uses `session.send()` + `session.updates()` (reactive stream) instead of the blocking `session.ask()`. This lets the bridge:

- Detect plan-approval pauses (`planGenerated` + `awaitingPlanApproval` state) and show the plan to users before the agent starts executing.
- Surface `bashOutput` artifacts as fenced code blocks in the Discord reply.
- Surface `changeSet` artifacts as a per-file diff summary (`path: +N -M`).
- Note `media` artifacts inline so users know something was generated.

### GitHub source per channel

Each channel entry in `access.json` can carry an optional `source` field that is forwarded to `jules.session()` when a new session is created.  Sessions linked to a repository can read and modify the repo's code, and they will pause for plan approval before making changes.

```json
"source": { "github": "your-org/your-repo", "baseBranch": "main" }
```

### Plan approval flow

When Jules finishes analyzing a repository and presents a plan:

1. The bridge sends the numbered plan to Discord and instructs the user to reply with `!!approve`.
2. Sending `!!approve` calls `session.approve()` and resumes the stream — the agent executes the plan and the result (with any diff artifacts) is sent back.
3. Sending `!!clear` discards the session entirely.


### Session storage

Across restarts, `state/sessions.json` (in the bridge directory) is the pointer file mapping each channel to its session ID. When the bridge wakes, it reads this map and calls `jules.session(sessionId)`.

## Special commands

- `!!clear` in any allowed channel — closes the agent for that channel, drops the session pointer and turn count, recreates fresh on the next message.
- `!!approve` — when Jules has generated a plan and is waiting for your approval, send this command to approve it and let the agent proceed.
- `!!sources` — list all GitHub repositories (and other sources) connected to your Jules account.
- `!!sessions` — show the five most recent Jules sessions cached locally, with their states.

---

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Bot token from the Discord developer portal |
| `JULES_API_KEY` | (required) | API key for Google Jules SDK |
| `ACCESS_JSON` | `./access.json` | Path to access policy JSON |
| `STATE_DIR` | `./state` | Where `sessions.json` lives |
| `MAX_ATTACHMENT_BYTES` | `26214400` (25 MiB) | Cap on per-attachment download size |
| `MAX_IMAGE_BYTES` | `5242880` (5 MiB) | Cap on per-image attachment |
| `IDLE_MINUTES` | `30` | Close agents idle for this long. State persists; next message resumes. `0` disables. |
| `MAX_ACTIVE_AGENTS` | `8` | Cap on simultaneously-live agents. LRU eviction when exceeded. |

### `access.json` schema

```json
{
  "groups": {
    "<channelId>": {
      "allowFrom": ["<userId>", ...],   // optional whitelist; omit to allow anyone in the channel
      "requireMention": true,            // if true, only respond when @mentioned or replied-to
      "systemPrompt": "...",             // optional system prompt for new sessions
      "source": {                        // optional Jules source — links sessions to a GitHub repo
        "github": "owner/repo",
        "baseBranch": "main"
      }
    }
  }
}
```

The file is hot-reloaded on `mtime` change — edit it without restarting.

---

## Known limits

- **Single-tenant assumption.** All channels share one process, one Discord token.
- **Stale-session recovery costs one turn.** If the bridge restarts pointing at a session that no longer exists, resending succeeds against a freshly created session.

---

## Architecture notes for forkers

- `bridge.mjs` is intentionally one file. If you're comfortable reading Node, the whole thing fits in your head.
- `ChannelAgent` (the per-channel persistent SDK wrapper) is the meat. Everything else is plumbing.

---

## License

MIT — see [LICENSE](LICENSE).
