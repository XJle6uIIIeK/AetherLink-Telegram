#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TelegramBridge } from './dist/telegram.js';
import { createMcpServer } from './dist/server-factory.js';

const appDir = process.env.AETHERLINK_HOME || path.join(os.homedir(), '.aetherlink');
const dataDir = process.env.AETHERLINK_DATA_DIR || path.join(appDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const chatIdFile = path.join(dataDir, 'chat_id.txt');
const pairingFile = path.join(dataDir, 'pairing_key.txt');
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required for remote mode');

let pairingKey = null;
if (!fs.existsSync(chatIdFile)) {
  try { pairingKey = fs.readFileSync(pairingFile, 'utf8').trim() || null; } catch {}
  if (!pairingKey) {
    pairingKey = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(pairingFile, pairingKey, { mode: 0o600 });
  }
  process.env.AETHERLINK_PAIRING_KEY = pairingKey;
}
process.env.AETHERLINK_DATA_DIR = dataDir;

const telegram = new TelegramBridge(token, {
  dataDir,
  timeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS || 300000),
});
await telegram.start();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const pathKey = process.env.MCP_PATH_KEY || '';
const mcpPath = pathKey ? `/mcp/${pathKey}` : '/mcp';
if (!pathKey) {
  console.error('[Security] MCP_PATH_KEY is not set. Set a long random value before exposing this server publicly.');
}

app.get('/health', (_req, res) => res.json({ ok: true, paired: telegram.isReady }));
app.get('/pair', async (_req, res) => {
  if (telegram.isReady) return res.type('html').send('<h2>AetherLink is already paired.</h2>');
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const info = await infoRes.json();
  const username = info?.result?.username;
  if (!username) return res.status(500).send('Telegram bot token is invalid.');
  const link = `https://t.me/${username}?start=${encodeURIComponent(pairingKey)}`;
  return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AetherLink Pairing</title><style>body{font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.c{width:min(560px,calc(100% - 32px));box-sizing:border-box;background:#1b1b1b;padding:28px;border-radius:18px;border:1px solid #333}.b{display:block;background:#2aabee;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:800;margin-top:20px}p{color:#bbb;line-height:1.5}</style></head><body><div class="c"><h1>Pair Telegram</h1><p>Bind this deployment to your Telegram account with a one-time start key.</p><a class="b" href="${link}">Open Telegram and pair</a></div></body></html>`);
});

app.all(mcpPath, async (req, res) => {
  const server = createMcpServer(telegram);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[HTTP MCP]', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const httpServer = app.listen(port, host, () => {
  console.error(`[AetherLink] Remote MCP listening on ${mcpPath} (port ${port})`);
  if (!telegram.isReady) console.error('[AetherLink] Open /pair to bind Telegram.');
});

async function shutdown() {
  httpServer.close();
  await telegram.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
