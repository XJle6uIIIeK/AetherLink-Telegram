# AetherLink Telegram MCP Plugin v2.0

Telegram bridge for MCP-capable agents. This version can be installed from a GitHub repository as a Claude-compatible plugin, has a first-run setup window for the bot token, and replaces unsafe first-user pairing with a one-time `/start <key>` flow.

## What changed from v1.2

- GitHub plugin manifests: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`.
- First run opens a local settings page and asks for the Telegram BotFather token.
- The token is stored outside the repository in `~/.aetherlink/config.json` with restrictive file permissions where supported.
- Pairing is no longer “the first person who sends `/start` wins”. The plugin generates a high-entropy one-time key and a Telegram deep-link button.
- After successful `/start <key>` pairing, the key file is deleted and the Telegram user ID becomes the only authorized owner.
- Persistent state moved to `~/.aetherlink/data` by default, so plugin upgrades do not lose the paired owner or task database.
- Added Streamable HTTP remote mode for ChatGPT Web/self-hosted clients: `node remote.mjs`.
- Docker deployment included.

## Local GitHub plugin install

Replace `YOUR_GITHUB_USER` in `.claude-plugin/plugin.json` with your GitHub username, push this folder to a repository, then in Claude Code:

```text
/plugin marketplace add YOUR_GITHUB_USER/aetherlink-telegram
/plugin install aetherlink-telegram@aetherlink-telegram
```

On the first MCP launch a browser window opens automatically:

1. Paste the BotFather token.
2. Click **Save and connect**.
3. Click **Open Telegram and pair**.
4. Telegram sends `/start <one-time-key>` to your bot.
5. The key is invalidated and your Telegram account is bound to this installation.

If automatic browser opening is unavailable, the setup URL is printed to stderr. Set `AETHERLINK_NO_BROWSER=1` to disable browser launching deliberately.

## ChatGPT Web

ChatGPT Web cannot directly connect to the local `stdio` process used by desktop/CLI MCP plugins. It connects to a **remote MCP server**. OpenAI also currently marks imported plugins that declare their own `mcp.json`/`mcpServers` as **Desktop only**, even if the declared URL is remote.

For ChatGPT Web, deploy this same repository and connect the resulting remote MCP endpoint as a custom app in developer mode.

### Docker example

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN and a long random MCP_PATH_KEY
docker compose up -d --build
```

Then open:

```text
https://YOUR_HOST/pair
```

and pair your Telegram account. Your MCP URL is:

```text
https://YOUR_HOST/mcp/YOUR_MCP_PATH_KEY
```

Use that URL when creating the custom MCP app in ChatGPT.

> `MCP_PATH_KEY` is a pragmatic single-user protection mechanism for self-hosting. For a public/multi-user production service, put OAuth 2.1 or an authenticated gateway in front of the MCP endpoint instead of relying only on an unguessable path.

## Storage

Default local state:

```text
~/.aetherlink/
├── config.json          # bot token for local plugin mode
└── data/
    ├── chat_id.txt      # paired Telegram owner
    ├── pairing_key.txt  # exists only until successful pairing
    └── tasks.sqlite
```

Override with:

```bash
AETHERLINK_HOME=/custom/path
AETHERLINK_DATA_DIR=/custom/path/data
```

## MCP tools

- `tg_notify` — send a Telegram notification.
- `tg_confirm` — blocking Approve / Deny confirmation.
- `tg_ask` — ask a free-text or button-based question.
- `tg_inbox` / `tg_ack` — durable incoming task queue.
- `tg_progress` — update task progress.
- `tg_complete` / `tg_fail` — finish a task.
- `tg_cancelled` / `tg_task_status` — cancellation and status checks.
- `tg_send_file` / `tg_send_files` — send local result files.
- `tg_take_screenshot` — take and send a Playwright screenshot.

The existing `/menu`, `/status`, `/files`, `/run` and voice/file flows from v1.2 are preserved.

## Development

```bash
npm install
npm test
npm run build
```

For the screenshot feature install Chromium once:

```bash
npx playwright install chromium
```

Local plugin entry:

```bash
node start.mjs
```

Remote MCP entry:

```bash
TELEGRAM_BOT_TOKEN=... MCP_PATH_KEY=... node remote.mjs
```

## Security notes

- Never commit `~/.aetherlink/config.json`, `.env`, the bot token, pairing key, or task database.
- Rotate the BotFather token if it was ever committed or shared.
- `/run` executes shell commands on the host machine. Keep the Telegram bot private and protect remote MCP access.
- Use HTTPS in front of remote mode.
