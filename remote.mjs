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
const accountsDir = path.join(dataDir, 'accounts');
const storeFile = path.join(dataDir, 'oauth-store.json');
const masterKeyFile = path.join(dataDir, 'master.key');
const responseTimeoutMs = Number(process.env.RESPONSE_TIMEOUT_MS || 300000);
const accessTokenTtlMs = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600) * 1000;
const refreshTokenTtlMs = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 2592000) * 1000;
const authSessionTtlMs = Number(process.env.AUTH_SESSION_TTL_SECONDS || 900) * 1000;
const authCodeTtlMs = 5 * 60 * 1000;
const pairingTtlMs = Number(process.env.PAIRING_TTL_SECONDS || 600) * 1000;
const scopesSupported = ['telegram:read', 'telegram:write', 'offline_access'];

fs.mkdirSync(accountsDir, { recursive: true });

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}
function hmac(value, key) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}
function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function html(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function secureWrite(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function loadMasterKey() {
  if (process.env.AETHERLINK_MASTER_KEY) {
    return crypto.createHash('sha256').update(process.env.AETHERLINK_MASTER_KEY).digest();
  }
  try {
    const existing = fs.readFileSync(masterKeyFile);
    if (existing.length === 32) return existing;
  } catch {}
  const key = crypto.randomBytes(32);
  secureWrite(masterKeyFile, key);
  return key;
}
const masterKey = loadMasterKey();

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}
function decryptSecret(encoded) {
  const [version, iv64, tag64, ciphertext64] = String(encoded || '').split('.');
  if (version !== 'v1' || !iv64 || !tag64 || !ciphertext64) throw new Error('Unsupported encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function emptyStore() {
  return { version: 1, clients: {}, accounts: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} };
}
function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}
let store = loadStore();
function cleanupStore() {
  const now = Date.now();
  for (const section of ['authCodes', 'accessTokens', 'refreshTokens']) {
    for (const [key, value] of Object.entries(store[section])) {
      if (!value?.expiresAt || value.expiresAt <= now) delete store[section][key];
    }
  }
}
function saveStore() {
  cleanupStore();
  secureWrite(storeFile, JSON.stringify(store, null, 2));
}

function publicBase(req) {
  const configured = process.env.PUBLIC_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`).split(',')[0].trim();
  return `${proto}://${host}`;
}
function resourceId(req) {
  return process.env.MCP_RESOURCE?.trim().replace(/\/$/, '') || publicBase(req);
}
function accountDir(profileId) {
  return path.join(accountsDir, profileId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}
function parseCookies(req) {
  const out = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const idx = item.indexOf('=');
    if (idx > 0) out[item.slice(0, idx).trim()] = decodeURIComponent(item.slice(idx + 1).trim());
  }
  return out;
}
function bearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
function oauthChallenge(req, error = 'invalid_token', description = 'Authentication required') {
  const base = publicBase(req);
  return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="${error}", error_description="${String(description).replaceAll('"', '\\"')}"`;
}
function normalizeScope(scope) {
  const requested = String(scope || '').split(/\s+/).filter(Boolean);
  const allowed = requested.filter((s) => scopesSupported.includes(s));
  if (!allowed.includes('telegram:read')) allowed.push('telegram:read');
  if (!allowed.includes('telegram:write')) allowed.push('telegram:write');
  if (!allowed.includes('offline_access')) allowed.push('offline_access');
  return [...new Set(allowed)].join(' ');
}

async function telegramBotInfo(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, { signal: controller.signal });
    const json = await res.json();
    if (!json?.ok || !json?.result?.id || !json?.result?.username) {
      throw new Error(json?.description || 'Telegram rejected this bot token');
    }
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

const authSessions = new Map();
const bridgeEntries = new Map();

async function stopBridge(profileId) {
  const entry = bridgeEntries.get(profileId);
  if (!entry) return;
  bridgeEntries.delete(profileId);
  try { await entry.bridge.stop(); } catch {}
}
async function startBridge(profileId, token, pairingKey = null, pairingExpiresAt = null) {
  const existing = bridgeEntries.get(profileId);
  if (existing && existing.tokenFingerprint === sha256(token) && (!pairingKey || existing.pairingKey === pairingKey)) {
    existing.lastUsedAt = Date.now();
    return existing.bridge;
  }
  if (existing) await stopBridge(profileId);
  const dir = accountDir(profileId);
  fs.mkdirSync(dir, { recursive: true });
  const bridge = new TelegramBridge(token, { dataDir: dir, timeoutMs: responseTimeoutMs, pairingKey: pairingKey || undefined, pairingExpiresAt: pairingExpiresAt || undefined });
  await bridge.start();
  bridgeEntries.set(profileId, {
    bridge,
    tokenFingerprint: sha256(token),
    pairingKey,
    lastUsedAt: Date.now(),
  });
  return bridge;
}
async function bridgeForAccount(account) {
  const token = decryptSecret(account.botToken);
  return startBridge(account.profileId, token, null);
}

function validateClientRedirect(clientId, redirectUri) {
  const client = store.clients[clientId];
  if (!client) return false;
  return Array.isArray(client.redirectUris) && client.redirectUris.includes(redirectUri);
}
function validateRedirectUri(uri) {
  try {
    const parsed = new URL(uri);
    return ['https:', 'http:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
function redirectOAuthError(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.redirect(303, url.toString());
}

function pageShell(title, body, script = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101114;color:#f2f3f5;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}.card{width:min(590px,calc(100% - 28px));background:#191b20;border:1px solid #30333a;border-radius:20px;padding:28px;box-shadow:0 20px 80px #0007}h1{margin:0 0 10px;font-size:28px}.muted{color:#a7abb5;line-height:1.55}.bot{padding:12px 14px;background:#111318;border:1px solid #2b2e35;border-radius:12px;margin:16px 0}label{display:block;font-weight:700;margin:18px 0 8px}input{width:100%;padding:13px 14px;border-radius:11px;border:1px solid #3a3e47;background:#0f1115;color:#fff;font:inherit}.btn,button{width:100%;display:block;border:0;border-radius:11px;padding:14px 16px;background:#2aabee;color:white;text-align:center;text-decoration:none;font:inherit;font-weight:800;cursor:pointer;margin-top:16px}.secondary{background:#2a2d34}.ok{color:#73d99b}.warn{color:#ffcb6b}.err{color:#ff8080}.small{font-size:13px;color:#858b97;margin-top:16px}code{word-break:break-all}</style></head><body><main class="card">${body}</main>${script}</body></html>`;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));

app.get('/health', (_req, res) => {
  cleanupStore();
  res.json({ ok: true, service: 'aetherlink-telegram', version: '2.1.0', accounts: Object.keys(store.accounts).length });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = publicBase(req);
  res.json({
    resource: resourceId(req),
    authorization_servers: [base],
    scopes_supported: scopesSupported,
    resource_documentation: `${base}/docs`,
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = publicBase(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scopesSupported,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  });
});

app.post('/register', (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
  if (!redirectUris.length || redirectUris.some((uri) => !validateRedirectUri(uri))) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  const requestedAuth = req.body?.token_endpoint_auth_method || 'none';
  if (requestedAuth !== 'none') {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Only public PKCE clients are supported.' });
  }
  const clientId = `alc_${randomToken(24)}`;
  const client = {
    clientId,
    clientName: String(req.body?.client_name || 'OpenAI MCP client').slice(0, 200),
    redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
  };
  store.clients[clientId] = client;
  saveStore();
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: 'none',
  });
});

app.get('/authorize', (req, res) => {
  const {
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    resource,
  } = req.query;
  if (responseType !== 'code') return res.status(400).send('Unsupported response_type');
  if (!clientId || !redirectUri || !validateClientRedirect(String(clientId), String(redirectUri))) return res.status(400).send('Invalid client or redirect_uri');
  if (!codeChallenge || codeChallengeMethod !== 'S256') return redirectOAuthError(res, String(redirectUri), String(state || ''), 'invalid_request', 'PKCE S256 is required');
  const expectedResource = resourceId(req);
  if (resource && String(resource).replace(/\/$/, '') !== expectedResource) {
    return redirectOAuthError(res, String(redirectUri), String(state || ''), 'invalid_target', 'Unexpected resource parameter');
  }
  const sid = randomToken(24);
  const csrf = randomToken(18);
  authSessions.set(sid, {
    sid,
    csrf,
    createdAt: Date.now(),
    expiresAt: Date.now() + authSessionTtlMs,
    clientId: String(clientId),
    redirectUri: String(redirectUri),
    state: String(state || ''),
    codeChallenge: String(codeChallenge),
    resource: expectedResource,
    scope: normalizeScope(req.query.scope),
    bridge: null,
    profileId: null,
    botInfo: null,
    token: null,
    pairingKey: null,
  });
  const secure = publicBase(req).startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `aether_auth=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1000)}${secure}`);
  res.type('html').send(pageShell('Подключить AetherLink', `
    <h1>Подключить Telegram</h1>
    <p class="muted">Введите токен бота, который вы получили у <b>@BotFather</b>. Токен попадёт только на ваш AetherLink-сервер и не передаётся модели ChatGPT.</p>
    <form method="post" action="/oauth/setup">
      <input type="hidden" name="csrf" value="${html(csrf)}">
      <label>Telegram Bot Token</label>
      <input type="password" name="token" autocomplete="off" placeholder="123456789:AA..." required>
      <button type="submit">Проверить токен</button>
    </form>
    <p class="small">После проверки появится кнопка для одноразовой привязки через <code>/start &lt;key&gt;</code>.</p>`));
});

function getAuthSession(req) {
  const sid = parseCookies(req).aether_auth;
  const session = sid ? authSessions.get(sid) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (sid) authSessions.delete(sid);
    return null;
  }
  return session;
}
function csrfOk(req, session) {
  return session && req.body?.csrf && timingSafeEqualText(req.body.csrf, session.csrf);
}

app.post('/oauth/setup', async (req, res) => {
  const session = getAuthSession(req);
  if (!session || !csrfOk(req, session)) return res.status(400).send('Authorization session expired or CSRF check failed.');
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).send('Bot token is required.');
  try {
    const info = await telegramBotInfo(token);
    const profileId = `tg_${hmac(String(info.id), masterKey).slice(0, 32)}`;
    const dir = accountDir(profileId);
    fs.mkdirSync(dir, { recursive: true });
    const alreadyPaired = fs.existsSync(path.join(dir, 'chat_id.txt'));
    const pairingKey = alreadyPaired ? null : randomToken(18);
    if (pairingKey) secureWrite(path.join(dir, 'pairing_key.txt'), pairingKey);
    const pairingExpiresAt = pairingKey ? Date.now() + pairingTtlMs : null;
    const bridge = await startBridge(profileId, token, pairingKey, pairingExpiresAt);
    session.bridge = bridge;
    session.profileId = profileId;
    session.botInfo = { id: info.id, username: info.username, firstName: info.first_name || info.username };
    session.token = token;
    session.pairingKey = pairingKey;
    session.pairingExpiresAt = pairingExpiresAt;
    const link = pairingKey ? `https://t.me/${encodeURIComponent(info.username)}?start=${encodeURIComponent(pairingKey)}` : `https://t.me/${encodeURIComponent(info.username)}`;
    const status = alreadyPaired ? '<p class="ok"><b>✓ Этот бот уже привязан.</b></p>' : '<p id="status" class="warn"><b>Ожидаю /start…</b></p>';
    res.type('html').send(pageShell('Привязать Telegram', `
      <h1>@${html(info.username)}</h1>
      <p class="muted">Токен проверен. Теперь подтвердите, какой Telegram-аккаунт является владельцем этого подключения.</p>
      ${status}
      ${alreadyPaired ? '' : `<a class="btn" href="${html(link)}" target="_blank" rel="noopener">Открыть Telegram и привязать</a>`}
      <form id="complete" method="post" action="/oauth/complete" style="${alreadyPaired ? '' : 'display:none'}">
        <input type="hidden" name="csrf" value="${html(session.csrf)}">
        <button type="submit" class="secondary">Продолжить в ChatGPT</button>
      </form>
      <p class="small">Ключ одноразовый и действует ${Math.round(pairingTtlMs / 60000)} мин. После успешного <code>/start</code> он удаляется.</p>`, alreadyPaired ? '' : `<script>
        const status=document.getElementById('status'); const form=document.getElementById('complete');
        async function poll(){try{const r=await fetch('/oauth/status',{cache:'no-store'});const j=await r.json();if(j.paired){status.className='ok';status.innerHTML='<b>✓ Telegram привязан.</b>';form.style.display='block';return;}if(j.expired){status.className='err';status.innerHTML='<b>Ключ истёк. Начните подключение заново.</b>';return;}}catch{}setTimeout(poll,1200)}poll();
      </script>`));
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Telegram API timeout' : String(error?.message || error);
    res.status(400).type('html').send(pageShell('Ошибка токена', `<h1>Не удалось проверить токен</h1><p class="err">${html(message)}</p><p class="muted">Вернитесь назад и вставьте токен из @BotFather без лишних пробелов.</p><button class="secondary" onclick="history.back()">Назад</button>`));
  }
});

app.get('/oauth/status', (req, res) => {
  const session = getAuthSession(req);
  if (!session) return res.status(404).json({ paired: false, expired: true });
  const expired = Boolean(session.pairingExpiresAt && session.pairingExpiresAt <= Date.now() && !session.bridge?.isReady);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ paired: Boolean(session.bridge?.isReady), expired, bot: session.botInfo?.username || null });
});

app.post('/oauth/complete', (req, res) => {
  const session = getAuthSession(req);
  if (!session || !csrfOk(req, session)) return res.status(400).send('Authorization session expired or CSRF check failed.');
  if (!session.bridge?.isReady || !session.profileId || !session.botInfo || !session.token) return res.status(409).send('Telegram pairing is not complete.');
  const now = Date.now();
  const existing = store.accounts[session.profileId];
  store.accounts[session.profileId] = {
    profileId: session.profileId,
    botId: String(session.botInfo.id),
    botUsername: session.botInfo.username,
    displayName: session.botInfo.firstName,
    botToken: encryptSecret(session.token),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const code = randomToken(32);
  store.authCodes[sha256(code)] = {
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    resource: session.resource,
    scope: session.scope,
    profileId: session.profileId,
    expiresAt: now + authCodeTtlMs,
  };
  saveStore();
  const redirect = new URL(session.redirectUri);
  redirect.searchParams.set('code', code);
  if (session.state) redirect.searchParams.set('state', session.state);
  redirect.searchParams.set('iss', publicBase(req));
  authSessions.delete(session.sid);
  res.redirect(303, redirect.toString());
});

function issueTokens({ profileId, clientId, resource, scope }) {
  const accessToken = `ala_${randomToken(36)}`;
  const refreshToken = `alr_${randomToken(40)}`;
  const now = Date.now();
  store.accessTokens[sha256(accessToken)] = { profileId, clientId, resource, scope, issuedAt: now, expiresAt: now + accessTokenTtlMs };
  store.refreshTokens[sha256(refreshToken)] = { profileId, clientId, resource, scope, issuedAt: now, expiresAt: now + refreshTokenTtlMs };
  saveStore();
  return { accessToken, refreshToken };
}

app.post('/token', (req, res) => {
  const grantType = String(req.body?.grant_type || '');
  const clientId = String(req.body?.client_id || '');
  if (!clientId || !store.clients[clientId]) return res.status(401).json({ error: 'invalid_client' });
  if (grantType === 'authorization_code') {
    const code = String(req.body?.code || '');
    const recordKey = sha256(code);
    const record = store.authCodes[recordKey];
    if (!record || record.expiresAt <= Date.now()) return res.status(400).json({ error: 'invalid_grant' });
    if (record.clientId !== clientId || record.redirectUri !== String(req.body?.redirect_uri || '')) return res.status(400).json({ error: 'invalid_grant' });
    const verifier = String(req.body?.code_verifier || '');
    if (!verifier || !timingSafeEqualText(sha256(verifier), record.codeChallenge)) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    if (req.body?.resource && String(req.body.resource).replace(/\/$/, '') !== record.resource) return res.status(400).json({ error: 'invalid_target' });
    delete store.authCodes[recordKey];
    const issued = issueTokens(record);
    return res.json({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(accessTokenTtlMs / 1000),
      refresh_token: issued.refreshToken,
      scope: record.scope,
    });
  }
  if (grantType === 'refresh_token') {
    const refreshToken = String(req.body?.refresh_token || '');
    const key = sha256(refreshToken);
    const record = store.refreshTokens[key];
    if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) return res.status(400).json({ error: 'invalid_grant' });
    if (req.body?.resource && String(req.body.resource).replace(/\/$/, '') !== record.resource) return res.status(400).json({ error: 'invalid_target' });
    delete store.refreshTokens[key];
    const issued = issueTokens(record);
    return res.json({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(accessTokenTtlMs / 1000),
      refresh_token: issued.refreshToken,
      scope: record.scope,
    });
  }
  return res.status(400).json({ error: 'unsupported_grant_type' });
});

function authenticate(req, res, next) {
  cleanupStore();
  const token = bearer(req);
  const record = token ? store.accessTokens[sha256(token)] : null;
  if (!record || record.expiresAt <= Date.now()) {
    res.setHeader('WWW-Authenticate', oauthChallenge(req));
    return res.status(401).json({ error: 'invalid_token', error_description: 'Connect AetherLink with OAuth before using Telegram tools.' });
  }
  if (record.resource !== resourceId(req)) {
    res.setHeader('WWW-Authenticate', oauthChallenge(req, 'invalid_token', 'Token audience does not match this MCP resource'));
    return res.status(401).json({ error: 'invalid_token' });
  }
  const account = store.accounts[record.profileId];
  if (!account) {
    res.setHeader('WWW-Authenticate', oauthChallenge(req, 'invalid_token', 'Connected Telegram profile no longer exists'));
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.aetherAuth = { token: record, account };
  next();
}

app.all('/mcp', authenticate, async (req, res) => {
  const account = req.aetherAuth.account;
  try {
    const telegram = await bridgeForAccount(account);
    const profile = {
      id: account.profileId,
      name: account.displayName || account.botUsername,
      nickname: `@${account.botUsername}`,
    };
    const server = createMcpServer(telegram, {
      profile,
      oauthScopes: ['telegram:read', 'telegram:write'],
      authChallenge: oauthChallenge(req, 'insufficient_scope', 'Reconnect AetherLink to grant Telegram access'),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[HTTP MCP]', error instanceof Error ? error.message : error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

app.get('/docs', (req, res) => {
  const base = publicBase(req);
  res.type('html').send(pageShell('AetherLink Telegram MCP', `
    <h1>AetherLink Telegram MCP</h1>
    <p class="muted">Remote MCP endpoint for ChatGPT/Codex with OAuth 2.1-style Authorization Code + PKCE and one-time Telegram pairing.</p>
    <div class="bot"><b>MCP endpoint</b><br><code>${html(base)}/mcp</code></div>
    <div class="bot"><b>OAuth discovery</b><br><code>${html(base)}/.well-known/oauth-authorization-server</code></div>
    <p class="small">For production, serve this application behind HTTPS and set <code>PUBLIC_URL</code> to the exact public origin.</p>`));
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const httpServer = app.listen(port, host, () => {
  const advertised = process.env.PUBLIC_URL || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.error(`[AetherLink] ChatGPT-ready MCP v2.1.0: ${advertised.replace(/\/$/, '')}/mcp`);
  if (!process.env.PUBLIC_URL) console.error('[AetherLink] PUBLIC_URL is not set; localhost discovery is enabled for development only.');
});

async function shutdown() {
  httpServer.close();
  await Promise.allSettled([...bridgeEntries.keys()].map((id) => stopBridge(id)));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of authSessions) {
    if (session.expiresAt <= now) {
      authSessions.delete(sid);
      if (session.profileId && !store.accounts[session.profileId] && !session.bridge?.isReady) {
        void stopBridge(session.profileId);
      }
    }
  }
  cleanupStore();
  saveStore();
}, 60_000).unref();
