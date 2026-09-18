#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
function arg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}
const url = (arg('--url') || '').replace(/\/$/, '');
const github = (arg('--github') || '').replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
if (!url || !/^https:\/\//i.test(url)) {
  console.error('Usage: npm run configure -- --url https://your-domain.example [--github owner/repo]');
  process.exit(1);
}

const portable = JSON.parse(fs.readFileSync('mcp.json', 'utf8'));
portable.mcpServers['aetherlink-telegram'].url = `${url}/mcp`;
fs.writeFileSync('mcp.json', JSON.stringify(portable, null, 2) + '\n');

const compat = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
compat.mcpServers['aetherlink-telegram'].url = `${url}/mcp`;
fs.writeFileSync('.mcp.json', JSON.stringify(compat, null, 2) + '\n');

if (github) {
  for (const file of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf8');
    text = text.replaceAll('YOUR_GITHUB_USER/aetherlink-telegram', github);
    text = text.replaceAll('YOUR_GITHUB_USER', github.split('/')[0]);
    fs.writeFileSync(file, text);
  }
  const plugin = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
  plugin.repository = `https://github.com/${github}`;
  plugin.homepage = `https://github.com/${github}#readme`;
  fs.writeFileSync('plugin.json', JSON.stringify(plugin, null, 2) + '\n');
}

console.log(`Configured remote MCP: ${url}/mcp`);
if (github) console.log(`Configured repository: https://github.com/${github}`);
