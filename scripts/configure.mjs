#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const url = (arg('--url') || '').replace(/\/$/, '');
const github = (arg('--github') || '').replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
if (!url || !/^https:\/\//i.test(url)) {
  console.error('Usage: npm run configure -- --url https://your-domain.example [--github owner/repo]');
  process.exit(1);
}
for (const file of ['mcp.json', '.mcp.json']) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.mcpServers['aetherlink-telegram'].url = `${url}/mcp`;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
}
if (github) {
  for (const file of ['plugin.json', '.claude-plugin/plugin.json']) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.repository = `https://github.com/${github}`;
    j.homepage = `${j.repository}#readme`;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  }
}
console.log(`Configured remote MCP: ${url}/mcp`);
