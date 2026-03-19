# Tellatio

Telegram-to-Attio sync service + Telegram CLI for agents.

## Setup

```bash
pnpm install
pnpm login:telegram    # get a session string (interactive)
cp .env.example .env   # fill in credentials
```

## Sync Service

Runs continuously, syncing Telegram chats from an "Attio" folder to Attio Person records.

```bash
pnpm dev               # run locally
pnpm start             # run from compiled JS (production)
```

Deployed on Railway with a persistent volume at `/data` for sync state.

### What it syncs

- DMs and group chats added to the "Attio" folder in Telegram
- One Note per chat per person, continuously updated with full transcript
- Connection strength, first/last interaction dates, message counts
- Auto-creates Person records for unmatched contacts

## CLI

Full Telegram API for agents. All output is JSON.

```bash
bun src/cli.ts <command>
# or
pnpm tellatio <command>
```

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
msg delete <chat> <id> [id...] [--revoke]       Delete
msg forward <from> <to> <id> [id...]            Forward
msg search <chat> <query> [--limit N]           Search in chat
msg pin <chat> <msg-id> [--silent]              Pin
msg unpin <chat> <msg-id>                       Unpin
msg mark-read <chat>                            Mark as read
msg schedule <chat> <text> --at <datetime>      Schedule a message
msg schedule-list <chat>                        List scheduled
msg schedule-delete <chat> <id> [id...]         Cancel scheduled

contacts list                                   All contacts
contacts add <phone> <first> [last]             Add contact
contacts delete <user>                          Delete contact
contacts block <user>                           Block
contacts unblock <user>                         Unblock

group create <title> <user> [user...]           Create group
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

### Identifying chats

`<chat>` can be a username (`john_doe`), phone (`+1234567890`), or numeric ID.

### Time filters

`--since`, `--until`, `--date` accept: `yesterday`, `today`, `Nd`, `Nh`, `Nm`, or `YYYY-MM-DD`.
