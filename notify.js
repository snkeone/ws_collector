import fs from 'fs';
import os from 'os';
import path from 'path';

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const idx = s.indexOf('=');
      if (idx <= 0) continue;
      const key = s.slice(0, idx).trim();
      const val = s.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {
    // no-op
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env'));
loadEnvFile(path.resolve(process.cwd(), '.env.local'));

function pickWebhook() {
  return (
    process.env.DEV_DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL ||
    ''
  ).trim();
}

export async function sendDiscord(level, message, extra = {}) {
  const webhook = pickWebhook();
  const dryRun = String(process.env.WS_COLLECTOR_DRY_RUN || '') === '1';
  const ts = new Date().toISOString();
  const host = os.hostname();
  const lines = [
    `WS_COLLECTOR ${String(level || 'info').toUpperCase()}`,
    `Time(UTC): ${ts}`,
    `Host: ${host}`,
    `Message: ${message}`
  ];

  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined) continue;
      lines.push(`${k}: ${String(v)}`);
    }
  }
  const content = lines.join('\n');

  if (!webhook) {
    console.log('[notify] webhook is not set, skip');
    return false;
  }
  if (dryRun) {
    console.log('[notify][dry-run]', content);
    return true;
  }

  const resp = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`discord webhook failed status=${resp.status} body=${body.slice(0, 200)}`);
  }
  return true;
}

