#!/usr/bin/env node
/**
 * ensure-tunnel.mjs — idempotent SSH loopback-forward bootstrap for remote bridges.
 *
 * The BrowserPaw stdio shim only ever talks to 127.0.0.1 (by design: token +
 * loopback is what keeps local web pages from controlling the browser). When
 * the Native Bridge runs on another machine — the machine with Chrome + the
 * extension — that machine's bridge loopback ports must therefore be forwarded
 * into THIS machine's loopback. This script ensures one forward per bridge
 * port and reports exactly which state each port is in.
 *
 * Port states (why three, not two):
 *   bridge-up      the bridge answers HTTP /ping through the forward
 *   forward-only   a local forward exists, but the remote port is closed —
 *                  ssh's local listener accepts the TCP connection and then
 *                  resets it, so a bare TCP probe would report "reachable"
 *                  for a dead bridge
 *   no-forward     nothing listens on the local port (no tunnel yet)
 *
 * Usage:
 *   node scripts/ensure-tunnel.mjs <user@host> <port...> [options]
 *
 * Options:
 *   --key <path>            ssh identity file (adds -i)
 *   --ssh-opt <opt>         extra ssh -o option (repeatable)
 *   --connect-timeout <s>   ssh ConnectTimeout seconds (default 5)
 *   --probe-timeout <ms>    local probe timeout per check (default 2500)
 *   --wait <ms>             max ms to wait after starting a forward (default 8000)
 *   --dry-run               probe and report only; start nothing
 *
 * Exit codes:
 *   0  every requested port answers /ping
 *   1  at least one port: forward present (or started) but the bridge is not
 *      answering (e.g. the remote browser is not open yet)
 *   2  hard failure: ssh refused / forward could not be established / bad args
 *
 * The script is idempotent: ports that already answer /ping are left alone;
 * forwards are only started for ports with no local listener. /ping requires
 * no token, so the script never touches credentials — the ssh identity comes
 * from --key or the caller's normal ssh config/agent.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Probe a local port with a raw TCP connect.
 * true if 127.0.0.1:<port> accepts a connection (a listener exists — may be an
 * ssh forward whose remote end is closed); false on refuse/timeout.
 */
export function probePort(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

/** GET 127.0.0.1:<port>/ping (no auth). Resolves {status} or {error}. */
export function httpPing(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.once('timeout', () => req.destroy(new Error('ping timeout')));
    req.once('error', (err) => resolve({ error: err.message }));
  });
}

/**
 * Classify a port: 'bridge-up' | 'forward-only' | 'no-forward'.
 * See the header comment for why the TCP layer alone is not enough.
 */
export async function probeBridge(port, timeoutMs = 2500) {
  if (!(await probePort(port, timeoutMs))) return 'no-forward';
  const ping = await httpPing(port, timeoutMs);
  return ping.status ? 'bridge-up' : 'forward-only';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_OPTS = {
  key: null,
  sshOpts: [],
  connectTimeout: 5,
  probeTimeout: 2500,
  wait: 8000,
  dryRun: false,
};

/** Parse CLI arguments. Throws on malformed input (exit code 2 by the caller). */
export function parseArgs(argv) {
  const ports = [];
  const opts = { ...DEFAULT_OPTS };
  let target = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--key') opts.key = argv[(i += 1)];
    else if (arg === '--ssh-opt') opts.sshOpts.push(argv[(i += 1)]);
    else if (arg === '--connect-timeout') opts.connectTimeout = Number(argv[(i += 1)]);
    else if (arg === '--probe-timeout') opts.probeTimeout = Number(argv[(i += 1)]);
    else if (arg === '--wait') opts.wait = Number(argv[(i += 1)]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else if (!target && arg.includes('@')) target = arg;
    else if (/^\d{1,5}$/.test(arg)) ports.push(Number(arg));
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!target) throw new Error('usage: ensure-tunnel.mjs <user@host> <port...> [options]');
  if (ports.length === 0) throw new Error('at least one port is required');
  for (const port of ports) {
    if (port < 1 || port > 65535) throw new Error(`port out of range: ${port}`);
  }
  return { target, ports, opts };
}

/** Start `ssh -N -f -L <port>:127.0.0.1:<port> <target>`. */
function startForward({ target, port, opts }) {
  const args = [
    '-N',
    '-f',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ConnectTimeout=${opts.connectTimeout}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];
  for (const extra of opts.sshOpts) args.push('-o', extra);
  if (opts.key) args.push('-i', opts.key);
  args.push(`-L ${port}:127.0.0.1:${port}`, target);
  try {
    execFileSync('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.connectTimeout * 1000 + 2000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message || '').trim() };
  }
}

/**
 * Ensure a local forward exists (and the remote bridge answers /ping) for
 * every port. Callers may pass a partial opts object.
 * Returns the worst exit code across ports (0 = all good, 1 = degraded, 2 = hard failure).
 */
export async function ensureTunnels(target, ports, opts = {}, { log = console.log } = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  let worst = 0;
  for (const port of ports) {
    const state = await probeBridge(port, o.probeTimeout);
    if (state === 'bridge-up') {
      log(`port ${port}: ok (bridge answering)`);
      continue;
    }
    if (o.dryRun) {
      log(`port ${port}: not usable (state: ${state}; dry run, nothing started)`);
      worst = Math.max(worst, 1);
      continue;
    }
    if (state === 'forward-only') {
      log(`port ${port}: tunnel present but bridge not responding (check the remote browser/bridge)`);
      worst = Math.max(worst, 1);
      continue;
    }
    // no-forward: start one.
    const started = startForward({ target, port, opts: o });
    if (!started.ok) {
      const lastLine = started.detail.split('\n').pop();
      log(`port ${port}: FAILED to start tunnel: ${lastLine}`);
      worst = Math.max(worst, 2);
      continue;
    }
    const deadline = Date.now() + o.wait;
    let finalState = 'no-forward';
    while (Date.now() < deadline) {
      finalState = await probeBridge(port, 500);
      if (finalState === 'bridge-up') break;
      await sleep(250);
    }
    if (finalState === 'bridge-up') {
      log(`port ${port}: tunnel started, bridge reachable`);
    } else if (finalState === 'forward-only') {
      log(`port ${port}: tunnel started, bridge not responding yet (is the browser open on the remote?)`);
      worst = Math.max(worst, 1);
    } else {
      log(`port ${port}: tunnel start reported success but no local listener appeared (ssh may have died)`);
      worst = Math.max(worst, 2);
    }
  }
  return worst;
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  let code = 0;
  try {
    const { target, ports, opts } = parseArgs(process.argv.slice(2));
    code = await ensureTunnels(target, ports, opts);
  } catch (err) {
    console.error(`ensure-tunnel: ${err.message}`);
    code = 2;
  }
  process.exit(code);
}
