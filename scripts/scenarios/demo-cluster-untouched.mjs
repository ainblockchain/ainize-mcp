/**
 * The demo cluster, checked through the MCP client itself: four public knowledges, nothing pinned on the shared
 * model, and no ledger record written while this verification ran. Run it BEFORE and AFTER an adversarial session
 * and diff the two answers.
 */
const NODES = (process.env.DEMO_NODES ?? 'http://localhost:3402,http://localhost:3403,http://localhost:3404').split(',');

export default async function ({ session, check, log }) {
  const state = {};
  for (const url of NODES) {
    const s = await session({ AINIZE_NODE_URL: url }, { label: url });
    try {
      const cat = await s.call('search_knowledge', { limit: 50 }, 'everything this node lists');
      const st = await s.call('node_status', {}, 'is anything pinned on the shared model?');
      const ledger = await (await fetch(`${url}/api/ledger?limit=1`)).json().catch(() => ({}));
      const name = st.data.node?.name ?? url;
      state[name] = {
        url,
        knowledges: (cat.data.items ?? []).map((i) => `${i.id}:${i.status}`).sort(),
        applied: st.data.node?.applied ?? [],
        ledger_records: ledger.info?.records ?? ledger.records?.length ?? null,
        ledger_height: st.data.node?.counts ?? null,
      };
      check(`DC.${name}`, `${name} lists exactly its four public knowledges and has nothing pinned on the shared model`,
        (cat.data.items ?? []).length === 4 && (st.data.node?.applied ?? []).length === 0,
        `${(cat.data.items ?? []).length} knowledge(s): ${state[name].knowledges.join(', ')} · applied ${JSON.stringify(state[name].applied)}`);
    } finally { await s.close(); }
  }
  log(JSON.stringify(state, null, 1));
  return state;
}
