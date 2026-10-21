<div align="center">

# Tellatio

**Your Telegram CLI. Your Telegram → Attio sync.**

Read and manage Telegram from your terminal, then sync approved conversations to the right CRM records.

[Quick start](#quick-start) · [Telegram CLI](#telegram-cli) · [Attio sync](#attio-sync) · [Deployment](#deployment) · [Security](#security)

</div>

---

## Two tools, one repo

| | Telegram CLI | Attio sync worker |
| :--- | :--- | :--- |
| **Use it for** | Terminal workflows, scripts, and AI agents | Telegram relationship history in [Attio](https://attio.com) |
| **You can** | Read and search messages, send replies, manage groups and folders, schedule messages, and download media | Sync DMs to People and group conversations to Companies, with transcript Notes and Person interaction stats |
| **Run it with** | `pnpm tellatio <command>` | `pnpm dev`, or deploy the Docker worker |
| **Control scope with** | Metadata-only review, a no-read ban list, and an outbound/destructive write guard | Approved chat associations and reviewed identity mappings |

Use the Telegram CLI on its own. Add Attio credentials when you want CRM commands or the sync worker.

## Quick start

### 1. Install

You'll need **Node.js 22.19+**, **pnpm**, and **Bun** for the CLI launcher. Get Telegram API credentials from [my.telegram.org/apps](https://my.telegram.org/apps). For Attio sync, you'll also need an Attio workspace API key from **Settings → Developers → API keys**.

```bash
git clone https://github.com/odyslam/tellatio.git
cd tellatio
pnpm install
cp .env.example .env
```

### 2. Connect Telegram

Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `.env`, then log in:

```bash
pnpm login:telegram
```

Copy the session string into `TELEGRAM_SESSION` in `.env`. If Telegram asks for passkey approval, use QR login:

```bash
pnpm login:telegram:qr
```

Scan the QR code from an authenticated Telegram app under **Settings → Devices → Link Desktop Device**. Telegram handles passkey or biometric approval on that device.

> **Keep sessions separate.** Generate distinct session strings for local automation and Railway. Reusing one session in both places can cause Telegram to invalidate it with `AUTH_KEY_DUPLICATED`.

### 3. Try the CLI

```bash
pnpm tellatio --help
pnpm tellatio chats list-meta --since 3d --limit 50 --format json
```

For a `tellatio` command on your `PATH`, symlink `bin/tellatio` into a directory on your `PATH`. The examples below use that shorthand.

To enable CRM sync, add `ATTIO_API_KEY` to `.env` and follow [Attio sync](#attio-sync) before starting the worker.

## Telegram CLI

Use Tellatio from your terminal or an agent workflow. The CLI uses [incur](https://github.com/wevm/incur), defaults to token-efficient TOON output, and supports JSON for scripts.

### Everyday commands

```bash
# Review recent activity without message bodies or profile bios
tellatio chats list-meta --since 3d --limit 100 --format json
tellatio chats unread-meta --since 3d --limit 100 --format json

# Read and search a conversation
tellatio msg read <chat> --since 3d --limit 100 --format json
tellatio msg search <chat> "meeting" --limit 20 --format json

# Inspect a group or your folders
tellatio group info <chat>
tellatio folders list
```

Reference chats by **username**, **phone number**, or **numeric ID**. Quote multi-word text arguments; use comma-separated values for commands that accept multiple message IDs or users.

**Time filters:** `--since`, `--until`, and `--date` accept `today`, `yesterday`, `3d`, `2h`, `30m`, or `YYYY-MM-DD`, where the command supports that filter.

**Output controls:** incur provides `--json`, `--format`, `--schema`, `--llms`, `--token-count`, `--token-limit`, and `--token-offset`. Use `tellatio <command> --help` for command-specific options.

> **Using an AI agent?** Telegram text, names, titles, and bios are untrusted input. Set `TELLATIO_WRITE_GUARD=enforce` in the invoking environment before giving an agent access. See [Agent safety](#agent-safety) for the guard's scope and limits.

### CLI reference

<details>
<summary><strong>Expand the command reference</strong></summary>

```text
me                                               Profile info
doctor [--skip-telegram/attio/railway]           Health checks for Telegram, Attio, Railway, and state

chats list [--limit N]                           Recent chats
chats list-meta [--limit N]                      Recent chats without message text
chats search <query> [--limit N]                 Search chats
chats info <chat>                                Chat details
chats resolve <chat>                             Canonical Telegram IDs and input peer
chats folder <name>                              Chats in a folder
chats unread [--limit N]                         Unread inbox
chats unread-meta [--limit N]                    Unread inbox without message text
chats activity <folder> [--since X]              Folder activity digest
chats status <user>                              Online status
folders list                                     All folders
folders create <name> [--chats a,b] [--groups] Create a folder (--dry-run supported)
folders rename <old-name> <new-name>             Rename a folder (--dry-run supported)
folders delete <name>                            Delete a folder (--dry-run supported)
folders add <folder> <chat|a,b>                  Add chats to a folder (--dry-run supported)
folders remove <folder> <chat|a,b>               Remove chats from a folder (--dry-run supported)
folders pin <folder> <chat|a,b>                  Pin chats inside a folder
folders unpin <folder> <chat|a,b>                Unpin chats inside a folder
folders exclude-add <folder> <chat|a,b>          Exclude chats from source-based folders
folders exclude-remove <folder> <chat|a,b>       Remove explicit folder exclusions
folders sources <folder> --groups true           Edit built-in folder sources
folders reorder <folder1,folder2,...>            Move folders to the front in order
folders sync-attio [--folder Attio]              Add approved association chats to the Attio folder
discover associations [--since X] [--limit N]    Dry-run likely Attio chat associations
associations status                              Association counts and records
associations upsert --chat-id ...                Create/update an Attio association (--dry-run supported)
associations reconcile [--since X]               Resolve and approve exact company matches (--dry-run supported)
identities status                                Identity counts and records
identities reconcile [--since X]                 Resolve Telegram users to Attio People (--dry-run supported)
identities candidates [--name/--username X]      Search People candidates
identities upsert --telegram-user-id ...         Create/update a person identity mapping (--dry-run supported)
bans list                                        List folder-backed banned chats/users
bans add <chat>                                  Add a chat/user to the no-sync ban folder
bans remove <chat>                               Remove a chat/user from the ban folder
bans check <chat>                                Check if a chat/user is banned

msg read <chat> [--limit N] [--since X]          Read messages (--until, --date)
msg send <chat> <text> [--reply-to N]            Send (--silent, --no-preview)
msg edit <chat> <msg-id> <text>                  Edit
msg delete <chat> <ids> [--revoke]               Delete comma-separated IDs
msg forward <from> <to> <ids>                    Forward comma-separated IDs
msg search <chat> <query> [--limit N]            Search in chat
msg pin <chat> <msg-id> [--silent]               Pin
msg unpin <chat> <msg-id>                        Unpin
msg mark-read <chat>                             Mark as read
msg schedule <chat> <text> --at <datetime>       Schedule a message
msg schedule-list <chat>                         List scheduled
msg schedule-delete <chat> <ids>                 Cancel comma-separated IDs

contacts list                                    All contacts
contacts add <phone> <first> [last]              Add contact
contacts delete <user>                           Delete contact
contacts block <user>                            Block
contacts unblock <user>                          Unblock

group create <title> <users>                     Create group with comma-separated users
group info <chat>                                Group details
group members <chat> [--limit N]                 Members
group add <chat> <user>                          Add member
group kick <chat> <user>                         Remove member
group title <chat> <new-title>                   Set title
group description <chat> <text>                  Set description
group leave <chat>                               Leave

media send <chat> <path> [caption]               Send file (--voice, --video-note)
media download <chat> <msg-id> <path>            Download media

profile set-bio <text>                           Set bio
profile set-name <first> [last]                  Set name
profile set-username <username>                  Set username

draft set <chat> <text>                          Set draft
draft clear <chat>                               Clear draft
```

</details>

## Attio sync

Sync approved Telegram conversations into Attio, much like an email integration. Choose the destination record for each chat instead of copying group messages to each participant.

| Telegram source | Attio destination | Synced content |
| :--- | :--- | :--- |
| **Direct message** | A mapped **Person** | A transcript Note, relationship strength, first/last interaction, and message count |
| **Group chat** | A mapped **Company** | A transcript Note for the group |

Transcript Notes use the title `Telegram · <chat title>` and organize messages by day. On mapped People, Tellatio updates these fields:

| Field | Meaning |
| :--- | :--- |
| **Telegram Connection** | Relationship strength, from Very Weak to Very Strong |
| **Telegram First Interaction** | First recorded interaction |
| **Telegram Last Interaction** | Most recent recorded interaction |
| **Telegram Message Count** | Recorded messages exchanged |

### Review → map → sync

The default sync source is the Attio `telegram_associations` custom object. Use `telegram_identities` to map Telegram users to Attio People. An external reviewer or agent can propose mappings; the worker syncs approved associations with concrete CRM record IDs.

**1. Create the Attio schema**

With `ATTIO_API_KEY` in `.env`, run:

```bash
pnpm exec ts-node scripts/setup-attio.ts
```

This creates the People attributes and the **Telegram Associations** and **Telegram Identities** custom objects.

**2. Review recent chat metadata**

```bash
tellatio chats list-meta --since 3d --limit 250 --format json
tellatio chats unread-meta --since 3d --limit 250 --format json
```

Review exact chat IDs and a timeframe before fetching message bodies, profile bios, or group participants.

**3. Resolve identities, then associate chats**

Replace `<chat_ids>` with the comma-separated IDs you approved:

```bash
tellatio identities reconcile --since 3d --limit 100 --only-chats <chat_ids> --include-explicit-groups --participant-limit 30 --format json
tellatio associations reconcile --since 3d --limit 100 --only-chats <chat_ids> --format json
```

Use `--include-explicit-groups` with `--only-chats` to scope participant scans to reviewed groups that lack approved associations.

Identity matching uses Telegram user IDs, phone numbers, usernames, exact full names, and company context. Missing or ambiguous matches go to `needs_review` instead of creating duplicate People. Approved identity mappings and Person email domains take precedence over title-based company guesses; conflicting evidence leaves an association in review. Exact company matches still need a concrete Attio record ID before approval.

Reconciliation can write mappings to Attio. Use `--dry-run` to preview supported commands before applying changes.

```bash
tellatio identities status --json
tellatio identities candidates --name "Alex" --json
tellatio associations status --json
```

To approve a Person mapping by hand:

```bash
tellatio identities upsert --telegram-user-id <telegram_user_id> --telegram-username <username> --display-name "Alex Example" --target-record-id <attio_person_record_id> --status approved
```

**4. Approve the chat destination in Attio**

Create or update the **Telegram Association** record:

| Attribute | Value |
| :--- | :--- |
| Telegram Chat ID | The reviewed chat's ID |
| Telegram Chat Title | The chat's title |
| Target Object (`crm_object_slug`) | `people` or `companies` |
| Target Record ID (`crm_record_id`) | The destination Attio record ID |
| Status | `approved` |
| Sync Mode | `transcript` |

**5. Start the worker**

Set `DATA_DIR=./data` in `.env` for local use, then run:

```bash
pnpm dev
```

The worker runs a sync cycle on startup, then waits between cycles. Open the mapped Person or Company in Attio to check the transcript Note and, for People, the interaction fields.

### Matching configuration

Tellatio has no built-in customer, partner, or internal-company names. Configure your own names and aliases in `.env`:

```dotenv
TELLATIO_OWN_COMPANY_NAMES=Acme,Acme Labs
TELLATIO_COMPANY_ALIASES={"example protocol":"Example Protocol Labs"}
```

Own-company names help infer the counterparty in titles such as `Acme <> Example Protocol` and exclude your own organization from bio-based matching. Alias keys are normalized informal names; values are canonical CRM company names. Leave these settings empty or `{}` if you do not need them.

### Folders and the no-read ban list

Use Telegram folders as review queues. For example, keep candidate chats in `Attio`, current conversations in `BD Active`, and broader context in `Watch`. Folder membership does **not** approve a chat for sync.

To align the `Attio` folder with approved associations:

```bash
tellatio folders sync-attio --dry-run
tellatio folders sync-attio
```

Tellatio uses a folder named **Banned** as its no-sync/no-read list. Chats in it are excluded from discovery, identity reconciliation, message reads/searches, and sync. Use the ban commands to manage it; do not use it as a sync source.

```bash
tellatio bans add <chat> --json
tellatio bans check <chat> --json
tellatio bans remove <chat> --json
```

<details>
<summary><strong>Legacy folder-based sync</strong></summary>

To opt into the original folder-based sync behavior, set:

```dotenv
TELLATIO_SYNC_SOURCE=folder
TELEGRAM_FOLDER_NAME=Attio
```

Unmatched DMs can create People only if you enable `TELLATIO_AUTO_CREATE_PEOPLE=true`. Creating People from group participants also requires `TELLATIO_AUTO_CREATE_GROUP_PEOPLE=true`. Both default to `false`.

</details>

## Deployment

### Worker configuration

Copy `.env.example` for the full configuration. These settings keep the worker scoped to approved associations:

```dotenv
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION=...
ATTIO_API_KEY=...

TELLATIO_SYNC_SOURCE=associations
TELLATIO_ASSOCIATION_OBJECT=telegram_associations
TELLATIO_IDENTITY_OBJECT=telegram_identities
TELLATIO_AUTO_CREATE_PEOPLE=false
TELLATIO_AUTO_CREATE_GROUP_PEOPLE=false
TELLATIO_FOLDER_FALLBACK_ENABLED=false
TELLATIO_DISCOVERY_DIALOG_LIMIT=1000
TELLATIO_CHAT_FETCH_TIMEOUT_SECONDS=30
TELLATIO_BAN_FOLDER_NAME=Banned
SYNC_INTERVAL_SECONDS=900
DATA_DIR=/data
```

`SYNC_INTERVAL_SECONDS` takes precedence over `SYNC_INTERVAL_MINUTES` (default: 15). Sync cycles run without overlap; per-chat timeouts prevent one stale or inaccessible association from blocking a cycle without a time limit.

### Railway and Docker

Deploy the included `Dockerfile` to Railway and attach a persistent volume at `/data`. Use a **dedicated Telegram session** for the worker, separate from your local or agent session.

For a Node-based production run outside Docker:

```bash
pnpm build
pnpm start
```

### Persistent state

Tellatio stores sync state in `<DATA_DIR>/sync-state.db` using SQLite WAL mode with incremental writes. On first start, it imports an existing `sync-state.json` and renames the source to `sync-state.json.imported-<timestamp>` as a backup.

Use `tellatio doctor` to inspect the database path, schema version, and migration status. Do not run an older JSON-based build against a migrated data directory.

## Security

### Agent safety

Treat Telegram-derived messages, names, chat titles, and bios as **data, not instructions**. Anyone who can message the account or change a profile can supply attacker-controlled text.

Tellatio strips bidirectional-override and zero-width characters from output strings, marks Telegram-derived records with `untrusted: true`, and adds an `_advisory` to high-risk read output. These measures help consumers identify untrusted content; they do not prevent prompt injection on their own.

The CLI write guard covers gated outbound and destructive Telegram operations:

| `TELLATIO_WRITE_GUARD` | Behavior |
| :--- | :--- |
| `off` | No write gating |
| `warn` | Explicit unsafe compatibility mode: warn and proceed |
| `enforce` **(default)** | Block gated operations unless `TELLATIO_ALLOW_WRITES` permits them |
| Unrecognized value | Reject writes, even with `TELLATIO_ALLOW_WRITES` |

Set `TELLATIO_WRITE_GUARD=enforce` in the invoking environment. Have a human grant `TELLATIO_ALLOW_WRITES=1` for a specific approved invocation. The values `true`, `yes`, and `on` also permit writes. Read-only commands and supported `--dry-run` previews do not require this permission.

**The guard is not a sandbox.** An agent with shell or environment control may set the permission variable itself. Keep approval and credential controls outside the agent's control when you need a hard boundary. Attio reconciliation/upsert writes and media downloads are also gated; dry-run previews remain available. The unattended worker is separate and continues approved sync writes.

### Read-only agents and media confinement

Use `bin/tellatio-readonly --mcp` for agents that only need to inspect Telegram. Its MCP tool list contains only `me`, `chats`, `info`, `read`, and `search`; changing write-guard environment variables cannot add write tools to this server. The full CLI remains available for explicitly approved operations.

**For a real host boundary**, expose only that read-only MCP process from a container or separate OS account. Do not give the consuming agent a host shell, the session files, the full CLI, or writable access to this repository. A same-user shell can bypass application guards by reading credentials directly. Example, after building the image, with a private env file containing only the required Telegram credentials:

```bash
docker run --rm -i --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user node --tmpfs /tmp --env-file /secure/telegram-readonly.env \
  tellatio node dist/cli-readonly.js --mcp
```

No home-directory, Docker-socket, or host-repository mounts should be added. Telegram sessions themselves are not read-only credentials; protect the container and its host. This setup is a supported option, not an assertion that your agent is already isolated.

Media commands now accept a **single non-hidden file name**, not a path. Uploads read only regular, non-symlink, non-hardlinked files placed in `<DATA_DIR>/uploads/`. Downloads create new owner-only files in `<DATA_DIR>/downloads/`, never overwrite existing files, and reject symlinks. Both have a fixed 25 MiB limit. Put only files you intend to share in `uploads/`; downloaded content is never automatically opened or executed. Both operations require write permission.

Synced CRM transcripts are explicitly marked untrusted, with remote Markdown/HTML escaped and message lines quoted. This prevents formatting from forging transcript structure; it does not make instructions inside messages trustworthy. Existing notes acquire the new rendering on their next transcript update, not retroactively at deployment.

### Secrets

Protect `TELEGRAM_SESSION`, `ATTIO_API_KEY`, and the Telegram API credentials. The **sync worker** supports file-based secrets for `TELEGRAM_SESSION`, `ATTIO_API_KEY`, `TELEGRAM_API_HASH`, and `TELEGRAM_API_ID`:

```dotenv
TELEGRAM_SESSION_FILE=/run/secrets/telegram_session
ATTIO_API_KEY_FILE=/run/secrets/attio_api_key
```

`<NAME>_FILE` takes precedence over `<NAME>`; the worker reads and trims the file. The CLI also accepts these file-based secrets; the Attio setup script uses environment variables. Do not commit credentials or session strings. Keep secret files owner-readable only (`chmod 600`), and state/export directories owner-only (`chmod 700`). New state databases and media files are private by default.

<details>
<summary><strong>Optional egress hardening with iron-proxy</strong></summary>

`docker-compose.yml` and `iron.policy.yaml` are **reference examples, not a turnkey deployment**. Pin a trusted image, supply real secret files, check the policy schema against your iron-proxy version, and verify enforcement before use. The example policy starts in `warn` mode.

The example routes worker HTTP requests through `HTTPS_PROXY=http://iron:8080` using an undici `ProxyAgent`. Its intended policy allows Attio API access and supports Bearer-key injection at the proxy. The worker still requires an Attio credential value under its current configuration loader; this example does not prove a keyless-worker deployment.

Telegram uses MTProto, so an HTTP proxy cannot inject the Telegram session. Load it from a secret file, and enforce any Telegram data-center egress restrictions at the network layer. A compromised worker can use its loaded session on permitted connections; rotate the session after a host compromise.

The Compose worker runs as `node` with a read-only root filesystem and a writable `/data` volume. On Railway, adapt proxy and secret-file settings to your deployment and verify the network restrictions.

</details>

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

| Path | Responsibility |
| :--- | :--- |
| `src/cli.ts` | CLI executable entrypoint |
| `src/cli/registry.ts` | Command tree and options |
| `src/cli/commands.ts` | Command implementations |
| `src/cli/runtime.ts` | CLI environment, connections, output, state, bans, and write guarding |
| `src/index.ts` | Sync worker entrypoint |
| `src/sync.ts` | Telegram → Attio sync |
| `scripts/setup-attio.ts` | Attio schema setup |

## License

MIT
