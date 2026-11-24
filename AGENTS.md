# Tellatio

- The Telegram CLI is the primary product: `src/cli.ts`, `src/cli/`, `src/shared/`, and `tests/cli/`.
- Use pnpm. `pnpm dev` and `pnpm start` launch the CLI. Discover commands with `pnpm tellatio --help`.
- Only load `docs/sync/` for Attio or worker tasks. Their code lives in `src/integrations/attio/` and `src/sync/`.
- For code changes, run `pnpm typecheck` and the relevant suite (`pnpm test:cli` or `pnpm test:sync`); use `pnpm test` and `pnpm build` for cross-cutting changes. For docs, check links and documented commands.
- For MCP changes, also run `pnpm build && pnpm test:readonly`; see the known failure in `SECURITY.md`.
- Read `SECURITY.md` for safety-sensitive changes, plus `docs/sync/SECURITY.md` for integration changes.
- Validate offline. Do not log in, write to live Telegram/Attio data, or start a sync cycle just to test changes.
- Preserve existing CLI commands, `.env`, `data/`, backups, secrets, and unrelated edits.
