import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os') as typeof os;
  const nodePath = jest.requireActual('node:path') as typeof path;
  return {
    ...actual,
    homedir: () => nodePath.join(actual.tmpdir(), `browserpaw-multi-instance-test-${process.pid}`),
  };
});

import { NativeMessageType } from 'chrome-mcp-shared';
import { Server } from './index';
import { NativeMessagingHost } from '../native-messaging-host';
import { readBridgeRegistryEntries, REGISTRY_DIR } from './bridge-registry';

/**
 * Multi-instance behavior:
 * - A bridge whose requested port is held by another bridge (and whose port
 *   is not env-pinned at process start) scans upward for the next free port
 *   and reports it in SERVER_STARTED, publishing a registry entry.
 * - An env-pinned bridge fails loudly instead of scanning.
 */
describe('multi-instance port negotiation', () => {
  let serverA: Server;
  let hostA: NativeMessagingHost;
  const base = 20000 + Math.floor(Math.random() * 20000);

  beforeAll(async () => {
    serverA = new Server();
    hostA = new NativeMessagingHost();
    hostA.setServer(serverA);
    await serverA.start(base, hostA);
  });

  afterAll(async () => {
    if (serverA?.isRunning) {
      try {
        await serverA.stop();
      } catch {}
    }
    // Best-effort: the sandbox overlay FS can fail bulk rm with ENOTEMPTY
    for (let i = 0; i < 3; i++) {
      try {
        await fs.promises.rm(REGISTRY_DIR, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  test('scans to the next free port when the requested port is held', async () => {
    const serverB = new Server();
    const hostB = new NativeMessagingHost();
    hostB.setServer(serverB);
    hostB.extensionOrigin = 'chrome-extension://second-instance-origin000/';
    hostB.extensionInstanceName = 'second-instance';

    const messages: any[] = [];
    jest.spyOn(hostB, 'sendMessage').mockImplementation((m: any) => {
      messages.push(m);
    });

    await (hostB as any).startServer(base);

    const started = messages.find((m) => m.type === NativeMessageType.SERVER_STARTED);
    expect(started).toBeDefined();
    const boundPort: number = started.payload.port;
    expect(boundPort).toBeGreaterThan(base);
    expect(boundPort).toBeLessThanOrEqual(base + 10);

    // Registry entry published for the new port
    const entries = await readBridgeRegistryEntries();
    const entry = entries.find((e) => e.instanceName === 'second-instance');
    expect(entry).toBeDefined();
    expect(entry!.port).toBe(boundPort);
    expect(entry!.origin).toBe('chrome-extension://second-instance-origin000/');

    try {
      await serverB.stop();
    } catch {}
  });

  test('env-pinned port fails loudly instead of scanning', async () => {
    // Re-require the host module in a fresh registry with CHROME_MCP_PORT
    // set, so the pin is captured at "process start" (module load) time.
    const prevPort = process.env.CHROME_MCP_PORT;
    const prevHttp = process.env.MCP_HTTP_PORT;
    process.env.CHROME_MCP_PORT = String(base);
    let NativeMessagingHostPinned: any;
    jest.isolateModules(() => {
      NativeMessagingHostPinned = require('../native-messaging-host').NativeMessagingHost;
    });
    try {
      const serverC = new Server();
      const hostC: any = new NativeMessagingHostPinned();
      hostC.setServer(serverC);

      const messages: any[] = [];
      jest.spyOn(hostC, 'sendMessage').mockImplementation((m: any) => {
        messages.push(m);
      });

      await hostC.startServer(base);

      expect(serverC.isRunning).toBe(false);
      const error = messages.find((m) => m.type === NativeMessageType.ERROR_FROM_NATIVE_HOST);
      expect(error).toBeDefined();
      expect(String(error.payload.message)).toMatch(/Failed to start server/);
    } finally {
      if (prevPort === undefined) delete process.env.CHROME_MCP_PORT;
      else process.env.CHROME_MCP_PORT = prevPort;
      if (prevHttp === undefined) delete process.env.MCP_HTTP_PORT;
      else process.env.MCP_HTTP_PORT = prevHttp;
    }
  });
});
