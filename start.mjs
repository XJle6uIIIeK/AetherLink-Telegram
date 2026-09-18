#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.AETHERLINK_HOME || path.join(os.homedir(), '.aetherlink');
const configFile = path.join(appDir, 'config.json');
const dataDir = process.env.AETHERLINK_DATA_DIR || path.join(appDir, 'data');
const chatIdFile = path.join(dataDir, 'chat_id.txt');
const pairingFile = path.join(dataDir, 'pairing_key.txt');
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(configFile, 0o600); } catch {}
}
function newPairingKey() {
  return crypto.randomBytes(18).toString('base64url');
}
function pairingKey() {
  if (fs.existsSync(chatIdFile)) return null;
  try {
    const current = fs.readFileSync(pairingFile, 'utf8').trim();
    if (current) return current;
  } catch {}
  const key = newPairingKey();
  fs.writeFileSync(pairingFile, key, { mode: 0o600 });
  return key;
}
function openBrowser(url) {
  if (process.env.AETHERLINK_NO_BROWSER === '1') return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}
async function botInfo(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const json = await res.json();
  if (!json?.ok || !json?.result?.username) throw new Error(json?.description || 'Telegram rejected this bot token');
  return json.result;
}

async function setupWizard(existing = {}) {
  let resolved = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AetherLink setup</title><style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(560px,calc(100% - 32px));background:#1b1b1b;border:1px solid #333;border-radius:18px;padding:28px;box-sizing:border-box}h1{margin:0 0 8px;font-size:26px}p{color:#bdbdbd;line-height:1.45}label{display:block;margin:18px 0 8px;font-weight:650}input{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:10px;border:1px solid #444;background:#101010;color:#fff;font:inherit}button{margin-top:18px;width:100%;border:0;border-radius:10px;padding:13px 16px;font:inherit;font-weight:750;cursor:pointer}.small{font-size:13px;color:#8d8d8d}</style></head><body><main class="card"><h1>Telegram MCP setup</h1><p>Введите токен бота от @BotFather. Токен будет сохранён только локально в <code>${configFile.replaceAll('&','&amp;').replaceAll('<','&lt;')}</code>.</p><form method="post" action="/save"><label>Bot token</label><input type="password" name="token" autocomplete="off" placeholder="123456:ABC…" required><button type="submit">Сохранить и подключить</button></form><p class="small">После сохранения появится кнопка привязки Telegram через одноразовый /start-ключ.</p></main></body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/save') {
      let body=''; for await (const chunk of req) body += chunk;
      const token = new URLSearchParams(body).get('token')?.trim() || '';
      try {
        const info = await botInfo(token);
        writeConfig({ ...existing, telegramBotToken: token });
        const key = pairingKey();
        const link = key ? `https://t.me/${info.username}?start=${encodeURIComponent(key)}` : `https://t.me/${info.username}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AetherLink paired setup</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(560px,calc(100% - 32px));background:#1b1b1b;border:1px solid #333;border-radius:18px;padding:28px}.btn{display:block;text-decoration:none;text-align:center;background:#2aabee;color:white;padding:14px 16px;border-radius:11px;font-weight:800;margin-top:20px}code{word-break:break-all;color:#ddd}.small{color:#aaa}</style></head><body><main class="card"><h1>Токен сохранён ✓</h1><p>Бот: <b>@${info.username}</b></p>${key ? `<p>Теперь привяжите Telegram-аккаунт. Ключ одноразовый и перестанет работать после успешной привязки.</p><a class="btn" href="${link}">Открыть Telegram и привязать</a><p class="small">Команда: <code>/start ${key}</code></p>` : `<p>Telegram уже был привязан ранее.</p><a class="btn" href="${link}">Открыть бота</a>`}<p class="small">Это окно можно закрыть.</p></main></body></html>`);
        if (!resolved) { resolved = true; finish({ token, key }); setTimeout(() => server.close(), 1200); }
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<h2>Ошибка</h2><p>${String(e?.message || e)}</p><p><a href="/">Назад</a></p>`);
      }
      return;
    }
    res.writeHead(404); res.end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}/`;
  console.error(`[AetherLink] Setup: ${url}`);
  openBrowser(url);
  return done;
}

async function ensureDependencies() {
  const sdkMarker = path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  if (fs.existsSync(sdkMarker)) return;
  console.error('[AetherLink] Installing runtime dependencies…');
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm install failed with code ${code}`)));
    child.on('error', reject);
  });
}

let cfg = readConfig();
let token = process.env.TELEGRAM_BOT_TOKEN || cfg.telegramBotToken;
if (!token) {
  const result = await setupWizard(cfg);
  token = result.token;
  cfg = readConfig();
}
const key = pairingKey();
process.env.TELEGRAM_BOT_TOKEN = token;
process.env.AETHERLINK_DATA_DIR = dataDir;
if (key) process.env.AETHERLINK_PAIRING_KEY = key;
if (!process.env.RESPONSE_TIMEOUT_MS && cfg.responseTimeoutMs) process.env.RESPONSE_TIMEOUT_MS = String(cfg.responseTimeoutMs);
if (!process.env.GEMINI_API_KEY && cfg.geminiApiKey) process.env.GEMINI_API_KEY = cfg.geminiApiKey;

await ensureDependencies();
await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
