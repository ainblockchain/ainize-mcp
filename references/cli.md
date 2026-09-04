# The same jobs from a terminal — `ainize`

Every MCP tool has a CLI sibling. Use these when the user is in a shell, when you need something the tools
deliberately do not expose (verify, challenge, peers, chain), or to show a human how to reproduce what an agent did.
The node serves its own reference at `/docs` and `GET /api/docs` (which carries `CLI_REFERENCE`), and
`ainize --help` works everywhere. `--json` makes any command machine-readable.

| MCP tool | CLI |
|---|---|
| `search_knowledge` | `ainize patch ls [--status LISTED] [--q ticker]` |
| `get_knowledge` | `ainize patch get <id>` |
| `live_test` | `ainize chat <id> "<question>"` (before/after on the same question) |
| `quote` + `buy` | `ainize use <id>` — check → pay → download → load, in one line and **without a quote step**; that missing step is why the MCP tool is two tools |
| `create_training_set` | `ainize teach dataset ./questions.csv` |
| `teach` | `ainize teach dataset ./questions.csv --train --effort quick` · `ainize teach train <dataset-id> --wait` |
| `job_status` (lesson) | `ainize teach status <lesson-url \| job-id>` |
| `download_lesson` | the links printed by `ainize teach status <lesson-id>` |
| `publish_knowledge` | the teach door publishes from `/teach`; an operator registers a ready file with `ainize publish <file.npz> --name … --model … --benchmark <bench.json> [--price]` |
| `apply_knowledge` / `remove_knowledge` | `ainize patch apply <id>` / `ainize patch remove <id>` |
| `my_library` | `ainize patch ls` · `ainize wallet` · `ainize payouts ls` |
| `node_status` | `ainize status` · `ainize status --check` |
| `family_tree` | `ainize ledger graph` · `ainize ledger ls` |

Not exposed as MCP tools at all, on purpose — minutes-long, network-visible or destructive:
`ainize patch verify <id>`, `ainize patch challenge <id> --reason …`, `ainize patch forget <id>`,
`ainize peers`, `ainize chain`, `ainize config`, `ainize keys`, `ainize seed`.

## Credentials, from a terminal

- Operator: `ainize login` writes a session token to `<NGRAM_HOME>/cli.json` at mode 0600; `NGRAM_TOKEN` overrides.
- Teaching key: `<NGRAM_HOME>/teaching-key.json`, `NGRAM_TEACH_KEY`, or `--key-file <backup.json>` (the browser's
  backup file).
- Node identity: `<NGRAM_HOME>/config.json` — it **is** the money. `ainize keys backup` before publishing anything.

The MCP server reads its own copies from its own environment and never accepts, prints or returns any of them.
