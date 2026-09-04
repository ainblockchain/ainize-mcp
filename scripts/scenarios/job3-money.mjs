/**
 * Job 3 — "buy this knowledge but never spend more than N" — plus every money attack.
 *
 * Runs against a PRIVATE local-ledger cluster (port base 4102), never the demo cluster: a settlement is a ledger
 * write, and the demo cluster must be left as found. The buyer is that cluster's node-b; the seller its node-a.
 */
const NODE = process.env.MONEY_NODE_URL ?? 'http://localhost:4103';
const PASS = process.env.MONEY_NODE_PASSWORD ?? 'mcp-adversarial-b';
const PRIVATE_KEY_SHAPED = '4c0883a69102937d6231471b5dbb6204fe512961708279f2c9e1a1b0b8b4f0a1';

const settlements = async () => {
  const r = await fetch(`${NODE}/api/ledger?kind=settle&limit=1000`);
  return (await r.json()).records.length;
};

/**
 * Pick the targets from the node itself so the run repeats: the cheapest thing still unbought is what gets bought,
 * the dearest listed thing is what the cap must refuse, and the cap is set between them. (This is scenario setup,
 * over plain HTTP — everything the checks assert goes through the MCP client.)
 */
async function targets() {
  const token = (await (await fetch(`${NODE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) })).json()).token;
  const bought = new Set(((await (await fetch(`${NODE}/api/me/purchases`, { headers: { authorization: `Bearer ${token}` } })).json()).items ?? []).map((r) => r.patch_id));
  const cat = await (await fetch(`${NODE}/api/catalog?limit=50`)).json();
  const listed = cat.items.filter((e) => e.sellable && !e.owned && !bought.has(e.anchor.id))
    .map((e) => ({ id: e.anchor.id, price: Number(e.anchor.price) }))
    .sort((a, b) => a.price - b.price);
  const cheapest = listed[0];
  const dearest = listed[listed.length - 1];
  if (!cheapest || !dearest || dearest.price <= cheapest.price) {
    throw new Error(`the private cluster needs two differently-priced unbought knowledges; it has ${listed.map((l) => `${l.id}@${l.price}`).join(', ') || 'none'}. Reseed it (see packages/mcp/scripts/scenarios/README).`);
  }
  const cap = cheapest.price + (dearest.price - cheapest.price) / 2;   // fits the cheap one, refuses the dear one
  return { AFFORDABLE: cheapest.id, TOO_DEAR: dearest.id, CAP: String(cap) };
}

export default async function ({ session, check, pollJob, log, transcript }) {
  const { AFFORDABLE, TOO_DEAR, CAP } = await targets();
  log(`buying ${AFFORDABLE}, refusing ${TOO_DEAR}, cap ${CAP}`);
  const before = await settlements();
  const s = await session({ AINIZE_NODE_URL: NODE, AINIZE_OPERATOR_PASSWORD: PASS, AINIZE_MCP_SESSION_BUDGET: CAP }, { label: 'private-node-b' });
  try {
    const names = (await s.tools()).map((t) => t.name);
    check('J3.0', 'a server with a budget registers buy; the cap itself is server configuration', names.includes('buy') && names.includes('quote') && names.includes('reconcile_purchase'), names.join(', '));

    // --- the human's ceiling is refused BEFORE any money moves -----------------------------------------------------
    const dear = await s.call('quote', { id: TOO_DEAR }, 'quote the knowledge the human asked for');
    const aff = dear.data.affordable ?? {};
    check('J3.1', 'quote prices it and says plainly that it does not fit the cap, with the shortfall', !dear.isError && aff.requested === false && aff.shortfall !== '0', `total ${dear.data.total_requested} ${dear.data.currency} · remaining ${dear.data.budget?.remaining} · shortfall ${aff.shortfall} · "${aff.explanation}"`);
    check('J3.1b', 'the quote hands back the exact confirm arguments and tells the agent to stop', !!dear.data.confirm_with?.quote_id && /STOP/i.test(String(dear.data.next)), JSON.stringify(dear.data.confirm_with));

    const overCap = await s.call('buy', { quote_id: dear.data.quote_id, confirm_total: dear.data.total_requested, confirm: true }, 'ATTACK: buy over the session cap, with a perfectly formed confirmation');
    check('J3.2', 'buying over the cap is refused with the four numbers, and never retried automatically', overCap.isError && overCap.data.error?.code === 'budget_exceeded' && overCap.data.error?.retryable === false, `${overCap.data.error?.code}: ${overCap.data.error?.message}`);

    // --- attacks on the affordable one ------------------------------------------------------------------------------
    const q = await s.call('quote', { id: AFFORDABLE }, 'quote something that fits');
    check('J3.3', 'the affordable quote fits and says so', !q.isError && q.data.affordable?.requested === true, `${q.data.total_requested} ${q.data.currency} of ${q.data.budget?.remaining} remaining`);

    const noConfirm = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested }, 'ATTACK: buy with no confirm at all');
    check('J3.4', 'buy without confirm is refused by the schema before the handler runs', noConfirm.isError, `${noConfirm.protocolError ?? noConfirm.data.error?.message ?? JSON.stringify(noConfirm.data).slice(0, 200)}`);

    const confirmFalse = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested, confirm: false }, 'ATTACK: buy with confirm: false');
    check('J3.4b', 'confirm: false is refused too, not read as "present"', confirmFalse.isError, `${confirmFalse.protocolError ?? confirmFalse.data.error?.message ?? ''}`.slice(0, 220));

    const wrongTotal = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: '0.0001', confirm: true }, 'ATTACK: restate a total nobody quoted');
    check('J3.5', 'a total that is not the quoted one is refused with both numbers', wrongTotal.isError && wrongTotal.data.error?.code === 'quote_mismatch', `${wrongTotal.data.error?.message}`);

    const bogusQuote = await s.call('buy', { quote_id: 'q_not_a_real_quote', confirm_total: q.data.total_requested, confirm: true }, 'ATTACK: buy against a quote this server never issued');
    check('J3.6', 'an unknown quote id is refused and names the fix', bogusQuote.isError && !!bogusQuote.data.error?.code, `${bogusQuote.data.error?.code}: ${bogusQuote.data.error?.message}`);

    const keyAsQuote = await s.call('buy', { quote_id: PRIVATE_KEY_SHAPED.slice(0, 64), confirm_total: q.data.total_requested, confirm: true }, 'ATTACK: hand a private key where a quote id belongs');
    check('J3.7', 'a private key passed as a quote id is refused, and the key is not echoed back', keyAsQuote.isError && !JSON.stringify(keyAsQuote.data).includes(PRIVATE_KEY_SHAPED) && !JSON.stringify(keyAsQuote.data).includes(PRIVATE_KEY_SHAPED.slice(0, 32)), `${keyAsQuote.data.error?.code}: ${String(keyAsQuote.data.error?.message).slice(0, 140)}`);

    const ghost = await s.call('quote', { id: 'no-such-knowledge-at-all' }, 'ATTACK: quote something that does not exist');
    check('J3.8', 'a knowledge that does not exist is not_found with the node it was looked for on', ghost.isError && ghost.data.error?.code === 'not_found', `${ghost.data.error?.message}`);

    // --- the dry run: every gate, nothing called ---------------------------------------------------------------------
    const dry = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested, confirm: true, dry_run: true }, 'the agent shows the human what would happen');
    check('J3.9', 'dry_run passes every gate and settles nothing', !dry.isError && dry.data.dry_run === true && Array.isArray(dry.data.gates_passed), `gates: ${(dry.data.gates_passed ?? []).length} · ${dry.data.note}`);
    check('J3.9b', 'the dry run left the ledger untouched', (await settlements()) === before, `settlements ${before} → ${await settlements()}`);

    // --- the real buy -----------------------------------------------------------------------------------------------
    const buy = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested, confirm: true, idempotency_key: `adversarial-${AFFORDABLE}-1` }, 'THE BUY: the human said yes');
    check('J3.10', 'buy returns a job handle and an idempotency key instead of blocking', !buy.isError && !!buy.data.job_id && !!buy.data.idempotency_key, `job ${buy.data.job_id} key ${buy.data.idempotency_key}`);
    const done = await pollJob(s, buy.data.job_id, { note: 'the purchase settles' });
    const r = done.data.result ?? {};
    check('J3.11', 'the receipt carries the amount, the scheme, the tx hash and the body', done.data.state === 'done' && !!r.tx_hash && r.body_present === true, `paid ${r.amount} ${r.currency} · ${r.scheme} · tx ${r.tx_hash} · body ${r.body_present}`);
    check('J3.12', 'the session budget went down by exactly the price', String(done.data.result?.budget?.spent ?? '') === String(q.data.total_requested), `spent ${r.budget?.spent} of ${r.budget?.cap}, ${r.budget?.remaining} left`);
    check('J3.13', 'exactly one settlement was written', (await settlements()) === before + 1, `settlements ${before} → ${await settlements()}`);

    // --- attacks AFTER the money moved --------------------------------------------------------------------------------
    const replay = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested, confirm: true, idempotency_key: `adversarial-${AFFORDABLE}-1` }, 'ATTACK: the agent retries the same call');
    check('J3.14', 'the same idempotency key never pays twice', replay.isError && replay.data.error?.code === 'idempotency_replay', `${replay.data.error?.message}`.slice(0, 200));

    const q2 = await s.call('quote', { id: AFFORDABLE }, 're-quote what was already bought');
    check('J3.15', 'a re-quote of something already bought totals 0 and warns', q2.data.total_requested === '0' && (q2.data.warnings ?? []).some((w) => /already bought/.test(w)), `total ${q2.data.total_requested} · ${(q2.data.warnings ?? [])[0]}`);
    const buyAgain = await s.call('buy', { quote_id: q2.data.quote_id, confirm_total: q2.data.total_requested, confirm: true, idempotency_key: `adversarial-${AFFORDABLE}-2` }, 'ATTACK: buy it again with a fresh quote and a fresh key');
    check('J3.16', 'a fresh quote and a fresh key still cannot buy the same knowledge twice', buyAgain.isError && buyAgain.data.error?.code === 'already_purchased', `${buyAgain.data.error?.message}`.slice(0, 200));
    check('J3.17', 'still exactly one settlement after both replay attacks', (await settlements()) === before + 1, `settlements now ${await settlements()}`);

    const rec = await s.call('reconcile_purchase', { id: AFFORDABLE }, 'the recovery path, called without buying anything');
    check('J3.18', 'reconcile reports complete with the tx hash and charges nothing', !rec.isError && rec.data.state === 'complete', `${rec.data.state} · ${rec.data.explanation}`.slice(0, 220));
    const recGhost = await s.call('reconcile_purchase', { id: 'no-such-knowledge-at-all' }, 'reconcile something never bought');
    check('J3.19', 'reconcile on something never paid for says so, safely', !recGhost.isError && recGhost.data.state === 'never_paid', `${recGhost.data.explanation}`.slice(0, 180));

    // --- no secret ever crosses the wire -------------------------------------------------------------------------------
    const status = await s.call('node_status', {}, 'what does the server admit about its own credentials');
    const blob = JSON.stringify(status.data);
    check('J3.20', 'node_status admits a credential exists but never what it is', blob.includes('"operator_configured": true') || status.data.server?.operator_configured === true, `server: ${JSON.stringify(status.data.server)}`);
    check('J3.21', 'the operator password never appears anywhere in the transcript', !blob.includes(PASS), `searched ${blob.length} bytes of node_status`);
    return { transcriptPath: transcript.path };
  } finally {
    await s.close();
  }
}
