/**
 * Flattening and sentences.
 *
 * A raw `CatalogEntry` is anchor + attestations + settlements + 26 benchmark samples — kilobytes per row. Returning
 * twenty of them from a search would exhaust the client's context before the agent got to the interesting part, so
 * every list result is flattened to a stable, small vocabulary and the deep object stays behind an explicit include.
 */
export interface NodeLock {
  owner?: string; label?: string; since?: number; alive?: boolean; stale?: boolean; mine?: boolean;
}
export interface ModelLockView {
  holder: { owner: string; label: string; held_s: number; alive: boolean; stale: boolean; mine: boolean } | null;
  queue: { running: number; waiting: number };
  sentence: string;
}

/** A live test's label is already human-readable upstream (`chat:krx-all-2761+pixelplus-087600`). */
const readableLabel = (label: string): string => {
  const [kind = '', rest = ''] = [label.split(':')[0] ?? '', label.split(':').slice(1).join(':')];
  const ids = rest.split('+').filter(Boolean).join(' + ');
  if (kind === 'chat') return ids ? `a live test of ${ids}` : 'a live test';
  if (kind === 'apply') return ids ? `applying ${ids}` : 'applying a knowledge';
  if (kind === 'remove') return ids ? `removing ${ids}` : 'removing a knowledge';
  if (kind === 'verify') return ids ? `verifying ${ids}` : 'a verification run';
  if (kind === 'teach') return ids ? `a teach job (${ids})` : 'a teach job';
  return label;
};

/**
 * Who holds the shared model, in one sentence (design §7.4).
 * `held_s` is computed against the NODE's own `now`, never `Date.now()`: a client clock three hours off must not
 * produce "held for 3 hours".
 */
export function modelLock(lock: NodeLock | null | undefined, queue: { running?: unknown; waiting?: number } | undefined, now: number): ModelLockView {
  const waiting = Number(queue?.waiting ?? 0);
  const running = queue?.running ? 1 : 0;
  if (!lock || !lock.owner) {
    return { holder: null, queue: { running, waiting }, sentence: waiting > 0 ? `the model is free; ${waiting} request(s) are queued on this node` : 'the model is free' };
  }
  const held = Math.max(0, Math.round((now - Number(lock.since ?? now)) / 1000));
  const holder = { owner: String(lock.owner), label: String(lock.label ?? ''), held_s: held, alive: lock.alive !== false, stale: !!lock.stale, mine: !!lock.mine };
  const what = holder.label ? ` (${readableLabel(holder.label)})` : '';
  const tail = waiting > 0 ? `; ${waiting} request(s) are waiting ahead of you` : '';
  const sentence = holder.stale
    ? `the model lease is held by ${holder.owner}${what} but looks abandoned (${held} s) — the node will break it automatically${tail}`
    : `the model is held by ${holder.owner}${what} for ${held} s${tail}`;
  return { holder, queue: { running, waiting }, sentence };
}

export interface RawEntry {
  anchor: Record<string, unknown> & {
    id: string; name: string; description?: string; author: string; author_name?: string; price: string; currency: string;
    rows: number; size_bytes: number; created_at: number; parents?: string[]; license?: string;
    model: { id_M: string }; benchmark: { schema: string; queries?: number; samples?: unknown[] };
    base?: { stack?: { patch_id: string }[] }; origin?: string; dataset?: { rows?: number; access?: string; license?: string; sha256?: string };
    contributors?: { name?: string; address: string }[];
  };
  status: string; passed: number; quorum: number; quorum_ok: boolean; sellable: boolean; downloads: number;
  attestations?: RawAttestation[]; supersedes?: string[]; superseded_by?: string[]; challenges?: { reason?: string }[];
}
export interface RawAttestation {
  verifier: string; verifier_name?: string; passed: boolean; score?: Record<string, string>; verified_on?: string; created_at: number;
}

const mb = (bytes: number): number => Math.round((bytes / 1024 ** 2) * 10) / 10;

/** One compact row for `search_knowledge` / list views. */
export function knowledgeRow(e: RawEntry, nodeUrl: string) {
  const stack = e.anchor.base?.stack ?? [];
  return {
    id: e.anchor.id,
    name: e.anchor.name,
    description: (e.anchor.description ?? '').slice(0, 280),
    price: e.anchor.price,
    currency: e.anchor.currency,
    rows: e.anchor.rows,
    size_mb: mb(e.anchor.size_bytes),
    status: e.status,
    downloads: e.downloads,
    quorum: `${e.passed}/${e.quorum}`,
    quorum_ok: e.quorum_ok,
    sellable: e.sellable,
    author: e.anchor.author,
    author_name: e.anchor.author_name ?? null,
    taught_by: e.anchor.contributors?.[0]?.name ?? null,
    model: e.anchor.model.id_M,
    schema: e.anchor.benchmark.schema,
    origin: e.anchor.origin ?? 'operator',
    created_at: e.anchor.created_at,
    /** From `anchor.base.stack` — a shopping agent sees the add-ons before it clicks (design §4.1). */
    is_addon: stack.length > 0,
    requires_count: stack.length,
    node_url: nodeUrl,
  };
}

/** The verification block a judge reads. `stake` is dropped on the way out — it was never escrowed. */
export function verification(e: RawEntry) {
  return {
    quorum: `${e.passed}/${e.quorum}`,
    quorum_ok: e.quorum_ok,
    sellable: e.sellable,
    open_challenge: e.challenges?.length ? (e.challenges[e.challenges.length - 1]?.reason ?? 'challenged') : null,
    attestations: (e.attestations ?? []).map((a) => ({
      verifier: a.verifier, verifier_name: a.verifier_name ?? null, passed: a.passed,
      score: a.score ?? null, verified_on: a.verified_on ?? null, created_at: a.created_at,
    })),
  };
}

/** `eta_s` is null until the node has measured enough real runs — say that, never render 0 (design §7.5). */
export const etaNote = (eta: number | null | undefined): string =>
  eta === null || eta === undefined ? 'no measured estimate yet' : `about ${Math.round(eta)} s, from this node's own measured runs`;
