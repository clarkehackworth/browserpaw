/**
 * Bridge ownership checks for multi-instance setups.
 *
 * Each bridge (native host + loopback HTTP server) belongs to exactly one
 * extension instance. When this instance finds a bridge already running on
 * its preferred port (the EADDRINUSE self-heal path), it must verify that
 * the bridge is actually its own before attaching — otherwise a second
 * browser instance would silently attach to the first instance's bridge and
 * never be controllable on its own.
 *
 * Identity is (instanceName, origin):
 * - `instanceName` is the per-profile name stored in chrome.storage.local
 *   (STORAGE_KEYS.INSTANCE_NAME). It is the primary discriminator because
 *   several instances loaded from the same unpacked path share one
 *   extension ID/origin.
 * - `origin` is the extension origin (chrome.runtime.getURL('/')), reported
 *   by the bridge from the START handshake.
 * - Bridges started manually (standalone, no extension) carry no identity
 *   at all — those keep the legacy attach behavior.
 */

export interface BridgeIdentity {
  /** Extension origin the bridge was started from, e.g. chrome-extension://abc…/ */
  origin?: string;
  /** Per-profile instance name, if the starting instance had one set. */
  instanceName?: string;
}

export type OwnershipVerdict = 'own' | 'foreign' | 'ambiguous';

/** Normalize an extension origin for comparison (case, trailing slash). */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '').toLowerCase();
}

/**
 * Decide whether the probed bridge belongs to this extension instance.
 *
 * - Probed bridge has an instance name → `own` only on exact match.
 * - Probed bridge has only an origin → same origin is `ambiguous` (several
 *   same-path instances share an ID; legacy attach with a warning), a
 *   different origin is `foreign`.
 * - Probed bridge has no identity (manual/legacy bridge) → `ambiguous`
 *   (legacy attach, unchanged behavior).
 */
export function checkBridgeOwnership(
  probed: BridgeIdentity,
  ownOrigin: string,
  ownInstanceName?: string,
): OwnershipVerdict {
  if (typeof probed.instanceName === 'string' && probed.instanceName.length > 0) {
    return probed.instanceName === (ownInstanceName || '') ? 'own' : 'foreign';
  }
  if (typeof probed.origin === 'string' && probed.origin.length > 0) {
    return normalizeOrigin(probed.origin) === normalizeOrigin(ownOrigin) ? 'ambiguous' : 'foreign';
  }
  return 'ambiguous';
}
