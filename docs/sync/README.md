# Optional Attio integration and sync worker

For ordinary Telegram work, use the [CLI guide](../../README.md). This worker copies approved conversations into Attio transcript notes: DMs to People, groups to Companies. People also receive interaction metrics.

## Setup and approval

1. Add the needed settings from [`.env.example`](.env.example) to the existing **root `.env`**; do not replace credentials. Use a dedicated Telegram session, `ATTIO_API_KEY`, and a writable `DATA_DIR` (`./data` locally). The worker does not automatically load this example file.
2. Run `pnpm attio:setup` to create the Attio attributes and association/identity objects.
3. Review chat IDs using `pnpm tellatio chats list-meta`. Preview mappings with `identities reconcile --dry-run` and `associations reconcile --dry-run`; scope them with `--only-chats`.
4. Review destinations, then explicitly approve mappings through `identities upsert` / `associations upsert` with `TELLATIO_ALLOW_WRITES=1` for that invocation. Use `pnpm tellatio <command> --help` for required fields. Associations need a concrete target record ID, `people` or `companies`, status `approved`, and sync mode `transcript`.
5. Start the worker only after approval. It runs immediately, then periodically; the CLI write guard does **not** gate worker writes.

Names, usernames, phone numbers, and profile hints are candidates, not identity proof. Existing approvals are preserved, not re-audited. See [security constraints](SECURITY.md).

## Commands

```bash
pnpm sync:dev                 # Worker from source
pnpm build && pnpm sync:start # Built worker
pnpm sync:once                # One live sync cycle
pnpm tellatio doctor          # Integration diagnostics
pnpm test:sync                # Offline regression suites
```

`pnpm dev` / `pnpm start` launch the **CLI**, not the worker. Update process managers to `pnpm sync:start` or `node dist/sync/main.js`; `src/index.ts` remains a compatibility shim.

Attio CLI handlers live in `src/integrations/attio/`; worker code is in `src/sync/`. Integration commands remain available on `tellatio`.

## Selection and state

- The default source is approved `telegram_associations`; `telegram_identities` maps users to People. Folder membership alone does not approve sync. `folders sync-attio --dry-run` previews aligning a folder with approved associations.
- Manage the no-read/no-sync `Banned` folder through `bans`. Never use it as a sync source.
- Legacy folder mode uses `TELLATIO_SYNC_SOURCE=folder` and `TELEGRAM_FOLDER_NAME`. Auto-creation and folder fallback remain opt-in; leave them disabled unless intended.
- `SYNC_INTERVAL_SECONDS` overrides `SYNC_INTERVAL_MINUTES` (default 15). Cycles do not overlap.
- State lives in `<DATA_DIR>/sync-state.db`. First startup imports legacy `sync-state.json` and retains it as `sync-state.json.imported-<timestamp>`. Do not run an older JSON-based build against migrated state; preserve the data directory and backups.
- `<NAME>_FILE` overrides `<NAME>` for Telegram credentials and `ATTIO_API_KEY`. Keep secret files owner-readable only (`600`) and state directories owner-only (`700`).

## Deployment

From the repository root:

```bash
docker build -f deploy/sync/Dockerfile -t tellatio-sync .
docker compose -f deploy/sync/docker-compose.yml config
```

For Railway, use that Dockerfile with the repository root as build context and a persistent `/data` volume. Docker builds also run the read-only test; its [known failure](../../SECURITY.md#validation) remains unresolved.

The Compose/iron-proxy files are **reference examples**, not a ready deployment. Supply credentials and secret files (examples resolve under root `secrets/`), pin trusted images, and verify the policy schema and enforcement. The example starts in `warn` mode. An HTTP proxy does not restrict Telegram MTProto or establish a keyless worker; see [security](SECURITY.md).
