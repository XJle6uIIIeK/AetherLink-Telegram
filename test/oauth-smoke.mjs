import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 31987;
const child = spawn(process.execPath, ['remote.mjs'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

async function ready() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server did not start. ${stderr}`);
}

try {
  await ready();
  const meta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`).then(r => r.json());
  assert.equal(meta.code_challenge_methods_supported.includes('S256'), true);
  assert.equal(typeof meta.registration_endpoint, 'string');
  const protectedMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`).then(r => r.json());
  assert.equal(Array.isArray(protectedMeta.authorization_servers), true);
  const unauth = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata=/);
  console.log('oauth smoke ok');
} finally {
  child.kill('SIGTERM');
}
