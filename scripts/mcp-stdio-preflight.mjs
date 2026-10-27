#!/usr/bin/env node
/**
 * mcp-stdio-preflight.mjs — transparent stdio wrapper in front of the BrowserPaw
 * stdio shim that first ensures the remote-bridge SSH tunnels exist.
 *
 * Usage:
 *   node scripts/mcp-stdio-preflight.mjs <shim-script> [shim args...]
 *
 * Without BROWSERPAW_TUNNEL_TARGET set this is a pure passthrough — single-
 * machine installs are unaffected. With it set, the wrapper runs
 * ensure-tunnel.mjs logic for BROWSERPAW_TUNNEL_PORTS (default "12306")
 * against the target, then spawns the shim with inherited stdio and forwards
 * its exit code.
 *
 * All logging goes to stderr so the MCP stdio channel (stdout) stays clean.
 *
 * Environment:
 *   BROWSERPAW_TUNNEL_TARGET   user@host to forward through (enables preflight)
 *   BROWSERPAW_TUNNEL_PORTS    comma-separated bridge ports (default "12306")
 *   BROWSERPAW_TUNNEL_KEY      ssh identity file (optional)
 *   BROWSERPAW_TUNNEL_WAIT_MS  max ms to wait for a fresh forward (default 8000)
 *
 * Note: the bridge is on-demand (Chrome spawns it), so "tunnel up but bridge
 * not answering" is only a warning here — the shim is still launched and calls
 * succeed as soon as the remote browser/bridge comes up.
 */
import { spawn } from 'node:child_process';
import { ensureTunnels } from './ensure-tunnel.mjs';

const [shim, ...shimArgs] = process.argv.slice(2);
if (!shim) {
  console.error('usage: mcp-stdio-preflight.mjs <shim-script> [shim args...]');
  process.exit(2);
}
const log = (message) => console.error(`[browserpaw-preflight] ${message}`);
const target = process.env.BROWSERPAW_TUNNEL_TARGET;
if (target) {
  const ports = (process.env.BROWSERPAW_TUNNEL_PORTS || '12306')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const code = await ensureTunnels(
    target,
    ports,
    {
      key: process.env.BROWSERPAW_TUNNEL_KEY || null,
      probeTimeout: 1500,
      wait: Number(process.env.BROWSERPAW_TUNNEL_WAIT_MS || 8000),
    },
    { log },
  );
  log(
    code === 0
      ? 'tunnels ready'
      : `tunnels degraded (code ${code}); continuing — the on-demand bridge may come up later`,
  );
}
const child = spawn(process.execPath, [shim, ...shimArgs], { stdio: 'inherit' });
child.on('error', (err) => {
  log(`failed to start shim: ${err.message}`);
  process.exit(2);
});
child.on('exit', (exitCode, signal) => {
  process.exit(signal ? 1 : exitCode ?? 0);
});
