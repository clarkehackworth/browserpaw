import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os') as typeof os;
  const nodePath = jest.requireActual('node:path') as typeof path;
  return {
    ...actual,
    homedir: () => nodePath.join(actual.tmpdir(), `browserpaw-discovery-test-${process.pid}`),
  };
});

import {
  probeBridgeInstanceName,
  discoverBridgePortForInstance,
  resolveTargetUrl,
} from './mcp-server-stdio';
import { BridgeSelectionError } from '../server/bridge-registry';

/**
 * Identity-based bridge discovery: the shim probes the 12306..12316 range
 * and attaches to the bridge whose /ping reports the requested instance
 * name. This is what makes cross-machine multi-instance work (the registry
 * is local to each machine; the port range is shared).
 */
describe('instance discovery', () => {
  const servers: http.Server[] = [];
  const stopAll = async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  };

  const startFakeBridge = (port: number, body: object | string): Promise<number> =>
    new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      });
      servers.push(srv);
      srv.listen(port, '127.0.0.1', () => resolve(port));
    });

  beforeAll(() => {
    // Keep the ladder's earlier steps out of the way
    delete process.env.MCP_SERVER_URL;
    delete process.env.CHROME_MCP_PORT;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.BROWSERPAW_INSTANCE;
  });

  afterAll(async () => {
    await stopAll();
    delete process.env.BROWSERPAW_INSTANCE;
  });

  test('probeBridgeInstanceName reads /ping identity, null on absence/failure', async () => {
    const p1 = await startFakeBridge(12991, {
      status: 'ok',
      message: 'pong',
      bridgeInstanceName: 'work',
    });
    const p2 = await startFakeBridge(12992, { status: 'ok', message: 'pong' });
    const p3 = await startFakeBridge(12993, '{not json');
    expect(await probeBridgeInstanceName(p1)).toBe('work');
    expect(await probeBridgeInstanceName(p2)).toBeNull();
    expect(await probeBridgeInstanceName(p3)).toBeNull();
    expect(await probeBridgeInstanceName(12999, 250)).toBeNull(); // nothing listening
    await stopAll();
  });

  test('discoverBridgePortForInstance finds the right bridge in the range', async () => {
    await startFakeBridge(12307, { status: 'ok', bridgeInstanceName: 'work' });
    await startFakeBridge(12309, { status: 'ok', bridgeInstanceName: 'personal' });
    try {
      expect(await discoverBridgePortForInstance('work')).toBe(12307);
      expect(await discoverBridgePortForInstance('personal')).toBe(12309);
      expect(await discoverBridgePortForInstance('does-not-exist')).toBeNull();
    } finally {
      await stopAll();
    }
  });

  test('resolveTargetUrl: named instance resolves via identity probe', async () => {
    await startFakeBridge(12308, { status: 'ok', bridgeInstanceName: 'work' });
    try {
      process.env.BROWSERPAW_INSTANCE = 'work';
      expect(await resolveTargetUrl()).toBe('http://127.0.0.1:12308/mcp');
    } finally {
      await stopAll();
      delete process.env.BROWSERPAW_INSTANCE;
    }
  });

  test('resolveTargetUrl: named instance with no matching bridge fails loudly', async () => {
    // A foreign bridge in the range must NOT satisfy the request. (Port
    // 12306 is avoided: in this sandbox the SSH tunnel already holds it.)
    await startFakeBridge(12307, { status: 'ok', bridgeInstanceName: 'someone-else' });
    try {
      process.env.BROWSERPAW_INSTANCE = 'my-instance';
      await expect(resolveTargetUrl()).rejects.toThrow(BridgeSelectionError);
      await expect(resolveTargetUrl()).rejects.toThrow(
        /No bridge found for instance "my-instance"/,
      );
    } finally {
      await stopAll();
      delete process.env.BROWSERPAW_INSTANCE;
    }
  });

  test('resolveTargetUrl: explicit env still wins over discovery', async () => {
    process.env.BROWSERPAW_INSTANCE = 'work';
    process.env.CHROME_MCP_PORT = '12400';
    try {
      expect(await resolveTargetUrl()).toBe('http://127.0.0.1:12400/mcp');
    } finally {
      delete process.env.BROWSERPAW_INSTANCE;
      delete process.env.CHROME_MCP_PORT;
    }
  });
});
