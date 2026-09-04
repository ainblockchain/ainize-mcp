/**
 * The stale quote — the one money attack that cannot be faked: hold an MCP session open past the quote's 10-minute
 * life and then try to settle it. Runs against the private local-ledger cluster; nothing is ever paid.
 */
const NODE = process.env.MONEY_NODE_URL ?? 'http://localhost:4103';
const PASS = process.env.MONEY_NODE_PASSWORD ?? 'mcp-adversarial-b';
const WAIT_MS = Number(process.env.STALE_WAIT_MS ?? 10.5 * 60_000);

const settlements = async () => (await (await fetch(`${NODE}/api/ledger?kind=settle&limit=1000`)).json()).records.length;

export default async function ({ session, check, log }) {
  const before = await settlements();
  const s = await session({ AINIZE_NODE_URL: NODE, AINIZE_OPERATOR_PASSWORD: PASS, AINIZE_MCP_SESSION_BUDGET: '50' }, { label: 'stale-quote' });
  try {
    const cat = await (await fetch(`${NODE}/api/catalog?limit=50`)).json();
    const target = cat.items.find((e) => e.sellable && !e.owned)?.anchor.id;
    const q = await s.call('quote', { id: target }, 'the human is shown a price…');
    check('J3.22', 'the quote states when it stops being valid', !q.isError && typeof q.data.expires_at === 'number', `expires_at ${new Date(q.data.expires_at).toISOString()} (${Math.round((q.data.expires_at - Date.now()) / 1000)} s from now)`);
    log(`holding the session open for ${Math.round(WAIT_MS / 1000)} s so the quote really expires…`);
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const late = await s.call('buy', { quote_id: q.data.quote_id, confirm_total: q.data.total_requested, confirm: true }, 'ATTACK: settle a quote that expired while the human was thinking');
    check('J3.23', 'a genuinely expired quote cannot be settled, and the fix is named', late.isError && late.data.error?.code === 'quote_expired', `${late.data.error?.code}: ${late.data.error?.message}`);
    check('J3.24', 'no money moved while the quote went stale', (await settlements()) === before, `settlements ${before} → ${await settlements()}`);
  } finally {
    await s.close();
  }
}
