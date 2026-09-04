/**
 * Everything one server process holds: the node client, the job table, the money state, and the capability set the
 * tool registration reads (design §3.3).
 *
 * Capabilities are derived once at startup from the node's own answers, and a tool whose capability is false is not
 * registered at all — the model never sees an affordance it cannot use.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { McpConfig } from './config.js';
import { publicSummary, secretsOf } from './config.js';
import { AinizeClient } from './client.js';
import { JobTable } from './jobs.js';
import { Budget, PurchaseJournal, QuoteBook } from './money.js';
import { modelLock, type ModelLockView, type NodeLock } from './format.js';

export interface NodeInfoView {
  name: string; address: string; url: string; ledger: string; roles: string[]; quorum: number; currency: string;
  model: string | null; runtime_available: boolean; balance: string | null; royalty_share: number | null;
  contributor_share: number | null; peers: number; counts: Record<string, number>;
}

export interface Capabilities {
  can_read: boolean;
  can_live_test: boolean;
  can_teach: boolean;
  can_buy: boolean;
  can_apply: boolean;
  can_publish: boolean;
}

export interface QuotaObservation { remaining: number | null; limit: number | null; observed_at: number }

interface RawInfo {
  node: { name: string; address: string; endpoint: string; roles: string[]; ledger: string; model?: string };
  ledger: { kind?: string; height?: number; records?: number };
  runtime: { available: boolean; model?: string; hook?: boolean };
  quorum: number; currency: string; peers: number; royalty_share?: number; contributor_share?: number;
  counts?: Record<string, number>;
}

export class Context {
  readonly client: AinizeClient;
  readonly jobs = new JobTable();
  readonly quotes = new QuoteBook();
  readonly budget: Budget;
  readonly journal: PurchaseJournal;
  readonly secrets: string[];
  /** The node's free-live-test bucket as last seen on a real answer — there is no quota endpoint to ask. */
  quota: QuotaObservation | null = null;
  /**
   * Daily lessons this session has spent. A lesson is scarce the way money is scarce — the node charges one at
   * submit time and never refunds it — so it is capped per session by server configuration, exactly like the
   * spending budget, and no tool argument can raise it (design §6.7).
   */
  lessonsSpent = 0;
  private info: NodeInfoView | null = null;
  private capsAt = 0;
  private caps: Capabilities = { can_read: true, can_live_test: false, can_teach: false, can_buy: false, can_apply: false, can_publish: false };

  constructor(readonly cfg: McpConfig, fetchImpl?: typeof fetch) {
    this.client = new AinizeClient(cfg, fetchImpl);
    this.budget = new Budget(cfg.budget.session, cfg.budget.perPurchase);
    this.journal = new PurchaseJournal(cfg.stateDir);
    this.secrets = secretsOf(cfg);
  }

  /** `GET /api/info` + `GET /api/chain`, cached 60 s (the node rate-limits per IP per minute). */
  async nodeInfo(force = false): Promise<NodeInfoView> {
    if (this.info && !force) return this.info;
    if (force) this.client.invalidate();
    const raw = await this.client.cached<RawInfo>('/api/info', 60_000);
    let balance: string | null = null;
    try {
      const chain = await this.client.cached<{ balance?: number | string }>('/api/chain', 30_000);
      balance = chain.balance === undefined || chain.balance === null ? null : String(chain.balance);
    } catch { balance = null; }
    this.info = {
      name: raw.node.name, address: raw.node.address, url: this.client.url, ledger: raw.node.ledger,
      roles: raw.node.roles ?? [], quorum: raw.quorum, currency: raw.currency,
      model: raw.runtime?.model ?? raw.node.model ?? null, runtime_available: !!raw.runtime?.available,
      balance, royalty_share: raw.royalty_share ?? null, contributor_share: raw.contributor_share ?? null,
      peers: raw.peers ?? 0, counts: raw.counts ?? {},
    };
    this.budget.setCurrency(this.info.currency);
    return this.info;
  }

  /** `GET /api/teach/policy` — public, cached 10 s. Null when this node runs no teach worker. */
  async teachPolicy(): Promise<Record<string, unknown> | null> {
    try { return await this.client.cached<Record<string, unknown>>('/api/teach/policy', 10_000); } catch { return null; }
  }

  /**
   * Derived from the node's own answers; `capabilities()` is what the tool registration and `ainize://instructions`
   * read. `force` re-probes instead of trusting the read caches — which is what makes a capability RECOVERABLE: the
   * shared model server can be stopped and restarted under a long-lived MCP session (it happens whenever someone
   * needs the GPUs), and a session that resolved `can_live_test: false` once must not stay crippled for its whole
   * life. `refreshCapabilities()` below is how a server notices, and `capabilityWatchers` is how its clients hear.
   */
  async resolveCapabilities(force = false): Promise<Capabilities> {
    const info = await this.nodeInfo(force).catch(() => null);
    const policy = await this.teachPolicy();
    this.caps = {
      can_read: true,
      can_live_test: !!info?.runtime_available,
      can_teach: !!policy && policy.enabled !== false && this.client.hasTeachKey,
      can_buy: this.client.hasOperator && this.budget.enabled,
      can_apply: this.client.hasOperator && this.cfg.allow.apply,
      can_publish: this.client.hasTeachKey && this.cfg.allow.publish && (info?.ledger !== 'ain' || this.cfg.allow.ainPublish),
    };
    this.capsAt = Date.now();
    return this.caps;
  }

  capabilities(): Capabilities { return this.caps; }

  /**
   * Re-probe the node and report whether the capability set moved. Called on a slow timer by every connected server
   * and eagerly by `node_status { refresh: true }`; `minAgeMs` keeps a burst of tool calls from turning into a burst
   * of `/api/info` requests (the node rate-limits per IP per minute).
   */
  async refreshCapabilities(minAgeMs = 20_000): Promise<{ changed: boolean; before: Capabilities; caps: Capabilities }> {
    const before = this.caps;
    if (Date.now() - this.capsAt < minAgeMs) return { changed: false, before, caps: before };
    this.capsAt = Date.now();       // set first: a slow probe must not let a second caller start another one
    await this.resolveCapabilities(true).catch(() => this.caps);
    const changed = (Object.keys(this.caps) as (keyof Capabilities)[]).some((k) => this.caps[k] !== before[k]);
    return { changed, before, caps: this.caps };
  }

  /**
   * Servers register a callback here so a capability that comes back (or goes away) reaches the client as a real
   * `notifications/tools/list_changed`, instead of the client holding a tool list that stopped being true.
   */
  readonly capabilityWatchers = new Set<(caps: Capabilities) => void>();

  async syncCapabilities(minAgeMs = 20_000): Promise<{ changed: boolean; before: Capabilities; caps: Capabilities }> {
    const out = await this.refreshCapabilities(minAgeMs);
    if (out.changed) for (const w of this.capabilityWatchers) { try { w(out.caps); } catch { /* one bad watcher must not break the others */ } }
    return out;
  }

  /** Why a capability is off, in one sentence — what `ainize://instructions` and a refusal both need to say. */
  capabilityReasons(): Record<string, string> {
    const r: Record<string, string> = {};
    if (!this.caps.can_live_test) r.can_live_test = 'the node reports no serving model (GET /api/runtime → available: false)';
    if (!this.caps.can_teach) r.can_teach = this.client.hasTeachKey ? 'this node runs no teach worker, or teaching is disabled in its policy' : 'no teaching key is configured on this MCP server (AINIZE_TEACH_KEY)';
    if (!this.caps.can_buy) r.can_buy = this.client.hasOperator ? 'the session budget is 0 — set AINIZE_MCP_SESSION_BUDGET to allow spending' : 'no operator credential is configured on this MCP server (buying is operator-gated on the node)';
    if (!this.caps.can_apply) r.can_apply = 'apply/remove change the model server every node on this machine shares — set AINIZE_MCP_ALLOW_APPLY=1 to enable them';
    if (!this.caps.can_publish) r.can_publish = 'publishing is irreversible — set AINIZE_MCP_ALLOW_PUBLISH=1 (and AINIZE_MCP_ALLOW_AIN_PUBLISH=1 for a node on the shared AIN chain)';
    return r;
  }

  /** The `node` block every tool result carries, so an agent never has to guess where it is. */
  async envelopeNode(): Promise<Record<string, unknown>> {
    const info = await this.nodeInfo().catch(() => null);
    return info
      ? { name: info.name, url: info.url, ledger: info.ledger, currency: info.currency, model: info.model }
      : { name: null, url: this.client.url, ledger: null, currency: null, model: null };
  }

  /** Who holds the shared model right now, in one sentence, computed against the NODE's clock. */
  async modelLock(): Promise<ModelLockView> {
    try {
      const s = await this.client.request<{ lock: NodeLock | null; queue?: { running?: unknown; waiting?: number }; now: number }>('/api/chat/patches', { timeoutMs: 8_000 });
      return modelLock(s.lock, s.queue, s.now);
    } catch {
      return { holder: null, queue: { running: 0, waiting: 0 }, sentence: 'the model lock could not be read from the node just now' };
    }
  }

  observeQuota(remaining: number | null, limit: number | null): void {
    this.quota = { remaining, limit, observed_at: Date.now() };
  }

  /**
   * The free-live-test bucket, described the way this server can honestly describe it. The node meters an anonymous
   * visitor at 20 an hour per IP but charges its own OPERATOR nothing — and an answer that came back with
   * `quota_limit: null` is that fact, measured. Rendered in one place so the handle, the landed test and
   * `node_status` cannot disagree about whether a number exists.
   */
  quotaView(): Record<string, unknown> {
    const unmetered = this.quota ? this.quota.limit === null : this.client.hasOperator;
    if (unmetered) {
      return {
        metered: false, live_tests_remaining: null, limit: null,
        observed_at: this.quota?.observed_at ?? null,
        note: this.quota
          ? 'not metered: this node does not charge its own operator a trial quota, and this server signs its live tests in as the operator'
          : 'this server holds this node\'s operator credential, so its live tests should not be metered — confirmed once a test answers',
      };
    }
    return this.quota
      ? { metered: true, live_tests_remaining: this.quota.remaining, limit: this.quota.limit, observed_at: this.quota.observed_at,
          note: 'the node meters free live tests per visitor IP, so this bucket is shared by everyone using this MCP server' }
      : { metered: true, live_tests_remaining: null, limit: 20, observed_at: null,
          note: 'the node has no quota endpoint — the remaining count is only known after a live test answers. 20 per rolling hour per visitor IP, shared by everyone using this MCP server.' };
  }

  /** Where `download_lesson` puts files: the configured directory, else under the state dir, else the temp dir. */
  get downloadDir(): string {
    if (this.cfg.downloadDir) return resolve(this.cfg.downloadDir);
    if (this.cfg.stateDir) return join(resolve(this.cfg.stateDir), 'lessons');
    return join(tmpdir(), 'ainize-mcp', 'lessons');
  }

  get maxDownloadBytes(): number { return this.cfg.maxDownloadBytes; }

  configSummary(): Record<string, unknown> { return publicSummary(this.cfg); }
}
