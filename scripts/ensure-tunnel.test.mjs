import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseArgs, probePort, probeBridge, ensureTunnels } from './ensure-tunnel.mjs';

test('parseArgs: target + ports', () => {
  const r = parseArgs(['jeff@example.lan', '12306', '12307']);
  assert.equal(r.target, 'jeff@example.lan');
  assert.deepEqual(r.ports, [12306, 12307]);
});

test('parseArgs: options', () => {
  const r = parseArgs(['u@h', '12306', '--key', '/tmp/k', '--ssh-opt', 'ProxyCommand=x', '--dry-run']);
  assert.equal(r.opts.key, '/tmp/k');
  assert.deepEqual(r.opts.sshOpts, ['ProxyCommand=x']);
  assert.equal(r.opts.dryRun, true);
});

test('parseArgs: rejects missing ports', () => {
  assert.throws(() => parseArgs(['u@h']), /port/);
});

test('parseArgs: rejects out-of-range port', () => {
  assert.throws(() => parseArgs(['u@h', '70000']), /range/);
});

test('probePort: closed port resolves false', async () => {
  assert.equal(await probePort(1, 300), false);
});

test('probePort: open ephemeral server resolves true', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await probePort(port, 1000), true);
  await new Promise((resolve) => server.close(resolve));
});

test('probeBridge: no listener -> no-forward', async () => {
  assert.equal(await probeBridge(1, 400), 'no-forward');
});

test('probeBridge: TCP accept + immediate reset -> forward-only', async () => {
  // Mimics an ssh -L forward whose remote end is closed: the local listener
  // accepts, then the connection dies without an HTTP response.
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await probeBridge(port, 800), 'forward-only');
  await new Promise((resolve) => server.close(resolve));
});

test('probeBridge: HTTP /ping 200 -> bridge-up', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await probeBridge(port, 800), 'bridge-up');
  await new Promise((resolve) => server.close(resolve));
});

test('ensureTunnels: partial opts (programmatic use) degrades cleanly', async () => {
  const lines = [];
  // Port 1 is closed on loopback; dry-run with a partial opts object must not
  // throw and must report the degraded state.
  const code = await ensureTunnels('nobody@invalid.host', [1], { dryRun: true, probeTimeout: 200 }, { log: (m) => lines.push(m) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /not usable \(state: no-forward/);
});
