import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...a: any[]) => void;
const ev = () => {
  const ls: Listener[] = [];
  return {
    addListener: (f: Listener) => ls.push(f),
    fire: (...a: any[]) => ls.forEach((f) => f(...a)),
  };
};

function fakeChrome() {
  let dyn: any[] = [];
  const store: Record<string, any> = { local: {}, session: {} };
  const area = (k: string) => ({
    get: async (key: string) => ({ [key]: store[k][key] }),
    set: async (o: any) => Object.assign(store[k], o),
  });
  return {
    runtime: { id: 'selfid' },
    storage: { local: area('local'), session: area('session') },
    declarativeNetRequest: {
      getDynamicRules: async () => dyn,
      updateDynamicRules: async ({ removeRuleIds, addRules }: any) => {
        dyn = dyn.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
      isRegexSupported: async ({ regex }: any) =>
        /\(\?[=!<]/.test(regex)
          ? { isSupported: false, reason: 'syntaxError' }
          : { isSupported: true },
      onRuleMatchedDebug: ev(),
    },
    webRequest: { onBeforeRequest: ev() },
    webNavigation: { onBeforeNavigate: ev(), onCreatedNavigationTarget: ev() },
    tabs: { onCreated: ev(), onRemoved: ev(), onReplaced: ev(), update: vi.fn(async () => {}) },
    get dyn() {
      return dyn;
    },
  };
}

let c: ReturnType<typeof fakeChrome>;
let m: typeof import('../entrypoints/background/url-policy');

beforeEach(async () => {
  vi.resetModules();
  c = fakeChrome();
  vi.stubGlobal('chrome', c);
  m = await import('../entrypoints/background/url-policy');
  await m.initUrlPolicy();
});

const R = (
  id: number,
  action: 'block' | 'allow',
  kind: 'domain' | 'url' | 'regex',
  value: string,
) => ({ id, action, kind, value });

describe('browserVerdict', () => {
  const rules = [R(1, 'block', 'domain', 'evil.com'), R(2, 'allow', 'domain', 'ok.com')];
  const v = (u: string, top = true) => m.browserVerdict(u, rules, 'deny', top, 'selfid');
  it('applies rules to http(s) and ws(s), trailing dots included', () => {
    expect(v('https://x.ok.com/').allowedBy).toBe('domain: ok.com');
    expect(v('https://evil.com./').blocked).toBe('domain: evil.com');
    expect(v('wss://ok.com/s').allowedBy).toBe('domain: ok.com');
    expect(v('https://other.net/').blocked).toBe('default: deny');
  });
  it('blocks dangerous schemes and unwraps wrappers', () => {
    for (const u of [
      'file:///etc/passwd',
      'ftp://ok.com/',
      'ssh://host',
      'javascript:alert(1)',
      'chrome://settings/',
      'devtools://x',
      'vscode://file/x',
      'chrome-extension://other/x.html',
    ])
      expect(v(u).blocked, u).toBeTruthy();
    expect(v('view-source:file:///etc/passwd').blocked).toBe('scheme: file:');
    expect(v('view-source:https://ok.com/').allowedBy).toBe('domain: ok.com');
    expect(v('blob:https://ok.com/uuid').allowedBy).toBe('domain: ok.com');
    expect(v('blob:https://evil.com/uuid').blocked).toBe('domain: evil.com');
    expect(v('about:blank').blocked).toBeUndefined();
    expect(v('chrome://newtab/').blocked).toBeUndefined();
    expect(v('chrome-extension://selfid/popup.html').blocked).toBeUndefined();
    expect(v('data:text/html,hi', true).blocked).toBeTruthy();
    expect(v('data:image/png;base64,AA', false).blocked).toBeUndefined();
  });
});

describe('policy push', () => {
  it('blocks everything until the first push (fail closed)', () => {
    expect(
      c.dyn.some(
        (r) => r.action.type === 'block' && r.condition.urlFilter === '*' && r.priority === 100,
      ),
    ).toBe(true);
    expect(m.policyState().synced).toBe(false);
  });
  it('compiles rules into tiers, rejects unsupported regex, replaces atomically', async () => {
    const ack = await m.setPolicy({
      rev: 3,
      policy: 'deny',
      rules: [
        R(1, 'block', 'domain', 'evil.com'),
        R(2, 'allow', 'url', 'https://ok.com/a*b'),
        R(3, 'block', 'regex', '(?=x)'),
        R(4, 'allow', 'domain', 'ok.com'),
      ],
    });
    expect(ack.rejected).toEqual([{ id: 3, error: expect.stringContaining('regex') }]);
    const byId = Object.fromEntries(c.dyn.map((r) => [r.id, r]));
    expect(byId[1]).toBeUndefined(); // bootstrap gone
    expect(byId[1002]).toMatchObject({
      priority: 50,
      action: { type: 'block' },
      condition: { requestDomains: ['evil.com'] },
    });
    expect(byId[1005].condition.regexFilter).toBe('^https://ok\\.com/a\\*b'); // urlFilter wildcard chars escaped via regex
    expect(byId[1009]).toMatchObject({ priority: 40, action: { type: 'allow' } });
    expect(byId[3]).toMatchObject({ priority: 1, action: { type: 'block' } }); // default deny
    expect(m.policyState()).toMatchObject({ rev: 3, synced: true });
    await m.setPolicy({ rev: 4, policy: 'allow', rules: [R(4, 'allow', 'domain', 'ok.com')] });
    expect(c.dyn.map((r) => r.id)).toEqual([2]); // allow rules are irrelevant under allow; only the bridge exemption remains
  });
  it('a push arriving during startup is not overwritten by the block-all bootstrap', async () => {
    vi.resetModules();
    c = fakeChrome();
    vi.stubGlobal('chrome', c);
    m = await import('../entrypoints/background/url-policy');
    const init = m.initUrlPolicy(); // not awaited: the push races it
    const ack: any = await m.handleUrlPolicyMessage('url_policy_set', {
      rev: 9,
      policy: 'allow',
      rules: [],
    });
    await init;
    expect(ack.rev).toBe(9);
    expect(c.dyn.map((r) => r.id)).toEqual([2]);
    expect(m.policyState()).toMatchObject({ rev: 9, synced: true });
  });
  it("bridge exemption only covers the extension's own requests to the bridge ports", () => {
    const b = c.dyn.find((r) => r.id === 2);
    expect(b.condition.initiatorDomains).toEqual(['selfid']);
    const re = new RegExp(b.condition.regexFilter);
    expect(re.test('http://127.0.0.1:12306/ping')).toBe(true);
    expect(re.test('http://127.0.0.1:12316/ping')).toBe(true);
    expect(re.test('http://127.0.0.1:8080/')).toBe(false);
    expect(re.test('http://127.0.0.1:12317/')).toBe(false);
  });
  it('rejects malformed pushes', async () => {
    await expect(m.setPolicy({ rev: 1, policy: 'maybe' as any, rules: [] })).rejects.toThrow();
  });
});

describe('agent attribution', () => {
  const A = { principal: 'alice', sessionId: 's1' };
  const B = { principal: 'bob', sessionId: 's2' };
  const blocked = (tabId: number, url = 'https://evil.com/') =>
    c.declarativeNetRequest.onRuleMatchedDebug.fire({
      request: { tabId, type: 'main_frame', method: 'GET', url },
      rule: { ruleId: 1, rulesetId: '_dynamic' },
    });

  it('strips _meta.mcp from args and returns the caller', () => {
    const args: any = {
      url: 'x',
      _meta: { mcp: { principal: 'alice', sessionId: 's1' }, other: 1 },
    };
    expect(m.takeCaller(args)).toEqual(A);
    expect(args._meta).toEqual({ other: 1 });
    expect(m.takeCaller({ url: 'x' })).toBeUndefined();
  });

  it('owns tabs from tool calls, inherits to child tabs, infers only with one caller', () => {
    const end = m.beginCall(A, 10);
    blocked(10);
    c.tabs.onCreated.fire({ id: 11 }); // new tab while only alice is calling → alice's
    blocked(11);
    end();
    c.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 10, tabId: 12 }); // window.open from alice's tab
    blocked(12);
    blocked(99); // nobody's tab, no call in flight → unattributed (user)
    const endA = m.beginCall(A),
      endB = m.beginCall(B);
    blocked(98); // two agents in flight → don't guess
    endB();
    blocked(97); // only alice → inferred
    endA();
    m.claimTab(12, B); // bob drives alice's child tab: last writer wins
    blocked(12);
    c.tabs.onRemoved.fire(10);
    blocked(10);

    const { events } = m.takeEvents(0, m.policyState().epoch);
    expect(events.map((e) => [e.tabId, e.principal ?? null, e.agentVia ?? null])).toEqual([
      [10, 'alice', 'tool'],
      [11, 'alice', 'tool'],
      [12, 'alice', 'inherited'],
      [99, null, null],
      [98, null, null],
      [97, 'alice', 'inferred'],
      [12, 'bob', 'tool'],
      [10, null, null],
    ]);
    expect(events[0]).toMatchObject({
      via: 'dnr',
      blocked: 'not in sync: waiting for MControlProgram to push the URL policy',
    });
  });

  it('events: pulled by seq, dropped when acknowledged, reset on a new epoch', () => {
    blocked(1);
    blocked(2);
    blocked(3);
    const { epoch } = m.policyState();
    const first = m.takeEvents(0, epoch, 2);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(m.takeEvents(2, epoch).events.map((e) => e.seq)).toEqual([3]);
    expect(m.takeEvents(3, epoch).events).toEqual([]);
    blocked(4);
    expect(m.takeEvents(999, 'old-epoch').events.map((e) => e.seq)).toEqual([4]);
  });

  it('nav guard blocks non-network schemes and logs them', () => {
    m.beginCall(A, 5);
    c.webNavigation.onBeforeNavigate.fire({ tabId: 5, frameId: 0, url: 'file:///etc/passwd' });
    expect(c.tabs.update).toHaveBeenCalledWith(5, { url: 'about:blank' });
    expect(m.takeEvents(0, m.policyState().epoch).events[0]).toMatchObject({
      via: 'nav-guard',
      blocked: 'scheme: file:',
      principal: 'alice',
    });
  });
});
