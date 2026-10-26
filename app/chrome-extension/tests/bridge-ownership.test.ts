/**
 * Bridge ownership verification for multi-instance setups.
 *
 * When an extension instance finds a bridge already running on its preferred
 * port (EADDRINUSE self-heal path), it must only attach when the bridge is
 * its own — otherwise it would silently drive a different browser profile.
 */
import { describe, it, expect } from 'vitest';
import { checkBridgeOwnership } from '../common/bridge-ownership';

const ORIGIN_A = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const ORIGIN_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/';

describe('checkBridgeOwnership', () => {
  it('accepts a bridge whose instance name matches (own)', () => {
    expect(checkBridgeOwnership({ origin: ORIGIN_A, instanceName: 'work' }, ORIGIN_A, 'work')).toBe(
      'own',
    );
  });

  it('rejects a bridge with a different instance name (foreign)', () => {
    expect(
      checkBridgeOwnership({ origin: ORIGIN_A, instanceName: 'work' }, ORIGIN_A, 'personal'),
    ).toBe('foreign');
  });

  it('rejects a named bridge when this instance has no name (foreign)', () => {
    expect(checkBridgeOwnership({ origin: ORIGIN_A, instanceName: 'work' }, ORIGIN_A)).toBe(
      'foreign',
    );
  });

  it('treats an unnamed same-origin bridge as ambiguous (legacy attach)', () => {
    expect(checkBridgeOwnership({ origin: ORIGIN_A }, ORIGIN_A)).toBe('ambiguous');
    expect(
      checkBridgeOwnership({ origin: ORIGIN_A, instanceName: undefined }, ORIGIN_A, 'work'),
    ).toBe('ambiguous');
  });

  it('rejects a bridge from a different extension origin (foreign)', () => {
    expect(checkBridgeOwnership({ origin: ORIGIN_B }, ORIGIN_A)).toBe('foreign');
  });

  it('normalizes origin case and trailing slashes', () => {
    expect(
      checkBridgeOwnership({ origin: ORIGIN_A.toUpperCase().replace(/\/$/, '') }, ORIGIN_A),
    ).toBe('ambiguous');
  });

  it('treats a bridge with no identity (manual/legacy) as ambiguous', () => {
    expect(checkBridgeOwnership({}, ORIGIN_A, 'work')).toBe('ambiguous');
    expect(checkBridgeOwnership({ origin: '', instanceName: '' }, ORIGIN_A)).toBe('ambiguous');
  });
});
