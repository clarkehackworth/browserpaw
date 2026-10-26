/**
 * Bridge registry — local discovery of running bridges.
 *
 * Each bridge writes a small JSON entry under `~/.chrome-mcp/bridges/` when
 * it successfully binds its port, and removes it on clean shutdown. Local
 * MCP clients (`mcp-server-stdio`) read the registry to discover which
 * bridge to connect to, so multi-instance setups need zero port
 * configuration: name your instance, and clients pick it by name.
 *
 * Entries are keyed by instance name when the extension provided one
 * (human-readable file names), otherwise by a hash of the extension origin.
 * The registry is local-bridge only: remote/tunnel setups keep using
 * MCP_SERVER_URL / CHROME_MCP_PORT (explicit config always wins).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const REGISTRY_DIR = path.join(os.homedir(), '.chrome-mcp', 'bridges');

export interface BridgeRegistryEntry {
  port: number;
  token: string;
  origin: string | null;
  instanceName: string | null;
  pid: number;
  startedAt: number;
}

/** Raised when explicit instance selection cannot be resolved. */
export class BridgeSelectionError extends Error {}

/**
 * Registry file name for a bridge: human-readable instance-name slug when
 * available, otherwise a short hash of the extension origin.
 */
export function entryFileName(origin: string | null, instanceName: string | null): string {
  if (instanceName) {
    const slug = instanceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return `${slug}.json`;
  }
  const digest = crypto
    .createHash('sha256')
    .update(origin || 'unknown-origin')
    .digest('hex')
    .slice(0, 16);
  return `${digest}.json`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: process exists but is not signalable by us
    return err?.code === 'EPERM';
  }
}

/**
 * Write (or refresh) the registry entry for a running bridge.
 * File mode is 0600 — the entry contains the bridge token.
 */
export async function writeBridgeRegistryEntry(
  entry: BridgeRegistryEntry,
  dir: string = REGISTRY_DIR,
): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, entryFileName(entry.origin, entry.instanceName));
  await fs.promises.writeFile(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return file;
}

/** Remove a bridge's registry entry (clean shutdown / STOP). */
export async function removeBridgeRegistryEntry(
  origin: string | null,
  instanceName: string | null,
  dir: string = REGISTRY_DIR,
): Promise<void> {
  try {
    await fs.promises.unlink(path.join(dir, entryFileName(origin, instanceName)));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/**
 * Read all live registry entries, pruning stale ones (dead pids, i.e.
 * bridges that crashed without a clean shutdown).
 */
export async function readBridgeRegistryEntries(
  dir: string = REGISTRY_DIR,
): Promise<BridgeRegistryEntry[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const entries: BridgeRegistryEntry[] = [];
  const pendingUnlinks: Promise<unknown>[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    let entry: BridgeRegistryEntry;
    try {
      entry = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as BridgeRegistryEntry;
    } catch {
      continue; // Corrupt entry — leave it for manual cleanup
    }
    if (
      typeof entry.port !== 'number' ||
      !Number.isInteger(entry.port) ||
      entry.port <= 0 ||
      entry.port > 65535
    ) {
      continue;
    }
    if (typeof entry.pid === 'number' && !isProcessAlive(entry.pid)) {
      // Stale: the bridge process is gone — prune (tracked so callers see a
      // quiescent directory when this resolves)
      pendingUnlinks.push(fs.promises.unlink(filePath).catch(() => {}));
      continue;
    }
    entries.push(entry);
  }
  await Promise.all(pendingUnlinks);
  return entries.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}
