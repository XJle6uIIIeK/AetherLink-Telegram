import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 39127;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aetherlink-oauth-'));
const child = spawn(process.execPath, ['remote.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}`, AETHERLINK_DATA_DIR: tmp },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start. ${stderr}`);
}

try {
  await waitReady();
  const metadata = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.authorization_endpoint, `http://127.0.0.1:${port}/authorize`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, `http://127.0.0.1:${port}/register`);

  const reg = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/oauth/callback'], token_endpoint_auth_method: 'none', client_name: 'smoke-test' }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.ok(client.client_id.startsWith('alc_'));

  const unauth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /oauth-protected-resource/);
  console.log('OAuth smoke test passed');
} finally {
  child.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
