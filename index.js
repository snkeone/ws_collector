#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { sendDiscord } from './notify.js';

const WS_URL = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const SHARED_FEED_FILE = path.resolve(process.env.WS_SHARED_FEED_FILE || '/tmp/hlws-shared-feed.jsonl');
const LOG_DIR = path.resolve(process.env.WS_COLLECTOR_LOG_DIR || path.resolve(process.cwd(), 'logs'));
const RAW_PREFIX = String(process.env.WS_COLLECTOR_RAW_PREFIX || 'raw-');

const SYMBOLS = String(process.env.WS_SHARED_SYMBOLS || 'BTC')
  .split(',')
  .map((v) => v.trim().toUpperCase())
  .filter(Boolean);

const SUB_TYPES = String(process.env.WS_SHARED_SUB_TYPES || 'l2Book,trades,activeAssetCtx')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const RECONNECT_MS = Math.max(500, Number(process.env.WS_COLLECTOR_RECONNECT_MS || 3000));
const HEARTBEAT_MS = Math.max(1000, Number(process.env.WS_COLLECTOR_HEARTBEAT_MS || 15000));
const QUEUE_WARN_LIMIT = Math.max(1000, Number(process.env.WS_COLLECTOR_QUEUE_WARN_LIMIT || 50000));
const HEARTBEAT_FILE = path.resolve(process.env.WS_COLLECTOR_HEARTBEAT_FILE || '/tmp/ws_collector_heartbeat.json');
const STATUS_FLUSH_MS = Math.max(1000, Number(process.env.WS_COLLECTOR_STATUS_FLUSH_MS || 5000));
const LOG_ROTATE_CHECK_MS = Math.max(60_000, Number(process.env.WS_COLLECTOR_LOG_ROTATE_CHECK_MS || 3_600_000));
const LOG_COMPRESS_AFTER_DAYS = Math.max(0, Number(process.env.WS_COLLECTOR_LOG_COMPRESS_AFTER_DAYS || 2));
const LOG_KEEP_DAYS = Math.max(LOG_COMPRESS_AFTER_DAYS + 1, Number(process.env.WS_COLLECTOR_LOG_KEEP_DAYS || 7));

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let rotateTimer = null;
let stopped = false;
let queue = [];
let writing = false;
let lastMessageAt = 0;
let startTs = Date.now();
let statusTimer = null;
let wsConnected = false;

function log(msg, extra = null) {
  if (extra) {
    console.log(`[ws_collector] ${msg}`, extra);
  } else {
    console.log(`[ws_collector] ${msg}`);
  }
}

function ymdUtc(ts = Date.now()) {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function rawFileByTs(ts = Date.now()) {
  return path.join(LOG_DIR, `${RAW_PREFIX}${ymdUtc(ts)}.jsonl`);
}

async function ensureOutput() {
  await fs.promises.mkdir(path.dirname(SHARED_FEED_FILE), { recursive: true });
  await fs.promises.appendFile(SHARED_FEED_FILE, '');
  await fs.promises.mkdir(LOG_DIR, { recursive: true });
  await fs.promises.mkdir(path.dirname(HEARTBEAT_FILE), { recursive: true });
}

async function writeHeartbeat(state = 'running') {
  const payload = {
    ts: Date.now(),
    pid: process.pid,
    state,
    startTs,
    wsConnected,
    lastMessageAt,
    sharedFeedFile: SHARED_FEED_FILE,
    rawFile: rawFileByTs(),
    symbols: SYMBOLS,
    subTypes: SUB_TYPES,
    queueLength: queue.length
  };
  await fs.promises.writeFile(HEARTBEAT_FILE, JSON.stringify(payload), 'utf8');
}

function enqueue(line) {
  queue.push(line);
  if (queue.length > QUEUE_WARN_LIMIT) {
    log(`queue high-watermark: ${queue.length}`);
  }
  setImmediate(() => {
    flush().catch((err) => {
      console.error('[ws_collector] flush failed', err?.message ?? err);
    });
  });
}

async function flush() {
  if (writing || queue.length === 0) return;
  writing = true;
  try {
    const lines = queue.splice(0, queue.length);
    const payload = lines.join('\n') + '\n';
    const rawPath = rawFileByTs();
    const targets = new Set([rawPath, SHARED_FEED_FILE]);
    for (const f of targets) {
      await fs.promises.appendFile(f, payload, 'utf8');
    }
  } finally {
    writing = false;
  }
}

function daysOldFromYmd(ymd, nowTs = Date.now()) {
  if (!/^\d{8}$/.test(ymd)) return null;
  const yyyy = Number(ymd.slice(0, 4));
  const mm = Number(ymd.slice(4, 6)) - 1;
  const dd = Number(ymd.slice(6, 8));
  const fileTs = Date.UTC(yyyy, mm, dd, 0, 0, 0, 0);
  if (!Number.isFinite(fileTs)) return null;
  return Math.floor((nowTs - fileTs) / 86_400_000);
}

async function runLogRetention() {
  try {
    const names = await fs.promises.readdir(LOG_DIR);
    const nowTs = Date.now();
    for (const name of names) {
      const mRaw = name.match(new RegExp(`^${RAW_PREFIX}(\\d{8})\\.jsonl$`));
      const mGz = name.match(new RegExp(`^${RAW_PREFIX}(\\d{8})\\.jsonl\\.gz$`));
      if (mRaw) {
        const age = daysOldFromYmd(mRaw[1], nowTs);
        if (age !== null && age >= LOG_COMPRESS_AFTER_DAYS) {
          const src = path.join(LOG_DIR, name);
          const dst = `${src}.gz`;
          if (!fs.existsSync(dst)) {
            const raw = await fs.promises.readFile(src);
            const zlib = await import('zlib');
            const gz = zlib.gzipSync(raw, { level: 1 });
            await fs.promises.writeFile(dst, gz);
          }
          await fs.promises.unlink(src).catch(() => {});
        }
        continue;
      }
      if (mGz) {
        const age = daysOldFromYmd(mGz[1], nowTs);
        if (age !== null && age > LOG_KEEP_DAYS) {
          await fs.promises.unlink(path.join(LOG_DIR, name)).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[ws_collector] log retention failed', err?.message ?? err);
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const age = Date.now() - lastMessageAt;
    if (lastMessageAt > 0 && age > HEARTBEAT_MS) {
      log(`stale detected ageMs=${age}, reconnecting`);
      try { ws?.close(); } catch (_) {}
    }
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopStatusFlush() {
  if (!statusTimer) return;
  clearInterval(statusTimer);
  statusTimer = null;
}

function startStatusFlush() {
  stopStatusFlush();
  statusTimer = setInterval(() => {
    writeHeartbeat('running').catch(() => {});
  }, STATUS_FLUSH_MS);
  if (statusTimer.unref) statusTimer.unref();
}

function stopRotateTimer() {
  if (!rotateTimer) return;
  clearInterval(rotateTimer);
  rotateTimer = null;
}

function startRotateTimer() {
  stopRotateTimer();
  rotateTimer = setInterval(() => {
    runLogRetention().catch(() => {});
  }, LOG_ROTATE_CHECK_MS);
  if (rotateTimer.unref) rotateTimer.unref();
}

function sendSubscriptions() {
  for (const coin of SYMBOLS) {
    for (const type of SUB_TYPES) {
      const payload = { method: 'subscribe', subscription: { type, coin } };
      ws.send(JSON.stringify(payload));
    }
  }
}

function connect() {
  if (stopped) return;
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    wsConnected = true;
    lastMessageAt = Date.now();
    log(`connected ${WS_URL}`);
    sendSubscriptions();
    startHeartbeat();
    writeHeartbeat('running').catch(() => {});
  });

  ws.on('message', (raw) => {
    lastMessageAt = Date.now();
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    try {
      const message = JSON.parse(text);
      enqueue(JSON.stringify({
        ts: Date.now(),
        source: 'hl_ws',
        message
      }));
    } catch (_) {
      // upstream malformed payload is ignored
    }
  });

  ws.on('error', (err) => {
    console.error('[ws_collector] ws error', err?.message ?? err);
    try { ws.close(); } catch (_) {}
  });

  ws.on('close', () => {
    wsConnected = false;
    stopHeartbeat();
    if (!stopped) log('closed, scheduling reconnect');
    writeHeartbeat('degraded').catch(() => {});
    scheduleReconnect();
  });
}

async function shutdown() {
  stopped = true;
  wsConnected = false;
  stopHeartbeat();
  stopStatusFlush();
  stopRotateTimer();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try { ws?.close(); } catch (_) {}
  await flush();
  await writeHeartbeat('stopped').catch(() => {});
}

process.on('SIGINT', async () => {
  await sendDiscord('warn', 'collector stopping (SIGINT)').catch(() => {});
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await sendDiscord('warn', 'collector stopping (SIGTERM)').catch(() => {});
  await shutdown();
  process.exit(0);
});

await ensureOutput();
await writeHeartbeat('starting').catch(() => {});
log(`sharedFeed=${SHARED_FEED_FILE}`);
log(`logDir=${LOG_DIR} rawPattern=${RAW_PREFIX}YYYYMMDD.jsonl`);
log(`symbols=${SYMBOLS.join(',')} subTypes=${SUB_TYPES.join(',')}`);
startStatusFlush();
startRotateTimer();
await runLogRetention().catch(() => {});
await sendDiscord('info', 'collector started', {
  sharedFeed: SHARED_FEED_FILE,
  logDir: LOG_DIR,
  symbols: SYMBOLS.join(','),
  subTypes: SUB_TYPES.join(',')
}).catch((err) => {
  console.error('[ws_collector] startup notify failed', err?.message ?? err);
});
connect();
