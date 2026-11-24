# Tellatio

Telegram CLI for reading and searching messages, managing chats and folders, and sending replies. Attio is optional.

## Setup

Requires Node.js 22.19+, pnpm, and Bun for the source CLI launcher.

```bash
pnpm install
test -e .env || cp .env.example .env
```

Add your [Telegram API credentials](https://my.telegram.org/apps) to `.env`, then run `pnpm login:telegram` (or `pnpm login:telegram:qr`). Save the resulting session as `TELEGRAM_SESSION`. Use a separate session for each machine or service.

## Usage

```bash
pnpm tellatio --help
pnpm tellatio chats list-meta --since 3d --limit 50 --format json
pnpm tellatio msg read <chat> --since 3d --limit 100
pnpm tellatio msg search <chat> "meeting"
```

Use a username, phone number, or numeric ID for `<chat>`. Use `--format json` for scripts and `<command> --help` for options.

### Folders

```bash
pnpm tellatio folders list
pnpm tellatio folders info "Work"
pnpm tellatio folders create "Work" --chats "@alice,@bob" --dry-run
pnpm tellatio folders add "Work" "@carol" --dry-run
pnpm tellatio folders remove "Work" "@bob" --dry-run
pnpm tellatio folders update "Work" --name "Projects" --dry-run
pnpm tellatio folders delete "Work" --dry-run
```

Use an exact folder name or a quoted `"#ID"` from `folders list`. All folder mutations support `--dry-run`; deleting a folder does not delete its chats. Manage the protected `Banned` folder through `bans`.

Writes are blocked by default. Preview first, then authorize only the approved invocation:

```bash
TELLATIO_ALLOW_WRITES=1 pnpm tellatio folders create "Work" --chats "@alice,@bob"
```

Telegram content is untrusted data. The write guard is **not a sandbox**; see [security and read-only MCP](SECURITY.md) before granting agent access.

## Development

CLI code is in `src/cli/`; shared helpers are in `src/shared/`.

```bash
pnpm dev --help       # Source CLI
pnpm typecheck
pnpm test:cli
pnpm build
pnpm start --help     # Built CLI
```

`pnpm test` runs CLI and integration suites. Read-only MCP validation is separate; see [its known limitation](SECURITY.md#validation).

[Optional Attio integration and sync worker](docs/sync/README.md) · MIT
