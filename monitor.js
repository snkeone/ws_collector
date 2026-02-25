#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { sendDiscord } from './notify.js';

const HEARTBEAT_FILE = path.resolve(process.env.WS_COLLECTOR_HEARTBEAT_FILE || '/tmp/ws_collector_heartbeat.json');
const STATE_FILE = path.resolve(process.env.WS_COLLECTOR_MONITOR_STATE_FILE || '/tmp/ws_collector_monitor_state.json');
const CHECK_MS = Math.max(1000, Number(process.env.WS_COLLECTOR_MONITOR_CHECK_MS || 10000));
const STALE_MS = Math.max(5000, Number(process.env.WS_COLLECTOR_MONITOR_STALE_MS || 60000));
const DOWN_REPORT_MS = Math.max(60000, Number(process.env.WS_COLLECTOR_MONITOR_DOWN_REPORT_MS || 1800000));

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

function isPidAlive(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function probe() {
  const hb = readJson(HEARTBEAT_FILE, null);
  const now = Date.now();
  if (!hb) {
    return { up: false, reason: 'heartbeat_missing', hb: null, now };
  }
  const hbTs = Number(hb.ts);
  const pid = Number(hb.pid);
  if (!Number.isFinite(hbTs) || now - hbTs > STALE_MS) {
    return { up: false, reason: 'heartbeat_stale', hb, now };
  }
  if (!isPidAlive(pid)) {
    return { up: false, reason: 'pid_dead', hb, now };
  }
  return { up: true, reason: 'ok', hb, now };
}

async function main() {
  const initial = {
    status: 'unknown',
    downSince: null,
    lastDownReportAt: 0,
    lastPid: null,
    lastUpAt: null
  };
  let state = readJson(STATE_FILE, initial) || initial;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  setInterval(async () => {
    const p = probe();
    const now = p.now;
    const pid = p.hb?.pid ?? null;

    const wasUp = state.status === 'up';
    const isUp = p.up;

    if (isUp && !wasUp) {
      const downtimeMs = state.downSince ? (now - Number(state.downSince)) : 0;
      state.status = 'up';
      state.lastUpAt = now;
      state.lastPid = pid;
      state.downSince = null;
      state.lastDownReportAt = 0;
      writeJson(STATE_FILE, state);
      await sendDiscord('info', 'collector recovered', {
        pid,
        downtime: fmtMs(downtimeMs),
        heartbeatFile: HEARTBEAT_FILE
      }).catch(() => {});
      return;
    }

    if (!isUp && wasUp) {
      state.status = 'down';
      state.downSince = now;
      state.lastDownReportAt = now;
      writeJson(STATE_FILE, state);
      await sendDiscord('error', 'collector down detected', {
        reason: p.reason,
        lastPid: state.lastPid ?? 'unknown',
        heartbeatFile: HEARTBEAT_FILE
      }).catch(() => {});
      return;
    }

    if (!isUp && state.status !== 'down') {
      state.status = 'down';
      state.downSince = state.downSince || now;
      state.lastDownReportAt = state.lastDownReportAt || now;
      writeJson(STATE_FILE, state);
      return;
    }

    if (isUp && wasUp) {
      if (state.lastPid && pid && Number(state.lastPid) !== Number(pid)) {
        const oldPid = state.lastPid;
        state.lastPid = pid;
        state.lastUpAt = now;
        writeJson(STATE_FILE, state);
        await sendDiscord('warn', 'collector restart detected', {
          oldPid,
          newPid: pid
        }).catch(() => {});
        return;
      }
      state.lastPid = pid;
      state.lastUpAt = now;
      writeJson(STATE_FILE, state);
      return;
    }

    if (!isUp && state.status === 'down' && state.downSince) {
      if (now - Number(state.lastDownReportAt || 0) >= DOWN_REPORT_MS) {
        state.lastDownReportAt = now;
        writeJson(STATE_FILE, state);
        await sendDiscord('error', 'collector still down', {
          reason: p.reason,
          downtime: fmtMs(now - Number(state.downSince))
        }).catch(() => {});
      }
    }
  }, CHECK_MS);

  console.log('[ws_collector_monitor] started');
}

main().catch((err) => {
  console.error('[ws_collector_monitor] fatal', err?.message ?? err);
  process.exit(1);
});
