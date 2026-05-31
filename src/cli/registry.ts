import { Cli, z } from "incur";
import { installProxyFromEnv } from "../proxy";
import { UNTRUSTED_ADVISORY } from "../guard";
import {
  commandFlags,
  csv,
  loadEnv,
  runAttio,
  runLocal,
  runTelegram,
  runTelegramAndAttio,
  runTelegramMaybeWrite,
  runTelegramWrite
} from "./runtime";
import {
  cmdMe,
  cmdChatsList,
  cmdChatsSearch,
  cmdChatsInfo,
  cmdChatsResolve,
  cmdChatsFolder,
  cmdChatsUnread,
  cmdChatsActivity,
  cmdChatsStatus,
  cmdFoldersList,
  cmdFoldersCreate,
  cmdFoldersRename,
  cmdFoldersDelete,
  cmdFoldersAdd,
  cmdFoldersRemove,
  cmdFoldersPin,
  cmdFoldersUnpin,
  cmdFoldersExcludeAdd,
  cmdFoldersExcludeRemove,
  cmdFoldersSources,
  cmdFoldersReorder,
  cmdDiscoverAssociations,
  cmdAssociationsUpsert,
  cmdAssociationsReconcile,
  cmdAssociationsStatus,
  cmdIdentitiesReconcile,
  cmdIdentitiesCandidates,
  cmdIdentitiesUpsert,
  cmdIdentitiesStatus,
  cmdBansList,
  cmdBansAdd,
  cmdBansRemove,
  cmdBansCheck,
  cmdMsgRead,
  cmdMsgSend,
  cmdMsgEdit,
  cmdMsgDelete,
  cmdMsgForward,
  cmdMsgSearch,
  cmdMsgPin,
  cmdMsgUnpin,
  cmdMsgSchedule,
  cmdMsgScheduleList,
  cmdMsgScheduleDelete,
  cmdMsgMarkRead,
  cmdContactsList,
  cmdContactsAdd,
  cmdContactsDelete,
  cmdContactsBlock,
  cmdContactsUnblock,
  cmdGroupCreate,
  cmdGroupInfo,
  cmdGroupMembers,
  cmdGroupAdd,
  cmdGroupKick,
  cmdGroupTitle,
  cmdGroupLeave,
  cmdGroupDescription,
  cmdMediaSend,
  cmdMediaDownload,
  cmdProfileSetBio,
  cmdProfileSetName,
  cmdProfileSetUsername,
  cmdDraftSet,
  cmdDraftClear,
  cmdDoctor
} from "./commands";

// ── incur CLI ───────────────────────────────────────────────────

const chats = Cli.create("chats", { description: "Inspect Telegram chats and folders" })
  .command("list", {
    description: "List recent chats",
    options: z.object({ limit: z.number().default(50).describe("Maximum chats to return") }),
    run: (c) => runTelegram(() => cmdChatsList(commandFlags(c.options))),
  })
  .command("search", {
    description: "Search chats, users, groups, and channels",
    args: z.object({ query: z.string().describe("Search query") }),
    options: z.object({ limit: z.number().default(20).describe("Maximum results to return") }),
    run: (c) => runTelegram(() => cmdChatsSearch([c.args.query], commandFlags(c.options))),
  })
  .command("info", {
    description: "Get chat details",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    run: (c) => runTelegram(() => cmdChatsInfo([c.args.chat])),
  })
  .command("resolve", {
    description: "Resolve a chat identifier to canonical Telegram IDs",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    run: (c) => runTelegram(() => cmdChatsResolve([c.args.chat])),
  })
  .command("folder", {
    description: "List chats in a Telegram folder",
    args: z.object({ name: z.string().describe("Folder name") }),
    run: (c) => runTelegram(() => cmdChatsFolder([c.args.name])),
  })
  .command("unread", {
    description: "List chats with unread messages",
    options: z.object({ limit: z.number().default(50).describe("Maximum chats to scan") }),
    run: (c) => runTelegram(() => cmdChatsUnread(commandFlags(c.options))),
  })
  .command("activity", {
    description: "Summarize recent activity for a folder",
    args: z.object({ folder: z.string().describe("Folder name") }),
    options: z.object({ since: z.string().optional().describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD") }),
    run: (c) => runTelegram(() => cmdChatsActivity([c.args.folder], commandFlags(c.options))),
  })
  .command("status", {
    description: "Check a user's online status",
    args: z.object({ user: z.string().describe("Username, phone, or numeric user ID") }),
    run: (c) => runTelegram(() => cmdChatsStatus([c.args.user])),
  });

const folders = Cli.create("folders", { description: "Inspect and manage Telegram folders" })
  .command("list", {
    description: "List all folders",
    run: () => runTelegram(cmdFoldersList),
  })
  .command("create", {
    description: "Create a Telegram folder",
    args: z.object({ name: z.string().describe("Folder name") }),
    options: z.object({
      chats: z.string().optional().describe("Comma-separated chat identifiers to include"),
      contacts: z.boolean().default(false).describe("Include contacts"),
      nonContacts: z.boolean().default(false).describe("Include non-contacts"),
      groups: z.boolean().default(false).describe("Include group chats"),
      channels: z.boolean().default(false).describe("Include channels"),
      bots: z.boolean().default(false).describe("Include bots"),
      excludeMuted: z.boolean().default(false).describe("Exclude muted chats"),
      excludeRead: z.boolean().default(false).describe("Exclude read chats"),
      excludeArchived: z.boolean().default(false).describe("Exclude archived chats"),
      emoticon: z.string().optional().describe("Folder emoji"),
      color: z.number().optional().describe("Telegram folder color ID"),
      dryRun: z.boolean().default(false).describe("Preview without changing Telegram"),
    }),
    run: (c) => runTelegramMaybeWrite("create folder", !c.options.dryRun, () => cmdFoldersCreate([c.args.name], commandFlags(c.options))),
  })
  .command("rename", {
    description: "Rename a Telegram folder",
    args: z.object({
      from: z.string().describe("Current folder name"),
      to: z.string().describe("New folder name"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("rename folder", !c.options.dryRun, () => cmdFoldersRename([c.args.from, c.args.to, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("delete", {
    description: "Delete a Telegram folder",
    args: z.object({ name: z.string().describe("Folder name") }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("delete folder", !c.options.dryRun, () => cmdFoldersDelete([c.args.name, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("add", {
    description: "Add chats to a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("add chats to folder", !c.options.dryRun, () => cmdFoldersAdd([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("remove", {
    description: "Remove chats from a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("remove chats from folder", !c.options.dryRun, () => cmdFoldersRemove([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("pin", {
    description: "Pin chats inside a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("pin chats in folder", !c.options.dryRun, () => cmdFoldersPin([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("unpin", {
    description: "Unpin chats inside a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("unpin chats in folder", !c.options.dryRun, () => cmdFoldersUnpin([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("exclude-add", {
    description: "Explicitly exclude chats from a source-based Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("exclude chats from folder", !c.options.dryRun, () => cmdFoldersExcludeAdd([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("exclude-remove", {
    description: "Remove chats from a folder's explicit exclusions",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("remove folder exclusions", !c.options.dryRun, () => cmdFoldersExcludeRemove([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("sources", {
    description: "Edit built-in folder sources and exclusions",
    args: z.object({ folder: z.string().describe("Folder name") }),
    options: z.object({
      contacts: z.string().optional().describe("true/false"),
      nonContacts: z.string().optional().describe("true/false"),
      groups: z.string().optional().describe("true/false"),
      channels: z.string().optional().describe("true/false"),
      bots: z.string().optional().describe("true/false"),
      excludeMuted: z.string().optional().describe("true/false"),
      excludeRead: z.string().optional().describe("true/false"),
      excludeArchived: z.string().optional().describe("true/false"),
      dryRun: z.boolean().default(false).describe("Preview without changing Telegram"),
    }),
    run: (c) => runTelegramMaybeWrite("edit folder sources", !c.options.dryRun, () => cmdFoldersSources([c.args.folder], commandFlags({
      contacts: c.options.contacts,
      "non-contacts": c.options.nonContacts,
      groups: c.options.groups,
      channels: c.options.channels,
      bots: c.options.bots,
      "exclude-muted": c.options.excludeMuted,
      "exclude-read": c.options.excludeRead,
      "exclude-archived": c.options.excludeArchived,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("reorder", {
    description: "Move named folders to the front in the given order",
    args: z.object({ order: z.string().describe("Comma-separated folder names in desired leading order") }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegramMaybeWrite("reorder folders", !c.options.dryRun, () => cmdFoldersReorder([c.args.order], commandFlags({ "dry-run": c.options.dryRun }))),
  });

const discover = Cli.create("discover", { description: "Find likely Telegram to Attio associations" })
  .command("associations", {
    description: "Dry-run recent chats and propose CRM association candidates",
    options: z.object({
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      includeIgnored: z.boolean().default(false).describe("Include low-confidence ignored candidates"),
    }),
    run: (c) => runTelegram(() => cmdDiscoverAssociations(commandFlags({
      limit: c.options.limit,
      since: c.options.since,
      "include-ignored": c.options.includeIgnored,
    }))),
  });

const associations = Cli.create("associations", { description: "Manage Attio Telegram association records" })
  .command("status", {
    description: "List Telegram Association records with counts by status",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      limit: z.number().default(500).describe("Maximum association records to inspect"),
    }),
    run: (c) => runAttio(() => cmdAssociationsStatus(commandFlags({
      object: c.options.object,
      limit: c.options.limit,
    }))),
  })
  .command("upsert", {
    description: "Create or update a Telegram Association record in Attio",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      chatId: z.string().describe("Telegram chat ID from discover associations"),
      title: z.string().describe("Telegram chat title"),
      type: z.string().default("unknown").describe("dm, group, supergroup, channel, or unknown"),
      targetObject: z.string().describe("Attio target object slug, for example people or companies"),
      targetName: z.string().optional().describe("Human-readable inferred target name"),
      targetRecordId: z.string().default("").describe("Attio target record ID; required before approval"),
      status: z.string().default("suggested").describe("suggested, approved, ignored, or needs_review"),
      confidence: z.number().default(0).describe("Confidence from 0 to 1"),
      reason: z.string().default("").describe("Short rationale for the association"),
      syncMode: z.string().default("transcript").describe("transcript, summary, or stats"),
      dryRun: z.boolean().default(false).describe("Preview without writing to Attio"),
    }),
    run: (c) => runAttio(() => cmdAssociationsUpsert(commandFlags({
      object: c.options.object,
      "chat-id": c.options.chatId,
      title: c.options.title,
      type: c.options.type,
      "target-object": c.options.targetObject,
      "target-name": c.options.targetName,
      "target-record-id": c.options.targetRecordId,
      status: c.options.status,
      confidence: c.options.confidence,
      reason: c.options.reason,
      "sync-mode": c.options.syncMode,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("reconcile", {
    description: "Discover chats, resolve Attio targets, approve exact company matches, and mark the rest for review",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      minConfidence: z.number().default(0.45).describe("Minimum confidence required to upsert a candidate"),
      includeProfileDescriptions: z.boolean().default(true).describe("Use Telegram profile descriptions/bios from group participants as company signals"),
      profileParticipantLimit: z.number().default(30).describe("Maximum group participants to inspect for profile company hints"),
      companyLimit: z.number().default(500).describe("Maximum Attio companies to load for profile hint matching"),
      dryRun: z.boolean().default(false).describe("Preview without writing association records"),
    }),
    run: (c) => runTelegramAndAttio(() => cmdAssociationsReconcile(commandFlags({
      object: c.options.object,
      limit: c.options.limit,
      since: c.options.since,
      "min-confidence": c.options.minConfidence,
      "include-profile-descriptions": c.options.includeProfileDescriptions,
      "profile-participant-limit": c.options.profileParticipantLimit,
      "company-limit": c.options.companyLimit,
      "dry-run": c.options.dryRun,
    }))),
  });

const identities = Cli.create("identities", { description: "Resolve Telegram users to existing Attio People" })
  .command("status", {
    description: "List Telegram Identity records with counts by status",
    options: z.object({
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      limit: z.number().default(500).describe("Maximum identity records to inspect"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesStatus(commandFlags({
      "identity-object": c.options.identityObject,
      limit: c.options.limit,
    }))),
  })
  .command("reconcile", {
    description: "Scan recent DMs and approved group participants, then create approved or needs-review identity mappings",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio chat association object slug"),
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      includeParticipants: z.boolean().default(true).describe("Include participants from approved group chats"),
      includeProfileDescriptions: z.boolean().default(true).describe("Fetch Telegram profile descriptions/bios and infer company hints"),
      participantLimit: z.number().default(50).describe("Maximum recent senders or fallback participants per approved group"),
      companyLimit: z.number().default(500).describe("Maximum Attio companies to load for profile hint matching"),
      dryRun: z.boolean().default(false).describe("Preview without writing identity records or People updates"),
    }),
    run: (c) => runTelegramAndAttio(() => cmdIdentitiesReconcile(commandFlags({
      object: c.options.object,
      "identity-object": c.options.identityObject,
      limit: c.options.limit,
      since: c.options.since,
      "include-participants": c.options.includeParticipants,
      "include-profile-descriptions": c.options.includeProfileDescriptions,
      "participant-limit": c.options.participantLimit,
      "company-limit": c.options.companyLimit,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("candidates", {
    description: "Search Attio People candidates for a Telegram identity",
    options: z.object({
      name: z.string().optional().describe("Person name search"),
      username: z.string().optional().describe("Telegram username search"),
      phone: z.string().optional().describe("Phone number search"),
      telegramUserId: z.string().optional().describe("Telegram user ID search"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesCandidates(commandFlags({
      name: c.options.name,
      username: c.options.username,
      phone: c.options.phone,
      "telegram-user-id": c.options.telegramUserId,
    }))),
  })
  .command("upsert", {
    description: "Create or update a manual Telegram user to Attio Person mapping",
    options: z.object({
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      telegramUserId: z.string().describe("Stable Telegram user ID"),
      telegramUsername: z.string().optional().describe("Telegram username"),
      displayName: z.string().describe("Telegram display name"),
      telegramBio: z.string().optional().describe("Telegram profile description/bio"),
      companyHints: z.string().optional().describe("Comma-separated company hints from group context or Telegram bio"),
      phone: z.string().optional().describe("Phone number"),
      targetRecordId: z.string().default("").describe("Attio Person record ID"),
      targetName: z.string().optional().describe("Human-readable target name"),
      status: z.string().default("approved").describe("suggested, approved, ignored, or needs_review"),
      confidence: z.number().optional().describe("Confidence from 0 to 1"),
      reason: z.string().default("manual identity mapping").describe("Short mapping rationale"),
      dryRun: z.boolean().default(false).describe("Preview without writing to Attio"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesUpsert(commandFlags({
      "identity-object": c.options.identityObject,
      "telegram-user-id": c.options.telegramUserId,
      "telegram-username": c.options.telegramUsername,
      "display-name": c.options.displayName,
      "telegram-bio": c.options.telegramBio,
      "company-hints": c.options.companyHints,
      phone: c.options.phone,
      "target-record-id": c.options.targetRecordId,
      "target-name": c.options.targetName,
      status: c.options.status,
      confidence: c.options.confidence,
      reason: c.options.reason,
      "dry-run": c.options.dryRun,
    }))),
  });

const bans = Cli.create("bans", { description: "Manage the Telegram folder-backed ban list" })
  .command("list", {
    description: "List Telegram peers blocked from read, discovery, and sync workflows",
    run: () => runTelegram(cmdBansList),
  })
  .command("add", {
    description: "Add a Telegram peer to the ban folder",
    args: z.object({ user: z.string().describe("Telegram username, @handle, t.me link, or numeric chat/user ID") }),
    options: z.object({
      reason: z.string().optional().describe("Short reason included in command output"),
      dryRun: z.boolean().default(false).describe("Preview without changing the Telegram ban folder"),
    }),
    run: (c) => runTelegramMaybeWrite("add ban", !c.options.dryRun, () => cmdBansAdd([c.args.user], commandFlags({
      reason: c.options.reason,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("remove", {
    description: "Remove a Telegram peer from the ban folder",
    args: z.object({ user: z.string().describe("Telegram username, @handle, t.me link, or numeric chat/user ID") }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing the Telegram ban folder") }),
    run: (c) => runTelegramMaybeWrite("remove ban", !c.options.dryRun, () => cmdBansRemove([c.args.user], commandFlags({ "dry-run": c.options.dryRun }))),
  })
  .command("check", {
    description: "Check whether a Telegram peer is in the ban folder",
    args: z.object({ user: z.string().describe("Telegram username, @handle, t.me link, or numeric chat/user ID") }),
    run: (c) => runTelegram(() => cmdBansCheck([c.args.user])),
  });

const msg = Cli.create("msg", { description: "Read and manage Telegram messages" })
  .command("read", {
    description: "Read messages from a chat",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    options: z.object({
      limit: z.number().default(50).describe("Maximum messages to return"),
      since: z.string().optional().describe("Lower time bound: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      until: z.string().optional().describe("Upper time bound: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      date: z.string().optional().describe("Exact day shorthand for since and until"),
      offsetId: z.number().default(0).describe("Telegram offset message ID"),
      minId: z.number().default(0).describe("Minimum message ID"),
    }),
    run: (c) => runTelegram(() => cmdMsgRead([c.args.chat], commandFlags({
      limit: c.options.limit,
      since: c.options.since,
      until: c.options.until,
      date: c.options.date,
      "offset-id": c.options.offsetId,
      "min-id": c.options.minId,
    }))),
  })
  .command("send", {
    description: "Send a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      text: z.string().describe("Message text; quote it if it contains spaces"),
    }),
    options: z.object({
      replyTo: z.number().optional().describe("Message ID to reply to"),
      silent: z.boolean().default(false).describe("Send without notification"),
      noPreview: z.boolean().default(false).describe("Disable webpage preview"),
    }),
    run: (c) => runTelegramWrite("send message", () => cmdMsgSend([c.args.chat, c.args.text], commandFlags({
      "reply-to": c.options.replyTo,
      silent: c.options.silent,
      "no-preview": c.options.noPreview,
    }))),
  })
  .command("edit", {
    description: "Edit a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgId: z.string().describe("Message ID"),
      text: z.string().describe("New message text; quote it if it contains spaces"),
    }),
    run: (c) => runTelegramWrite("edit message", () => cmdMsgEdit([c.args.chat, c.args.msgId, c.args.text])),
  })
  .command("delete", {
    description: "Delete one or more messages",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgIds: z.string().describe("Comma-separated message IDs"),
    }),
    options: z.object({ revoke: z.boolean().default(false).describe("Delete for everyone where supported") }),
    run: (c) => runTelegramWrite("delete messages", () => cmdMsgDelete([c.args.chat, ...csv(c.args.msgIds)], commandFlags(c.options))),
  })
  .command("forward", {
    description: "Forward one or more messages",
    args: z.object({
      fromChat: z.string().describe("Source chat"),
      toChat: z.string().describe("Destination chat"),
      msgIds: z.string().describe("Comma-separated message IDs"),
    }),
    run: (c) => runTelegramWrite("forward messages", () => cmdMsgForward([c.args.fromChat, c.args.toChat, ...csv(c.args.msgIds)])),
  })
  .command("search", {
    description: "Search messages in a chat",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      query: z.string().describe("Search query; quote it if it contains spaces"),
    }),
    options: z.object({ limit: z.number().default(20).describe("Maximum messages to return") }),
    run: (c) => runTelegram(() => cmdMsgSearch([c.args.chat, c.args.query], commandFlags(c.options))),
  })
  .command("pin", {
    description: "Pin a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgId: z.string().describe("Message ID"),
    }),
    options: z.object({ silent: z.boolean().default(false).describe("Pin without notification") }),
    run: (c) => runTelegramWrite("pin message", () => cmdMsgPin([c.args.chat, c.args.msgId], commandFlags(c.options))),
  })
  .command("unpin", {
    description: "Unpin a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgId: z.string().describe("Message ID"),
    }),
    run: (c) => runTelegramWrite("unpin message", () => cmdMsgUnpin([c.args.chat, c.args.msgId])),
  })
  .command("mark-read", {
    description: "Mark a chat as read",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    options: z.object({ maxId: z.number().default(0).describe("Maximum message ID to mark as read") }),
    run: (c) => runTelegramWrite("mark read", () => cmdMsgMarkRead([c.args.chat], commandFlags({ "max-id": c.options.maxId }))),
  })
  .command("schedule", {
    description: "Schedule a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      text: z.string().describe("Message text; quote it if it contains spaces"),
    }),
    options: z.object({
      at: z.string().describe("Future datetime, for example 2026-05-06T15:30"),
      replyTo: z.number().optional().describe("Message ID to reply to"),
    }),
    run: (c) => runTelegramWrite("schedule message", () => cmdMsgSchedule([c.args.chat, c.args.text], commandFlags({
      at: c.options.at,
      "reply-to": c.options.replyTo,
    }))),
  })
  .command("schedule-list", {
    description: "List scheduled messages",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    run: (c) => runTelegram(() => cmdMsgScheduleList([c.args.chat])),
  })
  .command("schedule-delete", {
    description: "Delete scheduled messages",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgIds: z.string().describe("Comma-separated scheduled message IDs"),
    }),
    run: (c) => runTelegramWrite("delete scheduled message", () => cmdMsgScheduleDelete([c.args.chat, ...csv(c.args.msgIds)])),
  });

const contacts = Cli.create("contacts", { description: "Manage Telegram contacts" })
  .command("list", {
    description: "List all contacts",
    run: () => runTelegram(cmdContactsList),
  })
  .command("add", {
    description: "Add a contact",
    args: z.object({
      phone: z.string().describe("Phone number"),
      firstName: z.string().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
    }),
    run: (c) => runTelegramWrite("add contact", () => cmdContactsAdd([c.args.phone, c.args.firstName, c.args.lastName ?? ""])),
  })
  .command("delete", {
    description: "Delete a contact",
    args: z.object({ user: z.string().describe("Username, phone, or numeric user ID") }),
    run: (c) => runTelegramWrite("delete contact", () => cmdContactsDelete([c.args.user])),
  })
  .command("block", {
    description: "Block a user",
    args: z.object({ user: z.string().describe("Username, phone, or numeric user ID") }),
    run: (c) => runTelegramWrite("block contact", () => cmdContactsBlock([c.args.user])),
  })
  .command("unblock", {
    description: "Unblock a user",
    args: z.object({ user: z.string().describe("Username, phone, or numeric user ID") }),
    run: (c) => runTelegramWrite("unblock contact", () => cmdContactsUnblock([c.args.user])),
  });

const group = Cli.create("group", { description: "Manage Telegram groups and channels" })
  .command("create", {
    description: "Create a group",
    args: z.object({
      title: z.string().describe("Group title"),
      users: z.string().describe("Comma-separated users to add"),
    }),
    run: (c) => runTelegramWrite("create group", () => cmdGroupCreate([c.args.title, ...csv(c.args.users)], {})),
  })
  .command("info", {
    description: "Get group info",
    args: z.object({ chat: z.string().describe("Username or numeric chat ID") }),
    run: (c) => runTelegram(() => cmdGroupInfo([c.args.chat])),
  })
  .command("members", {
    description: "List group members",
    args: z.object({ chat: z.string().describe("Username or numeric chat ID") }),
    options: z.object({ limit: z.number().default(200).describe("Maximum members to return") }),
    run: (c) => runTelegram(() => cmdGroupMembers([c.args.chat], commandFlags(c.options))),
  })
  .command("add", {
    description: "Add a member",
    args: z.object({
      chat: z.string().describe("Username or numeric chat ID"),
      user: z.string().describe("Username, phone, or numeric user ID"),
    }),
    run: (c) => runTelegramWrite("add group member", () => cmdGroupAdd([c.args.chat, c.args.user])),
  })
  .command("kick", {
    description: "Remove a member",
    args: z.object({
      chat: z.string().describe("Username or numeric chat ID"),
      user: z.string().describe("Username, phone, or numeric user ID"),
    }),
    run: (c) => runTelegramWrite("kick group member", () => cmdGroupKick([c.args.chat, c.args.user])),
  })
  .command("title", {
    description: "Set group title",
    args: z.object({
      chat: z.string().describe("Username or numeric chat ID"),
      title: z.string().describe("New title; quote it if it contains spaces"),
    }),
    run: (c) => runTelegramWrite("set group title", () => cmdGroupTitle([c.args.chat, c.args.title])),
  })
  .command("description", {
    description: "Set group description",
    args: z.object({
      chat: z.string().describe("Username or numeric chat ID"),
      text: z.string().default("").describe("Description text; quote it if it contains spaces"),
    }),
    run: (c) => runTelegramWrite("set group description", () => cmdGroupDescription([c.args.chat, c.args.text])),
  })
  .command("leave", {
    description: "Leave a group",
    args: z.object({ chat: z.string().describe("Username or numeric chat ID") }),
    run: (c) => runTelegramWrite("leave group", () => cmdGroupLeave([c.args.chat])),
  });

const media = Cli.create("media", { description: "Send and download Telegram media" })
  .command("send", {
    description: "Send a file",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      filePath: z.string().describe("Local file path"),
      caption: z.string().optional().describe("Caption; quote it if it contains spaces"),
    }),
    options: z.object({
      voice: z.boolean().default(false).describe("Send as voice note"),
      videoNote: z.boolean().default(false).describe("Send as video note"),
    }),
    run: (c) => runTelegramWrite("send media", () => cmdMediaSend(
      [c.args.chat, c.args.filePath, c.args.caption ?? ""],
      commandFlags({ voice: c.options.voice, "video-note": c.options.videoNote }),
    )),
  })
  .command("download", {
    description: "Download media from a message",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      msgId: z.string().describe("Message ID"),
      outputPath: z.string().describe("Output file path"),
    }),
    run: (c) => runTelegram(() => cmdMediaDownload([c.args.chat, c.args.msgId, c.args.outputPath])),
  });

const profile = Cli.create("profile", { description: "Manage your Telegram profile" })
  .command("set-bio", {
    description: "Set profile bio",
    args: z.object({ text: z.string().default("").describe("Bio text; quote it if it contains spaces") }),
    run: (c) => runTelegramWrite("set profile bio", () => cmdProfileSetBio([c.args.text])),
  })
  .command("set-name", {
    description: "Set profile name",
    args: z.object({
      firstName: z.string().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
    }),
    run: (c) => runTelegramWrite("set profile name", () => cmdProfileSetName([c.args.firstName, c.args.lastName ?? ""])),
  })
  .command("set-username", {
    description: "Set profile username",
    args: z.object({ username: z.string().default("").describe("Username, or empty to clear") }),
    run: (c) => runTelegramWrite("set profile username", () => cmdProfileSetUsername([c.args.username])),
  });

const draft = Cli.create("draft", { description: "Manage Telegram drafts" })
  .command("set", {
    description: "Set a draft",
    args: z.object({
      chat: z.string().describe("Username, phone, or numeric chat ID"),
      text: z.string().default("").describe("Draft text; quote it if it contains spaces"),
    }),
    run: (c) => runTelegramWrite("set draft", () => cmdDraftSet([c.args.chat, c.args.text])),
  })
  .command("clear", {
    description: "Clear a draft",
    args: z.object({ chat: z.string().describe("Username, phone, or numeric chat ID") }),
    run: (c) => runTelegramWrite("clear draft", () => cmdDraftClear([c.args.chat])),
  });

const cli = Cli.create("tellatio", {
  description: "Full Telegram API for AI agents. SECURITY: " + UNTRUSTED_ADVISORY,
  version: "0.1.0",
  format: "toon",
  sync: {
    suggestions: [
      "Use tellatio --llms to discover the Telegram command surface.",
      "Use tellatio msg read <chat> --limit 20 to inspect recent messages.",
      UNTRUSTED_ADVISORY,
    ],
  },
})
  .command("me", {
    description: "Get your profile info",
    run: () => runTelegram(cmdMe),
  })
  .command("doctor", {
    description: "Check Telegram, Attio, Railway, and local sync state",
    options: z.object({
      skipTelegram: z.boolean().default(false).describe("Skip Telegram session and folder checks"),
      skipAttio: z.boolean().default(false).describe("Skip Attio association and identity checks"),
      skipRailway: z.boolean().default(false).describe("Skip Railway service status checks"),
      limit: z.number().default(100).describe("Maximum Attio records to inspect for counts"),
    }),
    run: (c) => runLocal(() => cmdDoctor(commandFlags({
      "skip-telegram": c.options.skipTelegram,
      "skip-attio": c.options.skipAttio,
      "skip-railway": c.options.skipRailway,
      limit: c.options.limit,
    }))),
  })
  .command(chats)
  .command(folders)
  .command(discover)
  .command(associations)
  .command(identities)
  .command(bans)
  .command(msg)
  .command(contacts)
  .command(group)
  .command(media)
  .command(profile)
  .command(draft);


export function serveCli(): void {
  // Load .env and route HTTP egress through iron (if configured) before any command runs.
  loadEnv();
  installProxyFromEnv();
  cli.serve();
}
