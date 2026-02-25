#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { sendDiscord } from './notify.js';

const HEARTBEAT_FILE = path.resolve(process.env.WS_COLLECTOR_HEARTBEAT_FILE || '/tmp/ws_collector_heartbeat.json');
const STATE_FILE = path.resolve(process.env.WS_COLLECTOR_MONITOR_STATE_FILE || '/tmp/ws_collector_monitor_state.json');
const CHECK_MS = Math.max(1000, Number(process.env.WS_COLLECTOR_MONITOR_CHECK_MS || 10000));
const STALE_MS = Math.max(5000, Number(process.env.WS_COLLECTOR_MONITOR_STALE_MS || 60000));
const DOWN_REPORT_MS = Math.max(60000, Number(process.env.WS_COLLECTOR_MONITOR_DOWN_REPORT_MS || 1800000));
const SUSPECT_REPORT_MS = Math.max(60000, Number(process.env.WS_COLLECTOR_MONITOR_SUSPECT_REPORT_MS || 300000));

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

function readJsonStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, data: null, error: err };
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

function probe(lastKnownPid = null) {
  const hbStatus = readJsonStatus(HEARTBEAT_FILE);
  const now = Date.now();
  if (!hbStatus.ok) {
    const code = hbStatus.error?.code || 'read_error';
    const pidAlive = isPidAlive(lastKnownPid);
    if (code === 'ENOENT' && !pidAlive) {
      return { health: 'down', reason: 'heartbeat_missing_pid_dead_or_unknown', hb: null, now, pidAlive, certainty: 'high' };
    }
    return { health: 'suspect', reason: code === 'ENOENT' ? 'heartbeat_missing_pid_alive' : `heartbeat_unreadable_${code}`, hb: null, now, pidAlive, certainty: 'low' };
  }
  const hb = hbStatus.data;
  const hbTs = Number(hb.ts);
  const pid = Number(hb.pid);
  const pidAlive = isPidAlive(pid);
  if (!Number.isFinite(hbTs) || now - hbTs > STALE_MS) {
    if (pidAlive) {
      return { health: 'suspect', reason: 'heartbeat_stale_pid_alive', hb, now, pidAlive, certainty: 'low' };
    }
    return { health: 'down', reason: 'heartbeat_stale_pid_dead', hb, now, pidAlive, certainty: 'high' };
  }
  if (!pidAlive) {
    return { health: 'down', reason: 'pid_dead', hb, now, pidAlive, certainty: 'high' };
  }
  return { health: 'up', reason: 'ok', hb, now, pidAlive, certainty: 'high' };
}

async function main() {
  const initial = {
    status: 'unknown',
    downSince: null,
    lastDownReportAt: 0,
    suspectSince: null,
    lastSuspectReportAt: 0,
    lastPid: null,
    lastUpAt: null
  };
  let state = readJson(STATE_FILE, initial) || initial;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  setInterval(async () => {
    const p = probe(state.lastPid);
    const now = p.now;
    const pid = p.hb?.pid ?? null;

    const wasUp = state.status === 'up';
    const wasDown = state.status === 'down';
    const wasSuspect = state.status === 'suspect';
    const isUp = p.health === 'up';
    const isDown = p.health === 'down';
    const isSuspect = p.health === 'suspect';

    if (isUp && !wasUp) {
      const downtimeMs = wasDown && state.downSince ? (now - Number(state.downSince)) : 0;
      const suspectMs = wasSuspect && state.suspectSince ? (now - Number(state.suspectSince)) : 0;
      state.status = 'up';
      state.lastUpAt = now;
      state.lastPid = pid;
      state.downSince = null;
      state.lastDownReportAt = 0;
      state.suspectSince = null;
      state.lastSuspectReportAt = 0;
      writeJson(STATE_FILE, state);
      if (wasDown) {
        await sendDiscord('info', 'collector recovered', {
          pid,
          downtime: fmtMs(downtimeMs),
          heartbeatFile: HEARTBEAT_FILE
        }).catch(() => {});
      } else {
        await sendDiscord('info', 'collector heartbeat recovered', {
          pid,
          suspectDuration: fmtMs(suspectMs),
          heartbeatFile: HEARTBEAT_FILE
        }).catch(() => {});
      }
      return;
    }

    if (isDown && !wasDown) {
      state.status = 'down';
      state.downSince = state.downSince || now;
      state.lastDownReportAt = now;
      state.suspectSince = null;
      state.lastSuspectReportAt = 0;
      if (pid) state.lastPid = pid;
      writeJson(STATE_FILE, state);
      await sendDiscord('error', 'collector down detected', {
        reason: p.reason,
        certainty: p.certainty,
        pidAlive: p.pidAlive,
        lastPid: state.lastPid ?? 'unknown',
        heartbeatFile: HEARTBEAT_FILE
      }).catch(() => {});
      return;
    }

    if (isSuspect && !wasDown && !wasSuspect) {
      state.status = 'suspect';
      state.suspectSince = now;
      state.lastSuspectReportAt = now;
      if (pid) state.lastPid = pid;
      writeJson(STATE_FILE, state);
      await sendDiscord('warn', 'collector health uncertain', {
        reason: p.reason,
        certainty: p.certainty,
        pidAlive: p.pidAlive,
        lastPid: state.lastPid ?? 'unknown',
        heartbeatFile: HEARTBEAT_FILE
      }).catch(() => {});
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

    if (isSuspect && wasSuspect) {
      if (now - Number(state.lastSuspectReportAt || 0) >= SUSPECT_REPORT_MS) {
        state.lastSuspectReportAt = now;
        if (pid) state.lastPid = pid;
        writeJson(STATE_FILE, state);
        await sendDiscord('warn', 'collector still uncertain', {
          reason: p.reason,
          certainty: p.certainty,
          uncertainFor: fmtMs(now - Number(state.suspectSince || now)),
          pidAlive: p.pidAlive,
          lastPid: state.lastPid ?? 'unknown',
          heartbeatFile: HEARTBEAT_FILE
        }).catch(() => {});
      }
      return;
    }

    if (isDown && state.status === 'down' && state.downSince) {
      if (now - Number(state.lastDownReportAt || 0) >= DOWN_REPORT_MS) {
        state.lastDownReportAt = now;
        if (pid) state.lastPid = pid;
        writeJson(STATE_FILE, state);
        await sendDiscord('error', 'collector still down', {
          reason: p.reason,
          certainty: p.certainty,
          pidAlive: p.pidAlive,
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
