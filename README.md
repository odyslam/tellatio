# Tellatio

Tellatio brings your Telegram conversations into [Attio](https://attio.com) — automatically. Think of it as the Telegram equivalent of Attio's built-in email sync.

## What it does

**Automatic sync**: Add Telegram chats to a folder called "Attio" in your Telegram app. Tellatio picks them up and creates rich conversation records in your CRM — no manual data entry.

- **DMs** appear as Notes on the matching Person record, with the full conversation transcript organized by day
- **Group chats** create Notes on every participant's Person record, so each contact's record shows all conversations they were part of
- **New contacts** are automatically created as Person records if they don't already exist in Attio

**CRM fields** updated on every Person record:

| Field | What it shows |
|---|---|
| Telegram Connection | Relationship strength (Very Weak → Very Strong), same scale as Attio's email connection strength |
| Telegram First Interaction | When you first messaged this person |
| Telegram Last Interaction | When you last messaged this person |
| Telegram Message Count | Total messages exchanged |

**Matching**: Contacts are matched to Attio Person records by phone number or Telegram username (stored in a custom "Telegram" attribute on People).

## How to use it

### 1. Choose which chats to track

Open Telegram and create a folder called **Attio**. Drag any DM or group chat into it. That's it — those chats will be synced.

To stop tracking a chat, remove it from the folder.

### 2. Check your Attio records

After the next sync cycle (every 10 seconds), open any Person record in Attio. You'll see:

- A **Note** titled `Telegram · Contact Name` (for DMs) or `Telegram · [Group Name]` (for group chats) containing the full conversation transcript
- The **Telegram Connection** field showing relationship strength
- **First/Last Interaction** dates and **Message Count**

### 3. Add Telegram usernames for better matching

For contacts who don't share their phone number on Telegram, add their username to the **Telegram** field on their Person record in Attio (lowercase, without the @ symbol).

## Agent CLI

Tellatio also includes a command-line tool that lets AI agents interact with Telegram programmatically — reading messages, sending replies, managing groups, scheduling follow-ups, and more.

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
TELEGRAM_FOLDER_NAME=Attio  # or any folder name you prefer
SYNC_INTERVAL_SECONDS=10
DATA_DIR=./data
```

### Run locally

```bash
pnpm dev
```

### Deploy to Railway

The repo includes a Dockerfile. Deploy to Railway and attach a volume at `/data` for persistent sync state.

---

## CLI reference

Full Telegram API for AI agents, built with [incur](https://github.com/wevm/incur). Output defaults to token-efficient TOON, and every command also gets incur's global `--json`, `--format`, `--schema`, `--llms`, `--token-count`, `--token-limit`, and `--token-offset` flags. Run with:

```bash
bun src/cli.ts <command>
```

Chats can be referenced by **username** (`john_doe`), **phone** (`+1234567890`), or **numeric ID**.
Quote multi-word text arguments. Commands that operate on multiple message IDs or users accept comma-separated values.

### Commands

```
me                                              Profile info

chats list [--limit N]                          Recent chats
chats search <query> [--limit N]                Search chats
chats info <chat>                               Chat details
chats folder <name>                             Chats in a folder
chats unread [--limit N]                        Unread inbox
chats activity <folder> [--since X]             Folder activity digest
chats status <user>                             Online status
folders list                                    All folders

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
