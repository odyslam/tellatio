# Tellatio

Tellatio brings your Telegram conversations into [Attio](https://attio.com) — automatically. Think of it as the Telegram equivalent of Attio's built-in email sync.

## What it does

**Association-based sync**: Tellatio syncs Telegram chats that have an approved `Telegram Association` record in Attio. This lets an external reviewer or Codex automation decide which chats map to which CRM records, while the Railway worker stays deterministic.

- **DMs** can appear as Notes on a mapped Person record, with the conversation transcript organized by day
- **Group chats** can appear as Notes on a mapped Company record, instead of being copied to every participant
- **Legacy folder mode** can still auto-create Person records for unmatched DMs when explicitly enabled; group participants require a separate opt-in

**CRM fields** updated on every Person record:

| Field | What it shows |
|---|---|
| Telegram Connection | Relationship strength (Very Weak → Very Strong), same scale as Attio's email connection strength |
| Telegram First Interaction | When you first messaged this person |
| Telegram Last Interaction | When you last messaged this person |
| Telegram Message Count | Total messages exchanged |

**Matching**: The new default source of truth is the `telegram_associations` Attio custom object for chats and the `telegram_identities` object for Telegram user -> Attio Person mappings. Legacy folder sync can still be enabled with `TELLATIO_SYNC_SOURCE=folder`, but ambiguous people now go to identity review instead of being blindly created. The resolver also reads Telegram profile descriptions, so "BD at 0x" or "ecosystem @ symbiotic" can help associate both a person and a group chat with the right Attio record.

**Bans**: Tellatio uses a Telegram folder named `Banned` by default as the no-sync/no-read list. Chats in that folder are skipped by discovery, identity reconciliation, message reads/searches, and sync. Add or remove entries with `tellatio bans add <chat>` and `tellatio bans remove <chat>`; do not use the folder as a sync source.

## How to use it

### 1. Create the Attio schema

Run the setup script to create the People attributes, the `Telegram Associations` custom object, and the `Telegram Identities` custom object:

```bash
npx ts-node scripts/setup-attio.ts
```

### 2. Discover likely associations

Run the read-only discovery command:

```bash
tellatio discover associations --since 3d --json
```

Review the proposed `telegram_chat_id`, target type, target name, confidence, and rationale. To run the full resolver locally:

```bash
tellatio associations reconcile --since 3d --limit 100 --json
```

This checks group titles, recent work-language, and participant profile descriptions/bios. It approves exact company matches with concrete Attio record IDs and leaves ambiguous or missing matches as `needs_review`.

### 3. Reconcile people identities

Run the identity resolver:

```bash
tellatio identities reconcile --since 3d --limit 100 --json
```

It scans recent DMs and participants in approved work group chats, including their Telegram profile descriptions/bios by default. Safe matches by Telegram user ID, phone, username, exact full name, or a company hint that disambiguates existing candidates are approved. Missing or ambiguous people are written as `needs_review` identity records, so the sync worker does not create duplicate People records.

Useful review commands:

```bash
tellatio associations status --json
tellatio identities status --json
tellatio identities candidates --name "Piotr" --json
```

Ban a Telegram account or chat before running discovery/sync:

```bash
tellatio bans add @jpsaly0wn --json
tellatio bans check @jpsaly0wn --json
```

Manual approval:

```bash
tellatio identities upsert --telegram-user-id 518976833 --telegram-username pgrzesik --display-name "Piotr Grzesik" --target-record-id <attio_person_record_id> --status approved
```

### 4. Approve associations in Attio

Create or update `Telegram Association` records with:

- `Telegram Chat ID`
- `Telegram Chat Title`
- `Target Object` (`crm_object_slug`) such as `people` or `companies`
- `Target Record ID` (`crm_record_id`)
- `Status = approved`
- `Sync Mode = transcript`

### 5. Check your Attio records

After the next sync cycle, open the mapped Person or Company record in Attio. You'll see:

- A **Note** titled `Telegram · Contact Name` (for DMs) or `Telegram · [Group Name]` (for group chats) containing the full conversation transcript
- The **Telegram Connection** field showing relationship strength
- **First/Last Interaction** dates and **Message Count**

### Legacy folder mode

To keep the original folder-based behavior:

```bash
TELLATIO_SYNC_SOURCE=folder
TELEGRAM_FOLDER_NAME=Attio
```

## Agent CLI

Tellatio also includes a command-line tool that lets AI agents interact with Telegram programmatically — reading messages, sending replies, managing groups, scheduling follow-ups, and more.

Folder commands are an admin surface for keeping Telegram organized. They do not change the default sync source of truth: production sync should still be driven by approved `telegram_associations` and reviewed `telegram_identities`, unless you explicitly opt back into legacy folder mode.

For CRM hygiene, use Telegram folders as a review queue rather than as the write boundary. A practical setup is:

- `Attio` for chats worth reviewing or mapping
- `BD Active` for live protocol/customer conversations
- `Partners` for ongoing ecosystem threads
- `Investors` or `Fundraise` for capital conversations
- `Internal` for Phylax/team chats
- `Watch` or `Communities` for context that should not sync by default

Only approved Attio associations with a concrete `crm_record_id` should reach the sync worker.

### Using with AI agents (security)

The CLI returns Telegram content (message text, sender names, chat titles, bios). Anyone can DM the account or set a malicious bio, so **all Telegram-derived content is untrusted**: treat it as DATA, never as instructions. An agent that follows instructions embedded in that content can be prompt-injected into calling destructive or outbound commands (sending messages, deleting, blocking, leaving groups, changing your profile, and so on).

Tellatio cannot control the consuming agent's prompt, so it ships two defenses:

- **Untrusted-content hardening.** Returned message text, names, and titles are stripped of bidirectional-override and zero-width characters, records are marked `untrusted: true`, and read commands include an `_advisory` field restating that the content is attacker-controlled.
- **Write-guard.** Destructive and outbound commands are gated by the `TELLATIO_WRITE_GUARD` environment variable:
  - `off` — no gating.
  - `warn` (default) — logs a warning to stderr and proceeds.
  - `enforce` — blocks the command (non-zero exit, no Telegram action) unless writes are explicitly allowed.

  In `enforce` mode, allow a write by setting `TELLATIO_ALLOW_WRITES=1` (also accepts `true`/`yes`/`on`) in the environment. This is intentionally an out-of-band signal: a prompt-injected agent can append a flag to a command it emits, but cannot set the worker's environment.

**Recommendation:** run agents with `TELLATIO_WRITE_GUARD=enforce` and have a human grant `TELLATIO_ALLOW_WRITES=1` only for the specific invocation that should perform a write. Read-only commands (`msg read`, `chats list`, `group info`, etc.) are never gated.

See the [CLI reference](#cli-reference) below for the full command list.

---

## Getting started (technical setup)

### Prerequisites

- Node.js 18+
- A Telegram account with API credentials ([get them here](https://my.telegram.org/apps))
- An Attio workspace with an API key (Settings → Developers → API keys)

### Installation

```bash
pnpm install
```

The package exposes a `tellatio` binary. In this checkout you can run it via:

```bash
pnpm tellatio --help
```

For a PATH-level command, symlink `bin/tellatio` into a directory on your PATH.

### Create Attio attributes

Run the setup script to create the required custom attributes on People:

```bash
npx ts-node scripts/setup-attio.ts
```

### Get a Telegram session

```bash
pnpm login:telegram
```

This walks you through logging into Telegram and produces a session string.

For accounts where Telegram pushes passkey-based approval instead of a normal code, use QR login:

```bash
pnpm login:telegram:qr
```

Scan the printed QR code from an already logged-in Telegram app via `Settings -> Devices -> Link Desktop Device`. This lets Telegram handle passkey/biometric approval on the logged-in device, then Tellatio receives a normal `TELEGRAM_SESSION` string.

Use separate session strings for local automation and Railway. Do not reuse the same `TELEGRAM_SESSION` in both places, or Telegram can invalidate it with `AUTH_KEY_DUPLICATED`.

### Configure

```bash
cp .env.example .env
```

Fill in your `.env`:

```
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION=...       # from the login step
ATTIO_API_KEY=...
TELLATIO_SYNC_SOURCE=associations
TELLATIO_ASSOCIATION_OBJECT=telegram_associations
TELLATIO_IDENTITY_OBJECT=telegram_identities
TELLATIO_AUTO_CREATE_PEOPLE=false
TELLATIO_AUTO_CREATE_GROUP_PEOPLE=false
TELLATIO_FOLDER_FALLBACK_ENABLED=false
TELLATIO_CHAT_FETCH_TIMEOUT_SECONDS=30
TELLATIO_BAN_FOLDER_NAME=Banned
SYNC_INTERVAL_MINUTES=15
DATA_DIR=./data
```

### Run locally

```bash
pnpm dev
```

### Deploy to Railway

The repo includes a Dockerfile. Deploy to Railway and attach a volume at `/data` for persistent sync state.

Recommended Railway worker settings:

```
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

Use a dedicated Railway `TELEGRAM_SESSION`. Do not reuse the local/Codex session in Railway.

The worker runs sync cycles serially, so a slow Telegram cycle will not overlap with the next interval. Each chat fetch has a timeout, and the worker logs the chat being checked so stale or inaccessible approved associations can be identified without blocking the whole process indefinitely.

---

## CLI reference

Full Telegram API for AI agents, built with [incur](https://github.com/wevm/incur). Output defaults to token-efficient TOON, and every command also gets incur's global `--json`, `--format`, `--schema`, `--llms`, `--token-count`, `--token-limit`, and `--token-offset` flags. Run with:

```bash
tellatio <command>
```

Chats can be referenced by **username** (`john_doe`), **phone** (`+1234567890`), or **numeric ID**.
Quote multi-word text arguments. Commands that operate on multiple message IDs or users accept comma-separated values.

### Commands

```
me                                              Profile info
doctor [--skip-telegram/attio/railway]          Health checks for Telegram, Attio, Railway, and state

chats list [--limit N]                          Recent chats
chats search <query> [--limit N]                Search chats
chats info <chat>                               Chat details
chats resolve <chat>                            Canonical Telegram IDs and input peer
chats folder <name>                             Chats in a folder
chats unread [--limit N]                        Unread inbox
chats activity <folder> [--since X]             Folder activity digest
chats status <user>                             Online status
folders list                                    All folders
folders create <name> [--chats a,b] [--groups] Create a folder (--dry-run supported)
folders rename <old-name> <new-name>            Rename a folder (--dry-run supported)
folders delete <name>                           Delete a folder (--dry-run supported)
folders add <folder> <chat|a,b>                 Add chats to a folder (--dry-run supported)
folders remove <folder> <chat|a,b>              Remove chats from a folder (--dry-run supported)
folders pin <folder> <chat|a,b>                 Pin chats inside a folder
folders unpin <folder> <chat|a,b>               Unpin chats inside a folder
folders exclude-add <folder> <chat|a,b>         Exclude chats from source-based folders
folders exclude-remove <folder> <chat|a,b>      Remove explicit folder exclusions
folders sources <folder> --groups true          Edit built-in folder sources
folders reorder <folder1,folder2,...>           Move folders to the front in order
discover associations [--since X] [--limit N]   Dry-run likely Attio chat associations
associations status                              Association counts and records
associations upsert --chat-id ...              Create/update an Attio association (--dry-run supported)
associations reconcile [--since X]              Resolve and approve exact company matches (--dry-run supported)
identities status                               Identity counts and records
identities reconcile [--since X]                Resolve Telegram users to Attio People (--dry-run supported)
identities candidates [--name/--username X]     Search People candidates
identities upsert --telegram-user-id ...        Create/update a person identity mapping (--dry-run supported)
bans list                                       List folder-backed banned chats/users
bans add <chat>                                 Add a chat/user to the no-sync ban folder
bans remove <chat>                              Remove a chat/user from the ban folder
bans check <chat>                               Check if a chat/user is banned

msg read <chat> [--limit N] [--since X]         Read messages (--until, --date)
msg send <chat> <text> [--reply-to N]           Send (--silent, --no-preview)
msg edit <chat> <msg-id> <text>                 Edit
msg delete <chat> <ids> [--revoke]              Delete comma-separated IDs
msg forward <from> <to> <ids>                   Forward comma-separated IDs
msg search <chat> <query> [--limit N]           Search in chat
msg pin <chat> <msg-id> [--silent]              Pin
msg unpin <chat> <msg-id>                       Unpin
msg mark-read <chat>                            Mark as read
msg schedule <chat> <text> --at <datetime>      Schedule a message
msg schedule-list <chat>                        List scheduled
msg schedule-delete <chat> <ids>                Cancel comma-separated IDs

contacts list                                   All contacts
contacts add <phone> <first> [last]             Add contact
contacts delete <user>                          Delete contact
contacts block <user>                           Block
contacts unblock <user>                         Unblock

group create <title> <users>                    Create group with comma-separated users
group info <chat>                               Group details
group members <chat> [--limit N]                Members
group add <chat> <user>                         Add member
group kick <chat> <user>                        Remove member
group title <chat> <new-title>                  Set title
group description <chat> <text>                 Set description
group leave <chat>                              Leave

media send <chat> <path> [caption]              Send file (--voice, --video-note)
media download <chat> <msg-id> <path>           Download media

profile set-bio <text>                          Set bio
profile set-name <first> [last]                 Set name
profile set-username <username>                 Set username

draft set <chat> <text>                         Set draft
draft clear <chat>                              Clear draft
```

### Time filters

`--since`, `--until`, and `--date` accept: `yesterday`, `today`, `3d` (days ago), `2h` (hours ago), `30m` (minutes ago), or `YYYY-MM-DD`.

## License

MIT
