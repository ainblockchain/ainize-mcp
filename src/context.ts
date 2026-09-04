/**
 * Everything one server process holds: the node client, the job table, the money state, and the capability set the
 * tool registration reads (design §3.3).
 *
 * Capabilities are derived once at startup from the node's own answers, and a tool whose capability is false is not
 * registered at all — the model never sees an affordance it cannot use.
 */
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
  private info: NodeInfoView | null = null;
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

  /** Derived once at startup; `capabilities()` is what the tool registration and `ainize://instructions` read. */
  async resolveCapabilities(): Promise<Capabilities> {
    const info = await this.nodeInfo().catch(() => null);
    const policy = await this.teachPolicy();
    this.caps = {
      can_read: true,
      can_live_test: !!info?.runtime_available,
      can_teach: !!policy && policy.enabled !== false && this.client.hasTeachKey,
      can_buy: this.client.hasOperator && this.budget.enabled,
      can_apply: this.client.hasOperator && this.cfg.allow.apply,
      can_publish: this.client.hasTeachKey && this.cfg.allow.publish && (info?.ledger !== 'ain' || this.cfg.allow.ainPublish),
    };
    return this.caps;
  }

  capabilities(): Capabilities { return this.caps; }

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

  configSummary(): Record<string, unknown> { return publicSummary(this.cfg); }
}
