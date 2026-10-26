import { describe, expect, test, afterAll } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os') as typeof os;
  const nodePath = jest.requireActual('node:path') as typeof path;
  return {
    ...actual,
    homedir: () => nodePath.join(actual.tmpdir(), `browserpaw-registry-test-${process.pid}`),
  };
});

import {
  entryFileName,
  writeBridgeRegistryEntry,
  removeBridgeRegistryEntry,
  readBridgeRegistryEntries,
  REGISTRY_DIR,
  BridgeRegistryEntry,
} from './bridge-registry';

let seq = 0;
/**
 * Each test uses its own fresh directory. (The sandbox overlay FS has a
 * systematic rm-rf ENOTEMPTY race on directories with multiple entries, so
 * tests avoid removing a shared directory mid-run.)
 */
async function freshDir(): Promise<string> {
  const dir = path.join(REGISTRY_DIR, `t-${process.pid}-${++seq}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function bestEffortRm(dir: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const mkEntry = (overrides: Partial<BridgeRegistryEntry> = {}): BridgeRegistryEntry => ({
  port: 12307,
  token: 'bpw_test_token_value_0000000000000000',
  origin: 'chrome-extension://abcdefghijklmnopqrstuvwxyz012345/',
  instanceName: 'test-instance',
  pid: process.pid,
  startedAt: Date.now(),
  ...overrides,
});

function getDeadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 30)'], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid!));
  });
}

describe('bridge registry', () => {
  afterAll(async () => {
    await bestEffortRm(REGISTRY_DIR);
  });

  test('entryFileName slugs the instance name', () => {
    expect(entryFileName('chrome-extension://abc/', 'work account')).toBe('work-account.json');
    expect(entryFileName(null, 'My  Work!')).toBe('my-work.json');
  });

  test('entryFileName falls back to a hash of the origin', () => {
    expect(entryFileName('chrome-extension://xyz/', null)).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(entryFileName(null, '!!!')).toMatch(/^[0-9a-f]{16}\.json$/);
    // Same origin → same file name; different origin → different file name
    expect(entryFileName('chrome-extension://a/', null)).toBe(
      entryFileName('chrome-extension://a/', null),
    );
    expect(entryFileName('chrome-extension://a/', null)).not.toBe(
      entryFileName('chrome-extension://b/', null),
    );
  });

  test('write + read round-trip', async () => {
    const dir = await freshDir();
    const entry = mkEntry({ port: 12310, instanceName: 'roundtrip' });
    await writeBridgeRegistryEntry(entry, dir);
    const entries = await readBridgeRegistryEntries(dir);
    const found = entries.find((e) => e.instanceName === 'roundtrip');
    expect(found).toBeDefined();
    expect(found!.port).toBe(12310);
    expect(found!.token).toBe(entry.token);
  });

  test('live entries are kept, stale entries (dead pid) are pruned', async () => {
    const dir = await freshDir();
    const deadPid = await getDeadPid();
    await writeBridgeRegistryEntry(mkEntry({ instanceName: 'live-one', pid: process.pid }), dir);
    await writeBridgeRegistryEntry(mkEntry({ instanceName: 'stale-one', pid: deadPid }), dir);
    const entries = await readBridgeRegistryEntries(dir);
    expect(entries.some((e) => e.instanceName === 'live-one')).toBe(true);
    expect(entries.some((e) => e.instanceName === 'stale-one')).toBe(false);
    // The stale file was removed from disk
    const dirFiles = await fs.promises.readdir(dir);
    expect(dirFiles).not.toContain('stale-one.json');
  });

  test('corrupt entries are ignored, missing dir returns empty', async () => {
    const dir = await freshDir();
    await fs.promises.writeFile(path.join(dir, 'corrupt.json'), '{not json', { mode: 0o600 });
    await writeBridgeRegistryEntry(mkEntry({ instanceName: 'good-one' }), dir);
    const entries = await readBridgeRegistryEntries(dir);
    expect(entries.some((e) => e.instanceName === 'good-one')).toBe(true);
    expect(entries.every((e) => e.instanceName !== 'corrupt')).toBe(true);
    expect(await readBridgeRegistryEntries(path.join(REGISTRY_DIR, 'never-created'))).toEqual([]);
  });

  test('removeBridgeRegistryEntry removes only its own entry', async () => {
    const dir = await freshDir();
    await writeBridgeRegistryEntry(mkEntry({ instanceName: 'keep-me' }), dir);
    await writeBridgeRegistryEntry(mkEntry({ instanceName: 'drop-me' }), dir);
    await removeBridgeRegistryEntry(mkEntry().origin, 'drop-me', dir);
    await removeBridgeRegistryEntry(null, 'never-existed', dir); // no throw on ENOENT
    const entries = await readBridgeRegistryEntries(dir);
    const names = entries.map((e) => e.instanceName);
    expect(names).toContain('keep-me');
    expect(names).not.toContain('drop-me');
  });
});
