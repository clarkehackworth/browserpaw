/**
 * Managed URL policy (clarkehackworth fork, driven by MControlProgram).
 *
 * MControlProgram pushes a block/allow rule list over the bridge (native server HTTP routes → native
 * messaging, never an MCP tool). It is enforced with declarativeNetRequest dynamic rules, so it covers
 * every request a page makes (navigations, frames, XHR/fetch, websockets), not just tool arguments.
 * Non-network schemes (file:, chrome:, ...) are refused by a webNavigation guard.
 *
 * Also tracks which agent owns each tab (from the `_meta.mcp` MControlProgram puts on every tool call) and
 * buffers blocked/allowed events that MControlProgram pulls for its request log.
 *
 * Until the first push the browser blocks everything (fail closed). DNR dynamic rules persist across
 * browser restarts, so a restarted browser keeps enforcing the last list it received.
 */

type Kind = 'domain' | 'url' | 'regex';
type Policy = 'allow' | 'deny';
export interface PolicyRule {
  id: number;
  action: 'block' | 'allow';
  kind: Kind;
  value: string;
}
export type LogAllowed = 'navigation' | 'all' | 'none';
export interface PolicyPush {
  rev: number;
  policy: Policy;
  rules: PolicyRule[];
  logAllowed?: LogAllowed;
}
export interface Caller {
  principal: string | null;
  sessionId: string | null;
}
type AgentVia = 'tool' | 'inherited' | 'inferred';
interface Owner extends Caller {
  via: AgentVia;
}
export interface PolicyEvent {
  seq: number;
  ts: number;
  tabId: number;
  type: string;
  method?: string;
  url: string;
  initiator?: string;
  blocked?: string;
  allowedBy?: string;
  via: 'dnr' | 'nav-guard' | 'observed';
  principal?: string | null;
  sessionId?: string | null;
  agentVia?: AgentVia;
}

// ---------- matching (mirror of MControlProgram src/core/url-policy.ts; keep the two in step) ----------

const canonicalHost = (h: string) => h.toLowerCase().replace(/\.+$/, '');
const label = (r: Pick<PolicyRule, 'kind' | 'value'>) => `${r.kind}: ${r.value}`;

export function ruleMatches(r: Pick<PolicyRule, 'kind' | 'value'>, u: URL): boolean {
  const host = canonicalHost(u.hostname);
  if (r.kind === 'domain') return host === r.value || host.endsWith('.' + r.value);
  if (r.kind === 'url') return u.href.startsWith(r.value);
  try {
    return new RegExp(r.value, 'i').test(u.href);
  } catch {
    return false;
  }
}

export function verdict(
  u: URL,
  rules: Pick<PolicyRule, 'action' | 'kind' | 'value'>[],
  policy: Policy,
): { blocked?: string; allowedBy?: string } {
  const b = rules.find((r) => r.action === 'block' && ruleMatches(r, u));
  if (b) return { blocked: label(b) };
  const a = rules.find((r) => r.action === 'allow' && ruleMatches(r, u));
  if (a) return { allowedBy: label(a) };
  return policy === 'deny' ? { blocked: 'default: deny' } : { allowedBy: 'default: allow' };
}

/** Scheme table + rules. `top` = top-level navigation. `selfId` = this extension's id (its own pages are allowed). */
export function browserVerdict(
  raw: string,
  rules: Pick<PolicyRule, 'action' | 'kind' | 'value'>[],
  policy: Policy,
  top: boolean,
  selfId?: string,
  depth = 0,
): { blocked?: string; allowedBy?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { blocked: 'invalid url' };
  }
  const p = u.protocol;
  if (p === 'http:' || p === 'https:') return verdict(u, rules, policy);
  if (p === 'ws:' || p === 'wss:')
    return verdict(new URL(u.href.replace(/^ws/i, 'http')), rules, policy);
  if (p === 'about:')
    return /^about:(blank|srcdoc)$/i.test(u.href.split(/[?#]/)[0]!)
      ? { allowedBy: 'scheme: about:blank' }
      : { blocked: 'scheme: about:' };
  if (p === 'chrome:')
    return /^chrome:\/\/(newtab|new-tab-page)\//i.test(u.href)
      ? { allowedBy: 'scheme: chrome://newtab' }
      : { blocked: 'scheme: chrome:' };
  if (p === 'chrome-extension:')
    return selfId && u.hostname === selfId
      ? { allowedBy: 'scheme: this extension' }
      : { blocked: 'scheme: chrome-extension:' };
  if (p === 'data:')
    return top ? { blocked: 'scheme: data: (top-level)' } : { allowedBy: 'scheme: data:' };
  // Wrappers: judge the URL inside (view-source:file:///…, blob:https://evil/…). Depth-limited against nesting games.
  if ((p === 'view-source:' || p === 'blob:' || p === 'filesystem:') && depth < 3) {
    const inner = browserVerdict(raw.slice(p.length), rules, policy, top, selfId, depth + 1);
    if (p === 'view-source:' || inner.blocked) return inner;
    return /^https?:/i.test(raw.slice(p.length)) ? inner : { blocked: `scheme: ${p}` };
  }
  return { blocked: `scheme: ${p}` }; // file:, ftp:, ssh:, javascript:, devtools:, external app handlers, …
}

// ---------- declarativeNetRequest ----------

const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as unknown as chrome.declarativeNetRequest.ResourceType[];
const BLOCK = 'block' as chrome.declarativeNetRequest.RuleActionType;
const ALLOW = 'allow' as chrome.declarativeNetRequest.RuleActionType;
// Rule ids: fixed ones below 1000; user rule n → 1000 + 2n (block) / 1001 + 2n (allow).
const ID_BOOTSTRAP = 1,
  ID_BRIDGE = 2,
  ID_DENY = 3;
// Priorities: higher wins; at equal priority allow beats block, so tiers never share a priority.
const PRI = { bridge: 200, bootstrap: 100, block: 50, allow: 40, deny: 1 };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const labels = new Map<number, string>(); // DNR rule id → label for the log

async function compile(p: PolicyPush): Promise<{
  add: chrome.declarativeNetRequest.Rule[];
  rejected: { id: number; error: string }[];
}> {
  const add: chrome.declarativeNetRequest.Rule[] = [bridgeRule()];
  const rejected: { id: number; error: string }[] = [];
  labels.clear();
  for (const r of p.rules) {
    if (r.action === 'allow' && p.policy !== 'deny') continue; // allow rules only matter under deny
    const id = 1000 + 2 * r.id + (r.action === 'allow' ? 1 : 0);
    let condition: chrome.declarativeNetRequest.RuleCondition;
    if (r.kind === 'domain') condition = { requestDomains: [r.value] };
    // urlFilter has no escape syntax, so prefixes containing its wildcard characters go through a regex.
    else if (r.kind === 'url')
      condition = /[*^|]/.test(r.value)
        ? { regexFilter: '^' + escapeRe(r.value), isUrlFilterCaseSensitive: true }
        : { urlFilter: '|' + r.value, isUrlFilterCaseSensitive: true };
    else {
      const ok = await chrome.declarativeNetRequest.isRegexSupported({
        regex: r.value,
        isCaseSensitive: false,
      });
      if (!ok.isSupported) {
        rejected.push({
          id: r.id,
          error: `regex not supported by the browser (${ok.reason ?? 'unsupported'})`,
        });
        continue;
      }
      condition = { regexFilter: r.value, isUrlFilterCaseSensitive: false };
    }
    add.push({
      id,
      priority: r.action === 'block' ? PRI.block : PRI.allow,
      action: { type: r.action === 'block' ? BLOCK : ALLOW },
      condition: { ...condition, resourceTypes: RESOURCE_TYPES },
    });
    labels.set(id, label(r));
  }
  if (p.policy === 'deny') {
    add.push({
      id: ID_DENY,
      priority: PRI.deny,
      action: { type: BLOCK },
      condition: { urlFilter: '*', resourceTypes: RESOURCE_TYPES },
    });
    labels.set(ID_DENY, 'default: deny');
  }
  return { add, rejected };
}

/**
 * The extension's own health checks to its native server (127.0.0.1:12306-12316) must survive block-all.
 * Scoped to requests this extension itself initiates (web pages can't use it) and the bridge ports only;
 * the bridge itself requires its bearer token for everything but /ping. (`tabIds` would be tighter but is
 * only allowed on session rules, and this one must persist.)
 */
function bridgeRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: ID_BRIDGE,
    priority: PRI.bridge,
    action: { type: ALLOW },
    condition: {
      regexFilter: '^http://127\\.0\\.0\\.1:123(0[6-9]|1[0-6])/',
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: [
        'xmlhttprequest',
        'other',
      ] as unknown as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}

async function replaceRules(add: chrome.declarativeNetRequest.Rule[]) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: add,
  });
}

// ---------- state ----------

interface Stored {
  rev: number;
  policy: Policy;
  rules: PolicyRule[];
  logAllowed: LogAllowed;
}
let current: Stored | undefined; // undefined = never received a policy → blocking everything

export async function setPolicy(p: PolicyPush) {
  if (
    !Number.isInteger(p?.rev) ||
    (p.policy !== 'allow' && p.policy !== 'deny') ||
    !Array.isArray(p.rules)
  )
    throw new Error('invalid policy');
  const { add, rejected } = await compile(p);
  await replaceRules(add);
  const bad = new Set(rejected.map((r) => r.id));
  current = {
    rev: p.rev,
    policy: p.policy,
    rules: p.rules.filter((r) => !bad.has(r.id)),
    logAllowed: p.logAllowed ?? 'navigation',
  };
  await chrome.storage.local.set({ urlPolicy: current });
  return { rev: p.rev, installed: add.length, rejected };
}

export const policyState = () => ({
  rev: current?.rev ?? null,
  epoch,
  seq,
  synced: !!current,
  rules: current?.rules.length ?? 0,
  policy: current?.policy ?? null,
});

// ---------- tab ownership (agent attribution) ----------

const owners = new Map<number, Owner>();
const inflight = new Map<number, Caller>();
let callSeq = 0;
const same = (a: Caller, b: Caller) => a.principal === b.principal && a.sessionId === b.sessionId;
/** The single agent with a call running right now, if exactly one is. Never guesses between two. */
function soleCaller(): Caller | undefined {
  let only: Caller | undefined;
  for (const c of inflight.values()) {
    if (!only) only = c;
    else if (!same(only, c)) return undefined;
  }
  return only;
}
function setOwner(tabId: number, o: Owner) {
  if (tabId >= 0) {
    owners.set(tabId, o);
    persistSoon();
  }
}

/** Remove MControlProgram's caller identity from tool args (tools never see it). */
export function takeCaller(args: any): Caller | undefined {
  const m = args?._meta?.mcp;
  if (args?._meta) delete args._meta.mcp;
  if (!m || typeof m !== 'object') return undefined;
  return {
    principal: typeof m.principal === 'string' ? m.principal : null,
    sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
  };
}
/** Mark a tool call in flight; returns `end`. A tab named in the args is claimed up front. */
export function beginCall(caller: Caller | undefined, tabId?: unknown): () => void {
  if (!caller) return () => {};
  const id = ++callSeq;
  inflight.set(id, caller);
  if (typeof tabId === 'number') setOwner(tabId, { ...caller, via: 'tool' });
  return () => {
    inflight.delete(id);
  };
}
export function claimTab(tabId: number, caller: Caller | undefined) {
  if (caller) setOwner(tabId, { ...caller, via: 'tool' });
}

function attribution(tabId: number): Pick<PolicyEvent, 'principal' | 'sessionId' | 'agentVia'> {
  const o = owners.get(tabId);
  if (o) return { principal: o.principal, sessionId: o.sessionId, agentVia: o.via };
  const c = tabId >= 0 ? soleCaller() : undefined;
  return c ? { ...c, agentVia: 'inferred' } : {};
}

// ---------- event ring ----------

const MAX_EVENTS = 5000;
let epoch = '';
let seq = 0;
let events: PolicyEvent[] = [];

function record(e: Omit<PolicyEvent, 'seq' | 'ts' | 'principal' | 'sessionId' | 'agentVia'>) {
  events.push({ ...e, ...attribution(e.tabId), seq: ++seq, ts: Date.now() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persistSoon();
}

/** Events after `after` (from the same epoch; a new epoch = browser restarted, start over). Older ones are dropped: MControlProgram has them. */
export function takeEvents(after: number, ep: string, limit = 1000) {
  const from = ep === epoch ? Number(after) || 0 : 0;
  events = events.filter((e) => e.seq > from);
  const first = events[0]?.seq;
  const dropped = first !== undefined && first > from + 1 ? first - from - 1 : 0;
  return {
    epoch,
    rev: current?.rev ?? null,
    events: events.slice(0, Math.min(Math.max(1, limit), 1000)),
    dropped,
  }; // rev doubles as the sync heartbeat
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon() {
  persistTimer ??= setTimeout(() => {
    persistTimer = undefined;
    void chrome.storage.session
      .set({ urlPolicyRuntime: { epoch, seq, events, owners: [...owners] } })
      .catch(() => {});
  }, 1000);
}

// ---------- listeners ----------

const NAV_TYPES = new Set(['main_frame', 'sub_frame', 'websocket']);

let ready: Promise<void> = Promise.resolve();

async function loadState() {
  const stored = (await chrome.storage.local.get('urlPolicy')).urlPolicy as Stored | undefined;
  // chrome.storage.session survives service-worker restarts but not a browser restart.
  const rt = (await chrome.storage.session.get('urlPolicyRuntime')).urlPolicyRuntime as any;
  if (rt?.epoch) {
    epoch = rt.epoch;
    seq = Math.max(seq, rt.seq ?? 0);
    events = [...(rt.events ?? []), ...events];
    for (const [k, v] of rt.owners ?? []) if (!owners.has(k)) owners.set(k, v); // anything set since wake-up is newer
  } else if (!epoch) epoch = crypto.randomUUID();
  if (current) return; // a push landed while loading; it wins
  current = stored;
  if (current)
    await compile(current); // rebuilds labels; the DNR rules themselves persisted
  else {
    await replaceRules([
      bridgeRule(),
      {
        id: ID_BOOTSTRAP,
        priority: PRI.bootstrap,
        action: { type: BLOCK },
        condition: { urlFilter: '*', resourceTypes: RESOURCE_TYPES },
      },
    ]);
    labels.set(ID_BOOTSTRAP, 'not in sync: waiting for MControlProgram to push the URL policy');
  }
}

/** Call synchronously from the background entry point: listeners first, then state (awaited by everything that needs it). */
export function initUrlPolicy(): Promise<void> {
  registerListeners();
  ready = loadState();
  return ready;
}

function registerListeners() {
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(({ request, rule }) => {
    if (rule.rulesetId !== '_dynamic') return;
    const lbl = labels.get(rule.ruleId);
    if (!lbl || rule.ruleId === ID_BRIDGE || (rule.ruleId >= 1000 && rule.ruleId % 2 === 1)) return; // allow matches are logged below
    // Non-web schemes (file:) also hit the catch-all; the nav guard logs those with the real reason.
    if (!/^(https?|wss?):/i.test(request.url)) return;
    record({
      tabId: request.tabId,
      type: request.type,
      method: request.method,
      url: request.url,
      initiator: request.initiator,
      blocked: lbl,
      via: 'dnr',
    });
  });

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      const log = current?.logAllowed ?? 'none';
      if (log === 'none' || (log === 'navigation' && !NAV_TYPES.has(d.type))) return;
      const v = browserVerdict(
        d.url,
        current!.rules,
        current!.policy,
        d.type === 'main_frame',
        chrome.runtime.id,
      );
      if (v.blocked) return; // DNR blocked it and onRuleMatchedDebug logged it
      record({
        tabId: d.tabId,
        type: d.type,
        method: d.method,
        url: d.url,
        initiator: d.initiator,
        allowedBy: v.allowedBy,
        via: 'observed',
      });
    },
    { urls: ['<all_urls>'] },
  );

  // Non-network schemes never reach DNR. Best effort: the frame may start loading before this fires.
  // Only in agent tabs (owned, or the single agent driving the browser right now): the person at a headed
  // browser can still open chrome://extensions, chrome://settings, file:// in their own tabs.
  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (/^(https?|wss?):/i.test(d.url)) return;
    if (!attribution(d.tabId).agentVia) return;
    const v = browserVerdict(
      d.url,
      current?.rules ?? [],
      current?.policy ?? 'deny',
      d.frameId === 0,
      chrome.runtime.id,
    );
    if (!v.blocked) return;
    record({
      tabId: d.tabId,
      type: d.frameId === 0 ? 'main_frame' : 'sub_frame',
      url: d.url,
      blocked: v.blocked,
      via: 'nav-guard',
    });
    if (d.frameId === 0) void chrome.tabs.update(d.tabId, { url: 'about:blank' }).catch(() => {});
  });

  // A tab an agent's page opens (window.open, target=_blank, ctrl-click) belongs to the same agent.
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    const o = owners.get(d.sourceTabId);
    if (o) setOwner(d.tabId, { principal: o.principal, sessionId: o.sessionId, via: 'inherited' });
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined || owners.has(tab.id)) return;
    const o = tab.openerTabId !== undefined ? owners.get(tab.openerTabId) : undefined;
    if (o)
      return setOwner(tab.id, { principal: o.principal, sessionId: o.sessionId, via: 'inherited' });
    const c = soleCaller(); // e.g. chrome_navigate opening a new tab: claim it before its first request
    if (c) setOwner(tab.id, { ...c, via: 'tool' });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (owners.delete(tabId)) persistSoon();
  });
  chrome.tabs.onReplaced.addListener((added, removed) => {
    const o = owners.get(removed);
    if (o) {
      owners.delete(removed);
      setOwner(added, o);
    }
  });
}

/** Native-messaging entry point (native server routes /url-policy*). */
export async function handleUrlPolicyMessage(type: string, payload: any) {
  await ready.catch(() => {}); // never race the startup load (it could otherwise reinstall block-all over a fresh push)
  if (type === 'url_policy_set') return setPolicy(payload);
  if (type === 'url_policy_state') return policyState();
  if (type === 'url_policy_events')
    return takeEvents(
      Number(payload?.after),
      String(payload?.epoch ?? ''),
      Number(payload?.limit) || 1000,
    );
  throw new Error(`unknown url policy message ${type}`);
}
