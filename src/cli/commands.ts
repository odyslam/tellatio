import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { matchBannedIdentifier } from "../shared/bans";
import { sanitizeUntrusted, UNTRUSTED_ADVISORY } from "../shared/guard";
import { createDownload, readUpload } from "./media";
import {
  activeBanFolderSummary,
  activeBanList,
  assertEntityAllowed,
  assertIdentifierAllowed,
  assertNotBanFolderName,
  assertWritesAllowed,
  banEntryFromEntity,
  banFolderNameFromEnv,
  chatDisplayName,
  client,
  cloneDialogFolder,
  csv,
  dataDirFromEnv,
  dialogCanonicalId,
  dialogFolderTitle,
  die,
  dryRun,
  ensureFolderHasSourceOrPeers,
  entityIdString,
  filterBannedDialogs,
  filterBannedMessages,
  findDialogFolder,
  flagEnabled,
  folderColor,
  folderDryRun,
  folderHasBuiltInSource,
  folderTitle,
  inputPeerKey,
  isBanFolderName,
  isMessageFromBannedUser,
  loadCliBanList,
  loadDialogFilters,
  matchBannedEntity,
  namedDialogFolders,
  nextDialogFolderId,
  numFlag,
  out,
  refreshActiveBanList,
  requireDialogFolder,
  resolveEntity,
  resolveFolderPeers,
  saveDialogFolder,
  selectDialogFolder,
  serializeBan,
  serializeChat,
  serializeFolder,
  serializeInputPeer,
  serializeUser,
  sourceFlagOverrides,
  validateDialogFolderName
} from "./runtime";
import { parseTimeFilter, parseUntilFilter } from "./time";

function serializeMessage(m: Api.Message): Record<string, unknown> {
  let senderName = "Unknown";
  let senderUsername: string | undefined;
  if (m.sender instanceof Api.User) {
    senderName = [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ") || "Unknown";
    senderUsername = m.sender.username;
  } else if (m.sender && "title" in m.sender) {
    senderName = (m.sender as any).title;
  }

  return {
    untrusted: true,
    id: m.id,
    date: m.date,
    dateISO: new Date(m.date * 1000).toISOString(),
    senderId: m.senderId?.toString(),
    senderUsername,
    senderName: sanitizeUntrusted(senderName),
    text: sanitizeUntrusted(m.text || m.message || ""),
    out: m.out,
    replyToMsgId: m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined,
    hasMedia: !!m.media && !(m.media instanceof Api.MessageMediaEmpty),
    mediaType: m.media?.className,
    views: m.views,
    forwards: m.forwards,
    pinned: m.pinned,
    editDate: m.editDate,
    grouped: m.groupedId?.toString(),
  };
}

// ─── Commands ───────────────────────────────────────────────────

// ── me ──────────────────────────────────────────────────────────

async function cmdMe(): Promise<void> {
  const me = await client.getMe() as Api.User;
  out(serializeUser(me));
}

// ── chats ───────────────────────────────────────────────────────

async function cmdChatsList(flags: Record<string, string>): Promise<void> {
  const limit = numFlag(flags, "limit", 50);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : undefined;
  const omitLastMessageText = flags["omit-last-message-text"] === "true" || flags["omitLastMessageText"] === "true";
  const banList = loadCliBanList();
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const results = dialogs
    .filter((d) => (sinceTs ? (d.message?.date ?? 0) >= sinceTs : true))
    .map((d) => {
      const lastMessage = d.message
        ? {
            id: d.message.id,
            date: d.message.date,
            dateISO: new Date(d.message.date * 1000).toISOString(),
            ...(!omitLastMessageText ? { text: sanitizeUntrusted(d.message.text || d.message.message || "") } : {}),
            out: d.message.out,
            senderId: d.message.senderId?.toString(),
            senderUsername: d.message.sender instanceof Api.User ? d.message.sender.username : undefined,
          }
        : null;

      return {
        id: dialogCanonicalId(d) || "",
        canonicalId: entityIdString(d.entity) || dialogCanonicalId(d) || "",
        dialogId: d.id?.toString(),
        name: sanitizeUntrusted(d.name || d.title),
        isGroup: d.isGroup,
        isChannel: d.isChannel,
        isUser: d.isUser,
        unreadCount: d.unreadCount,
        lastMessage,
      };
    });
  out({ _advisory: UNTRUSTED_ADVISORY, untrusted: true, chats: results });
}

async function cmdChatsSearch(positional: string[], flags: Record<string, string>): Promise<void> {
  const query = positional[0];
  if (!query) die("Usage: tellatio chats search <query>");
  const limit = numFlag(flags, "limit", 20);
  const banList = loadCliBanList();

  const result = await client.invoke(new Api.contacts.Search({ q: query, limit }));
  const entities: Record<string, unknown>[] = [];

  for (const u of result.users) {
    if (u instanceof Api.User && !matchBannedEntity(banList, u)) entities.push(serializeUser(u));
  }
  for (const c of result.chats) {
    entities.push(serializeChat(c as Api.User | Api.Chat | Api.Channel));
  }
  out({ _advisory: UNTRUSTED_ADVISORY, untrusted: true, results: entities });
}

async function cmdChatsInfo(positional: string[]): Promise<void> {
  const id = positional[0];
  if (!id) die("Usage: tellatio chats info <chat>");
  assertIdentifierAllowed(id, "inspect");
  const entity = await resolveEntity(id);
  assertEntityAllowed(entity, "inspect");
  out(serializeChat(entity));
}

async function cmdChatsResolve(positional: string[]): Promise<void> {
  const id = positional[0];
  if (!id) die("Usage: tellatio chats resolve <chat>");

  assertIdentifierAllowed(id, "resolve");
  const entity = await resolveEntity(id);
  assertEntityAllowed(entity, "resolve");
  const inputPeer = await client.getInputEntity(entity) as unknown as Api.TypeInputPeer;
  out({
    input: id,
    chat: serializeChat(entity),
    canonicalId: entityIdString(entity),
    displayName: chatDisplayName(entity),
    inputPeer: serializeInputPeer(inputPeer),
  });
}

async function cmdChatsFolder(positional: string[]): Promise<void> {
  const folderName = positional[0];
  if (!folderName) die("Usage: tellatio chats folder <name>");
  if (isBanFolderName(folderName)) die(`Use tellatio bans list for the "${banFolderNameFromEnv()}" folder`);

  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folder = result.filters.find(
    (f): f is Api.DialogFilter =>
      f instanceof Api.DialogFilter && f.title.text === folderName,
  );

  if (!folder) {
    const names = result.filters
      .filter((f): f is Api.DialogFilter => f instanceof Api.DialogFilter)
      .map((f) => f.title.text);
    die(`Folder "${folderName}" not found. Available: ${names.join(", ")}`);
  }

  const chats: Record<string, unknown>[] = [];
  const banList = loadCliBanList();
  for (const peer of folder.includePeers) {
    try {
      const entity = await client.getEntity(peer);
      if (matchBannedEntity(banList, entity)) continue;
      chats.push(serializeChat(entity));
    } catch {}
  }
  out(chats);
}

async function cmdChatsUnread(flags: Record<string, string>): Promise<void> {
  const limit = numFlag(flags, "limit", 50);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : undefined;
  const omitLastMessageText = flags["omit-last-message-text"] === "true" || flags["omitLastMessageText"] === "true";
  const banList = loadCliBanList();
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const unread = dialogs
    .filter((d) => d.unreadCount > 0)
    .filter((d) => (sinceTs ? (d.message?.date ?? 0) >= sinceTs : true))
    .map((d) => ({
      id: dialogCanonicalId(d) || "",
      canonicalId: entityIdString(d.entity) || dialogCanonicalId(d) || "",
      dialogId: d.id?.toString(),
      name: sanitizeUntrusted(d.name || d.title),
      isGroup: d.isGroup,
      isChannel: d.isChannel,
      unreadCount: d.unreadCount,
      lastMessage: d.message ? {
        id: d.message.id,
        date: d.message.date,
        dateISO: new Date(d.message.date * 1000).toISOString(),
        ...(!omitLastMessageText ? { text: sanitizeUntrusted(d.message.text || d.message.message || "") } : {}),
        out: d.message.out,
        senderId: d.message.senderId?.toString(),
        senderUsername: d.message.sender instanceof Api.User ? d.message.sender.username : undefined,
      } : null,
    }));
  out(unread);
}

async function cmdChatsActivity(positional: string[], flags: Record<string, string>): Promise<void> {
  const folderName = positional[0];
  if (!folderName) die("Usage: tellatio chats activity <folder> [--since X]");
  if (isBanFolderName(folderName)) die(`Use tellatio bans list for the "${banFolderNameFromEnv()}" folder`);

  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("today");

  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folder = result.filters.find(
    (f): f is Api.DialogFilter =>
      f instanceof Api.DialogFilter && f.title.text === folderName,
  );
  if (!folder) die(`Folder "${folderName}" not found`);

  const activity: Record<string, unknown>[] = [];
  const banList = loadCliBanList();

  for (const peer of folder.includePeers) {
    try {
      const entity = await client.getEntity(peer);
      if (matchBannedEntity(banList, entity)) continue;
      const chatName = entity instanceof Api.User
        ? [entity.firstName, entity.lastName].filter(Boolean).join(" ")
        : (entity as any).title || "Unknown";

      const messages = await client.getMessages(entity, { limit: 100 });
      const recent = filterBannedMessages(messages, banList).filter((m) => m.date >= sinceTs);

      if (recent.length > 0) {
        const last = recent[0];
        activity.push({
          chat: chatName,
          chatId: (entity as any).id?.toString(),
          isGroup: !(entity instanceof Api.User),
          messageCount: recent.length,
          lastMessage: {
            date: last.date,
            dateISO: new Date(last.date * 1000).toISOString(),
            text: (last.text || last.message || "").slice(0, 200),
            out: last.out,
            senderId: last.senderId?.toString(),
            senderUsername: last.sender instanceof Api.User ? last.sender.username : undefined,
          },
        });
      }
    } catch {}
  }

  activity.sort((a, b) => (b as any).messageCount - (a as any).messageCount);
  out(activity);
}

async function cmdChatsStatus(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio chats status <user>");

  assertIdentifierAllowed(chatId, "read status for");
  const entity = await resolveEntity(chatId);
  if (!(entity instanceof Api.User)) die("Online status is only available for users, not groups/channels");
  assertEntityAllowed(entity, "read status for");

  const status = entity.status;
  let statusInfo: Record<string, unknown> = { type: "unknown" };

  if (status instanceof Api.UserStatusOnline) {
    statusInfo = { type: "online", expires: status.expires };
  } else if (status instanceof Api.UserStatusOffline) {
    statusInfo = {
      type: "offline",
      wasOnline: status.wasOnline,
      wasOnlineISO: new Date(status.wasOnline * 1000).toISOString(),
    };
  } else if (status instanceof Api.UserStatusRecently) {
    statusInfo = { type: "recently" };
  } else if (status instanceof Api.UserStatusLastWeek) {
    statusInfo = { type: "last_week" };
  } else if (status instanceof Api.UserStatusLastMonth) {
    statusInfo = { type: "last_month" };
  }

  out({
    user: [entity.firstName, entity.lastName].filter(Boolean).join(" "),
    username: entity.username,
    ...statusInfo,
  });
}

async function cmdFoldersList(): Promise<void> {
  const folders = namedDialogFolders(await loadDialogFilters()).map(serializeFolder);
  out(folders);
}

async function cmdFoldersInfo(positional: string[]): Promise<void> {
  const name = positional[0];
  if (!name) die("Usage: tellatio folders info <folder|#id>");
  const folder = selectDialogFolder(await loadDialogFilters(), name);
  assertNotBanFolderName(dialogFolderTitle(folder), "list");
  out({
    ...serializeFolder(folder),
    membership: "Explicit peers only; built-in sources may include additional chats.",
    includePeers: folder.includePeers.map(inputPeerKey),
    pinnedPeers: folder.pinnedPeers.map(inputPeerKey),
    excludePeers: folder instanceof Api.DialogFilter ? folder.excludePeers.map(inputPeerKey) : [],
  });
}

async function cmdFoldersCreate(positional: string[], flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("create folder");
  const name = positional[0];
  if (!name) die("Usage: tellatio folders create <name> [--chats chat1,chat2] [--contacts] [--groups] [--channels] [--bots]");
  assertNotBanFolderName(name, "add");
  validateDialogFolderName(name);

  const filters = await loadDialogFilters();
  if (namedDialogFolders(filters).some((folder) => dialogFolderTitle(folder) === name)) die(`Folder "${name}" already exists`);

  const peers = flags["chats"] ? await resolveFolderPeers(flags["chats"]) : [];
  const hasBuiltInSource = [
    "contacts",
    "nonContacts",
    "groups",
    "channels",
    "bots",
  ].some((flag) => flagEnabled(flags, flag));
  if (peers.length === 0 && !hasBuiltInSource) {
    die("Telegram requires a new folder to include at least one chat or built-in source. Use --chats, --contacts, --groups, --channels, or --bots.");
  }

  const folder = new Api.DialogFilter({
    contacts: flagEnabled(flags, "contacts") || undefined,
    nonContacts: flagEnabled(flags, "nonContacts") || undefined,
    groups: flagEnabled(flags, "groups") || undefined,
    broadcasts: flagEnabled(flags, "channels") || undefined,
    bots: flagEnabled(flags, "bots") || undefined,
    excludeMuted: flagEnabled(flags, "excludeMuted") || undefined,
    excludeRead: flagEnabled(flags, "excludeRead") || undefined,
    excludeArchived: flagEnabled(flags, "excludeArchived") || undefined,
    id: nextDialogFolderId(filters),
    title: folderTitle(name),
    emoticon: flags["emoticon"],
    color: flags["color"] !== undefined ? folderColor(flags["color"]) : undefined,
    pinnedPeers: [],
    includePeers: peers.map((peer) => peer.peer),
    excludePeers: [],
  });

  if (dryRun(flags)) {
    out({
      dryRun: true,
      action: "folders.create",
      folder: serializeFolder(folder),
      includedChats: peers.map((peer) => peer.chat),
    });
    return;
  }

  const ok = await saveDialogFolder(folder);
  out({
    created: ok,
    folder: serializeFolder(folder),
    includedChats: peers.map((peer) => peer.chat),
  });
}

async function cmdFoldersUpdate(positional: string[], flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("update folder");
  const name = positional[0];
  if (!name) die("Usage: tellatio folders update <folder|#id> [--name NAME] [--emoticon EMOJI] [--color ID] [--groups true|false] ...");
  const clearEmoticon = flagEnabled(flags, "clearEmoticon") || flagEnabled(flags, "clear-emoticon");
  const clearColor = flagEnabled(flags, "clearColor") || flagEnabled(flags, "clear-color");
  if (clearEmoticon && flags["emoticon"] !== undefined) die("Use either --emoticon or --clear-emoticon, not both");
  if (clearColor && flags["color"] !== undefined) die("Use either --color or --clear-color, not both");
  const editable = ["name", "emoticon", "color", "contacts", "nonContacts", "non-contacts", "groups", "channels", "bots", "excludeMuted", "exclude-muted", "excludeRead", "exclude-read", "excludeArchived", "exclude-archived"];
  if (!clearEmoticon && !clearColor && !editable.some((key) => flags[key] !== undefined)) {
    die("Specify at least one folder setting to update; use folders info to inspect a folder");
  }

  const filters = await loadDialogFilters();
  const folder = requireDialogFolder(filters, name);
  const newName = flags["name"];
  if (newName !== undefined) {
    validateDialogFolderName(newName);
    assertNotBanFolderName(newName, "add");
    if (namedDialogFolders(filters).some((other) => other.id !== folder.id && dialogFolderTitle(other) === newName)) {
      die(`Folder "${newName}" already exists`);
    }
  }
  const updated = cloneDialogFolder(folder, {
    ...sourceFlagOverrides(folder, flags),
    title: newName !== undefined ? folderTitle(newName) : undefined,
    emoticon: clearEmoticon ? null : flags["emoticon"],
    color: clearColor ? null : flags["color"] !== undefined ? folderColor(flags["color"]) : undefined,
  });
  ensureFolderHasSourceOrPeers(updated);
  if (dryRun(flags)) {
    folderDryRun("folders.update", folder, updated);
    return;
  }
  const ok = await saveDialogFolder(updated);
  out({ updated: ok, folder: serializeFolder(updated) });
}

async function cmdFoldersRename(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("rename folder");
  const from = positional[0];
  const to = positional[1];
  if (!from || !to) die("Usage: tellatio folders rename <old-name> <new-name>");
  assertNotBanFolderName(from, "list/remove");
  assertNotBanFolderName(to, "add");
  validateDialogFolderName(to);

  const filters = await loadDialogFilters();
  const folder = requireDialogFolder(filters, from);
  const existing = namedDialogFolders(filters).find((other) => dialogFolderTitle(other) === to && other.id !== folder.id);
  if (existing) die(`Folder "${to}" already exists`);

  const updated = cloneDialogFolder(folder, { title: folderTitle(to) });
  if (positional[2] === "dry-run") {
    folderDryRun("folders.rename", folder, updated, { from, to });
    return;
  }

  const ok = await saveDialogFolder(updated);
  out({
    renamed: ok,
    from,
    to,
    folder: serializeFolder(updated),
  });
}

async function cmdFoldersDelete(positional: string[]): Promise<void> {
  if (positional[1] !== "dry-run") assertWritesAllowed("delete folder");
  const name = positional[0];
  if (!name) die("Usage: tellatio folders delete <name>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  if (positional[1] === "dry-run") {
    out({
      dryRun: true,
      action: "folders.delete",
      folder: serializeFolder(folder),
    });
    return;
  }

  const ok = await client.invoke(new Api.messages.UpdateDialogFilter({ id: folder.id }));
  out({
    deleted: ok,
    folder: serializeFolder(folder),
  });
}

async function cmdFoldersAdd(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("add chats to folder");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders add <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "add");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const addKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const excludePeers = folder.excludePeers.filter((peer) => !addKeys.has(inputPeerKey(peer)));
  const removedExclusions = folder.excludePeers.filter((peer) => addKeys.has(inputPeerKey(peer))).map(inputPeerKey);
  const existingKeys = new Set(folder.includePeers.map(inputPeerKey));
  const includePeers = [...folder.includePeers];
  const added: Record<string, unknown>[] = [];
  const alreadyPresent: Record<string, unknown>[] = [];

  for (const resolved of peers) {
    const key = inputPeerKey(resolved.peer);
    if (existingKeys.has(key)) {
      alreadyPresent.push(resolved.chat);
      continue;
    }

    existingKeys.add(key);
    includePeers.push(resolved.peer);
    added.push(resolved.chat);
  }

  const changed = added.length > 0 || removedExclusions.length > 0;
  const updated = changed
    ? cloneDialogFolder(folder, { includePeers, excludePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.add", folder, updated, { added, alreadyPresent, removedExclusions });
    return;
  }

  const ok = changed ? await saveDialogFolder(updated) : true;

  out({
    updated: ok,
    folder: serializeFolder(updated),
    added,
    alreadyPresent,
    removedExclusions,
  });
}

async function cmdFoldersRemove(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("remove chats from folder");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders remove <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const removeKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const existingKeys = new Set([...folder.includePeers, ...folder.pinnedPeers].map(inputPeerKey));
  const includePeers = folder.includePeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const pinnedPeers = folder.pinnedPeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const removed = peers
    .filter((peer) => existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const hasSource = folderHasBuiltInSource(folder);
  const notPresent = peers
    .filter((peer) => !hasSource && !existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const excludePeers = [...folder.excludePeers];
  const excludeKeys = new Set(excludePeers.map(inputPeerKey));
  const excluded: Record<string, unknown>[] = [];
  if (hasSource) {
    for (const peer of peers) {
      const key = inputPeerKey(peer.peer);
      if (excludeKeys.has(key)) continue;
      excludeKeys.add(key);
      excludePeers.push(peer.peer);
      excluded.push(peer.chat);
    }
  }

  if (removed.length > 0 && includePeers.length === 0 && pinnedPeers.length === 0 && !hasSource) {
    die("Removing these chats would leave the folder with no included chats or built-in source. Delete the folder instead, or keep at least one chat.");
  }

  const changed = removed.length > 0 || excluded.length > 0;
  const updated = changed
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers, excludePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.remove", folder, updated, { removed, notPresent, excluded });
    return;
  }

  const ok = changed ? await saveDialogFolder(updated) : true;

  out({
    updated: ok,
    folder: serializeFolder(updated),
    removed,
    notPresent,
    excluded,
  });
}

async function cmdFoldersPin(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("pin chats in folder");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders pin <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "add");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const pinKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const excludePeers = folder.excludePeers.filter((peer) => !pinKeys.has(inputPeerKey(peer)));
  const removedExclusions = folder.excludePeers.filter((peer) => pinKeys.has(inputPeerKey(peer))).map(inputPeerKey);
  const includeKeys = new Set(folder.includePeers.map(inputPeerKey));
  const pinnedKeys = new Set(folder.pinnedPeers.map(inputPeerKey));
  const includePeers = [...folder.includePeers];
  const pinnedPeers = [...folder.pinnedPeers];
  const pinned: Record<string, unknown>[] = [];
  const alreadyPinned: Record<string, unknown>[] = [];

  for (const resolved of peers) {
    const key = inputPeerKey(resolved.peer);
    if (!includeKeys.has(key)) {
      includeKeys.add(key);
      includePeers.push(resolved.peer);
    }
    if (pinnedKeys.has(key)) {
      alreadyPinned.push(resolved.chat);
      continue;
    }

    pinnedKeys.add(key);
    pinnedPeers.push(resolved.peer);
    pinned.push(resolved.chat);
  }

  const changed = pinned.length > 0 || includePeers.length !== folder.includePeers.length || removedExclusions.length > 0;
  const updated = changed
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers, excludePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.pin", folder, updated, { pinned, alreadyPinned, removedExclusions });
    return;
  }

  const ok = changed ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), pinned, alreadyPinned, removedExclusions });
}

async function cmdFoldersUnpin(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("unpin chats in folder");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders unpin <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const unpinKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const existingKeys = new Set(folder.pinnedPeers.map(inputPeerKey));
  const pinnedPeers = folder.pinnedPeers.filter((peer) => !unpinKeys.has(inputPeerKey(peer)));
  const includePeers = [...folder.includePeers];
  const includeKeys = new Set(includePeers.map(inputPeerKey));
  for (const peer of folder.pinnedPeers) {
    const key = inputPeerKey(peer);
    if (unpinKeys.has(key) && !includeKeys.has(key)) {
      includeKeys.add(key);
      includePeers.push(peer);
    }
  }
  const unpinned = peers
    .filter((peer) => existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const notPinned = peers
    .filter((peer) => !existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);

  const updated = unpinned.length > 0 ? cloneDialogFolder(folder, { includePeers, pinnedPeers }) : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.unpin", folder, updated, { unpinned, notPinned });
    return;
  }

  const ok = unpinned.length > 0 ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), unpinned, notPinned });
}

async function cmdFoldersExcludeAdd(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("exclude chats from folder");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders exclude-add <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "add");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  if (!folderHasBuiltInSource(folder)) {
    die("Explicit exclusions are only meaningful on source-based folders. Add a built-in source with folders sources first.");
  }

  const peers = await resolveFolderPeers(chat);
  const excludeKeys = new Set(folder.excludePeers.map(inputPeerKey));
  const excludePeers = [...folder.excludePeers];
  const removeKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const includePeers = folder.includePeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const pinnedPeers = folder.pinnedPeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const excluded: Record<string, unknown>[] = [];
  const alreadyExcluded: Record<string, unknown>[] = [];

  for (const resolved of peers) {
    const key = inputPeerKey(resolved.peer);
    if (excludeKeys.has(key)) {
      alreadyExcluded.push(resolved.chat);
      continue;
    }

    excludeKeys.add(key);
    excludePeers.push(resolved.peer);
    excluded.push(resolved.chat);
  }

  const changed = excluded.length > 0 || includePeers.length !== folder.includePeers.length || pinnedPeers.length !== folder.pinnedPeers.length;
  const updated = changed
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers, excludePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.exclude-add", folder, updated, { excluded, alreadyExcluded });
    return;
  }

  const ok = changed ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), excluded, alreadyExcluded });
}

async function cmdFoldersExcludeRemove(positional: string[]): Promise<void> {
  if (positional[2] !== "dry-run") assertWritesAllowed("remove folder exclusions");
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders exclude-remove <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const removeKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const existingKeys = new Set(folder.excludePeers.map(inputPeerKey));
  const excludePeers = folder.excludePeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const includedAgain = peers
    .filter((peer) => existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const notExcluded = peers
    .filter((peer) => !existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);

  const updated = includedAgain.length > 0 ? cloneDialogFolder(folder, { excludePeers }) : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.exclude-remove", folder, updated, { includedAgain, notExcluded });
    return;
  }

  const ok = includedAgain.length > 0 ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), includedAgain, notExcluded });
}

async function cmdFoldersSources(positional: string[], flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("edit folder sources");
  const name = positional[0];
  if (!name) die("Usage: tellatio folders sources <folder> [--groups true|false] [--contacts true|false] ...");
  assertNotBanFolderName(name, "list/add/remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const updated = cloneDialogFolder(folder, sourceFlagOverrides(folder, flags));
  ensureFolderHasSourceOrPeers(updated);

  if (dryRun(flags)) {
    folderDryRun("folders.sources", folder, updated);
    return;
  }

  const ok = await saveDialogFolder(updated);
  out({ updated: ok, folder: serializeFolder(updated) });
}

async function cmdFoldersReorder(positional: string[], flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("reorder folders");
  const order = csv(positional[0] || "");
  if (order.length === 0) die("Usage: tellatio folders reorder <folder1,folder2,...>");

  const filters = await loadDialogFilters();
  const folders = namedDialogFolders(filters);
  const seen = new Set<number>();
  const selected: typeof folders = [];

  for (const name of order) {
    const folder = selectDialogFolder(filters, name);
    if (seen.has(folder.id)) die(`Duplicate folder in reorder list: ${name}`);
    seen.add(folder.id);
    selected.push(folder);
  }

  const remaining = folders.filter((folder) => !seen.has(folder.id));
  const nextFolders = [...selected, ...remaining];
  // Preserve the All Chats tab's position and every shared folder.
  let index = 0;
  const nextOrder = filters.map((filter) => filter instanceof Api.DialogFilterDefault ? 0 : nextFolders[index++].id);

  if (dryRun(flags)) {
    out({
      dryRun: true,
      action: "folders.reorder",
      before: folders.map(serializeFolder),
      after: nextFolders.map(serializeFolder),
      order: nextOrder,
    });
    return;
  }

  const ok = await client.invoke(new Api.messages.UpdateDialogFiltersOrder({ order: nextOrder }));
  out({ updated: ok, order: nextFolders.map(serializeFolder) });
}

// ── bans ────────────────────────────────────────────────────────

async function cmdBansList(): Promise<void> {
  const folderName = banFolderNameFromEnv();
  const folder = findDialogFolder(await loadDialogFilters(), folderName);
  await refreshActiveBanList();
  out({
    folder: activeBanFolderSummary(folder),
    counts: {
      total: activeBanList.users.length,
    },
    users: activeBanList.users.map(serializeBan),
  });
}

async function cmdBansAdd(positional: string[], flags: Record<string, string>): Promise<void> {
  const identifier = positional[0];
  if (!identifier) die("Usage: tellatio bans add <username-or-chat-id> [--reason text]");

  const folderName = banFolderNameFromEnv();
  validateDialogFolderName(folderName);
  const filters = await loadDialogFilters();
  const folder = findDialogFolder(filters, folderName);
  const entity = await resolveEntity(identifier);
  const peer = await client.getInputEntity(entity) as unknown as Api.TypeInputPeer;
  const entry = banEntryFromEntity(entity, flags["reason"]);
  const existingKeys = new Set(folder?.includePeers.map(inputPeerKey) || []);
  const alreadyPresent = existingKeys.has(inputPeerKey(peer));

  const updated = folder
    ? (alreadyPresent ? folder : cloneDialogFolder(folder, { includePeers: [...folder.includePeers, peer] }))
    : new Api.DialogFilter({
      id: nextDialogFolderId(filters),
      title: folderTitle(folderName),
      pinnedPeers: [],
      includePeers: [peer],
      excludePeers: [],
    });

  if (dryRun(flags)) {
    out({
      dryRun: true,
      action: "bans.add",
      folder: activeBanFolderSummary(folder),
      after: activeBanFolderSummary(updated),
      alreadyPresent,
      user: serializeBan(entry),
    });
    return;
  }

  const ok = alreadyPresent ? true : await saveDialogFolder(updated);
  await refreshActiveBanList();
  out({
    updated: ok,
    folder: activeBanFolderSummary(updated),
    alreadyPresent,
    added: serializeBan(entry),
    users: activeBanList.users.map(serializeBan),
  });
}

async function cmdBansRemove(positional: string[], flags: Record<string, string>): Promise<void> {
  const identifier = positional[0];
  if (!identifier) die("Usage: tellatio bans remove <username-or-chat-id>");

  const folderName = banFolderNameFromEnv();
  const folder = findDialogFolder(await loadDialogFilters(), folderName);
  if (!folder) {
    out({
      folder: activeBanFolderSummary(folder),
      removed: [],
      users: [],
    });
    return;
  }

  const entity = await resolveEntity(identifier);
  const peer = await client.getInputEntity(entity) as unknown as Api.TypeInputPeer;
  const removeKey = inputPeerKey(peer);
  const removed = folder.includePeers.some((existing) => inputPeerKey(existing) === removeKey);
  const includePeers = folder.includePeers.filter((existing) => inputPeerKey(existing) !== removeKey);
  const pinnedPeers = folder.pinnedPeers.filter((existing) => inputPeerKey(existing) !== removeKey);
  const updated = cloneDialogFolder(folder, { includePeers, pinnedPeers });
  const willDeleteFolder = removed && includePeers.length === 0 && !folderHasBuiltInSource(folder);

  if (dryRun(flags)) {
    out({
      dryRun: true,
      action: "bans.remove",
      folder: activeBanFolderSummary(folder),
      after: willDeleteFolder ? { folderName, exists: false, peerCount: 0 } : activeBanFolderSummary(updated),
      removed,
      user: serializeBan(banEntryFromEntity(entity)),
    });
    return;
  }

  let ok = true;
  if (removed && willDeleteFolder) {
    ok = await client.invoke(new Api.messages.UpdateDialogFilter({ id: folder.id }));
  } else if (removed) {
    ok = await saveDialogFolder(updated);
  }
  await refreshActiveBanList();
  out({
    updated: ok,
    folder: willDeleteFolder ? { folderName, exists: false, peerCount: 0 } : activeBanFolderSummary(updated),
    removed: removed ? [serializeBan(banEntryFromEntity(entity))] : [],
    users: activeBanList.users.map(serializeBan),
  });
}

async function cmdBansCheck(positional: string[]): Promise<void> {
  const identifier = positional[0];
  if (!identifier) die("Usage: tellatio bans check <username-or-chat-id>");

  const entity = await resolveEntity(identifier);
  const match = matchBannedEntity(loadCliBanList(), entity) || matchBannedIdentifier(loadCliBanList(), identifier);
  out({
    folderName: banFolderNameFromEnv(),
    banned: Boolean(match),
    user: match ? serializeBan(match) : undefined,
  });
}

// ── msg ─────────────────────────────────────────────────────────

async function cmdMsgRead(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio msg read <chat> [--limit N] [--since X] [--until X] [--date X]");

  let limit = numFlag(flags, "limit", 50);
  const offsetId = numFlag(flags, "offset-id", 0);
  const minId = numFlag(flags, "min-id", 0);

  // Date shorthand: --date yesterday = --since yesterday --until yesterday
  if (flags["date"]) {
    flags["since"] = flags["date"];
    flags["until"] = flags["date"];
  }

  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : 0;
  const untilTs = flags["until"] ? parseUntilFilter(flags["until"]) : 0;

  // If time-filtering, fetch more to ensure we have enough
  if (sinceTs || untilTs) limit = Math.max(limit, 200);

  assertIdentifierAllowed(chatId, "read messages from");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "read messages from");
  const banList = loadCliBanList();
  let messages = await client.getMessages(entity, { limit, offsetId, minId });

  // Apply time filters
  messages = filterBannedMessages(messages, banList);
  if (sinceTs) messages = messages.filter((m) => m.date >= sinceTs);
  if (untilTs) messages = messages.filter((m) => m.date <= untilTs);

  out({ _advisory: UNTRUSTED_ADVISORY, untrusted: true, messages: messages.map((m) => serializeMessage(m)) });
}

async function cmdMsgSend(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const text = positional.slice(1).join(" ");
  if (!chatId || !text) die("Usage: tellatio msg send <chat> <text> [--reply-to N] [--silent] [--no-preview]");

  assertIdentifierAllowed(chatId, "send messages to");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "send messages to");
  const replyTo = flags["reply-to"] ? parseInt(flags["reply-to"], 10) : undefined;
  const silent = flags["silent"] === "true";
  const noWebpage = flags["no-preview"] === "true";

  const result = await client.sendMessage(entity, {
    message: text,
    replyTo,
    silent,
    linkPreview: !noWebpage,
  });
  out(serializeMessage(result));
}

async function cmdMsgEdit(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  const text = positional.slice(2).join(" ");
  if (!chatId || !msgId || !text) die("Usage: tellatio msg edit <chat> <msg-id> <text>");

  assertIdentifierAllowed(chatId, "edit messages in");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "edit messages in");
  const result = await client.editMessage(entity, {
    message: parseInt(msgId, 10),
    text,
  });
  out(serializeMessage(result));
}

async function cmdMsgDelete(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const msgIds = positional.slice(1).map((id) => parseInt(id, 10));
  if (!chatId || msgIds.length === 0) die("Usage: tellatio msg delete <chat> <msg-id> [msg-id...] [--revoke]");

  assertIdentifierAllowed(chatId, "delete messages in");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "delete messages in");
  const revoke = flags["revoke"] === "true";
  await client.deleteMessages(entity, msgIds, { revoke });
  out({ deleted: msgIds });
}

async function cmdMsgForward(positional: string[]): Promise<void> {
  const fromChat = positional[0];
  const toChat = positional[1];
  const msgIds = positional.slice(2).map((id) => parseInt(id, 10));
  if (!fromChat || !toChat || msgIds.length === 0) die("Usage: tellatio msg forward <from-chat> <to-chat> <msg-id> [msg-id...]");

  assertIdentifierAllowed(fromChat, "forward messages from");
  assertIdentifierAllowed(toChat, "forward messages to");
  const fromEntity = await resolveEntity(fromChat);
  const toEntity = await resolveEntity(toChat);
  assertEntityAllowed(fromEntity, "forward messages from");
  assertEntityAllowed(toEntity, "forward messages to");
  const result = await client.forwardMessages(toEntity, { messages: msgIds, fromPeer: fromEntity });
  out((result as Api.Message[]).map((m) => serializeMessage(m)));
}

async function cmdMsgSearch(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const query = positional.slice(1).join(" ");
  if (!chatId || !query) die("Usage: tellatio msg search <chat> <query> [--limit N]");

  const limit = numFlag(flags, "limit", 20);
  assertIdentifierAllowed(chatId, "search messages from");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "search messages from");
  const banList = loadCliBanList();

  const result = await client.invoke(new Api.messages.Search({
    peer: await client.getInputEntity(entity),
    q: query,
    filter: new Api.InputMessagesFilterEmpty(),
    minDate: 0,
    maxDate: 0,
    offsetId: 0,
    addOffset: 0,
    limit,
    maxId: 0,
    minId: 0,
    hash: BigInt(0) as any,
  }));

  if (result instanceof Api.messages.Messages || result instanceof Api.messages.MessagesSlice || result instanceof Api.messages.ChannelMessages) {
    const msgs = result.messages
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .filter((m) => !isMessageFromBannedUser(m, banList))
      .map((m) => serializeMessage(m));
    out({ _advisory: UNTRUSTED_ADVISORY, untrusted: true, messages: msgs });
  } else {
    out({ _advisory: UNTRUSTED_ADVISORY, untrusted: true, messages: [] });
  }
}

async function cmdMsgPin(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  if (!chatId || !msgId) die("Usage: tellatio msg pin <chat> <msg-id> [--silent]");

  assertIdentifierAllowed(chatId, "pin messages in");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "pin messages in");
  const silent = flags["silent"] === "true";
  await client.pinMessage(entity, parseInt(msgId, 10), { notify: !silent });
  out({ pinned: parseInt(msgId, 10) });
}

async function cmdMsgUnpin(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  if (!chatId || !msgId) die("Usage: tellatio msg unpin <chat> <msg-id>");

  assertIdentifierAllowed(chatId, "unpin messages in");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "unpin messages in");
  await client.invoke(new Api.messages.UpdatePinnedMessage({
    peer: await client.getInputEntity(entity),
    id: parseInt(msgId, 10),
    unpin: true,
  }));
  out({ unpinned: parseInt(msgId, 10) });
}

async function cmdMsgSchedule(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const text = positional.slice(1).join(" ");
  if (!chatId || !text || !flags["at"]) die("Usage: tellatio msg schedule <chat> <text> --at <YYYY-MM-DDTHH:MM> [--reply-to N]");

  assertIdentifierAllowed(chatId, "schedule messages to");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "schedule messages to");
  const replyTo = flags["reply-to"] ? parseInt(flags["reply-to"], 10) : undefined;

  // Parse --at as ISO datetime
  const scheduleDate = Math.floor(new Date(flags["at"]).getTime() / 1000);
  if (!scheduleDate || scheduleDate < Date.now() / 1000) die("--at must be a future datetime (YYYY-MM-DDTHH:MM)");

  const result = await client.sendMessage(entity, {
    message: text,
    replyTo,
    schedule: scheduleDate,
  });
  out(serializeMessage(result));
}

async function cmdMsgScheduleList(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio msg schedule-list <chat>");

  assertIdentifierAllowed(chatId, "list scheduled messages for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "list scheduled messages for");
  const result = await client.invoke(new Api.messages.GetScheduledHistory({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    hash: BigInt(0) as any,
  }));

  if ("messages" in result) {
    const msgs = (result.messages as Api.Message[])
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((m) => serializeMessage(m));
    out(msgs);
  } else {
    out([]);
  }
}

async function cmdMsgScheduleDelete(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const msgIds = positional.slice(1).map((id) => parseInt(id, 10));
  if (!chatId || msgIds.length === 0) die("Usage: tellatio msg schedule-delete <chat> <msg-id> [msg-id...]");

  assertIdentifierAllowed(chatId, "delete scheduled messages for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "delete scheduled messages for");
  await client.invoke(new Api.messages.DeleteScheduledMessages({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    id: msgIds,
  }));
  out({ deleted: msgIds });
}

async function cmdMsgMarkRead(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio msg mark-read <chat> [--max-id N]");

  assertIdentifierAllowed(chatId, "mark read");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "mark read");
  const maxId = numFlag(flags, "max-id", 0);
  await client.markAsRead(entity, maxId || undefined);
  out({ markedRead: chatId });
}

// ── contacts ────────────────────────────────────────────────────

async function cmdContactsList(): Promise<void> {
  const banList = loadCliBanList();
  const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }));
  if (result instanceof Api.contacts.Contacts) {
    const users = result.users
      .filter((u): u is Api.User => u instanceof Api.User)
      .filter((u) => !matchBannedEntity(banList, u))
      .map((u) => serializeUser(u));
    out(users);
  } else {
    out([]);
  }
}

async function cmdContactsAdd(positional: string[]): Promise<void> {
  const phone = positional[0];
  const firstName = positional[1];
  const lastName = positional[2] || "";
  if (!phone || !firstName) die("Usage: tellatio contacts add <phone> <first-name> [last-name]");

  const result = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: BigInt(0) as any,
      phone,
      firstName,
      lastName,
    })],
  }));
  const users = result.users
    .filter((u): u is Api.User => u instanceof Api.User)
    .map((u) => serializeUser(u));
  out({ imported: users, retryContacts: result.retryContacts.length });
}

async function cmdContactsDelete(positional: string[]): Promise<void> {
  const userId = positional[0];
  if (!userId) die("Usage: tellatio contacts delete <user>");
  const entity = await resolveEntity(userId);
  if (!(entity instanceof Api.User)) die("Not a user");
  await client.invoke(new Api.contacts.DeleteContacts({
    id: [await client.getInputEntity(entity) as unknown as Api.InputUser],
  }));
  out({ deleted: userId });
}

async function cmdContactsBlock(positional: string[]): Promise<void> {
  const userId = positional[0];
  if (!userId) die("Usage: tellatio contacts block <user>");
  const entity = await resolveEntity(userId);
  await client.invoke(new Api.contacts.Block({
    id: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
  }));
  out({ blocked: userId });
}

async function cmdContactsUnblock(positional: string[]): Promise<void> {
  const userId = positional[0];
  if (!userId) die("Usage: tellatio contacts unblock <user>");
  const entity = await resolveEntity(userId);
  await client.invoke(new Api.contacts.Unblock({
    id: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
  }));
  out({ unblocked: userId });
}

// ── group ───────────────────────────────────────────────────────

async function cmdGroupCreate(positional: string[], flags: Record<string, string>): Promise<void> {
  const title = positional[0];
  const userIds = positional.slice(1);
  if (!title || userIds.length === 0) die("Usage: tellatio group create <title> <user> [user...]");

  const users: Api.TypeInputUser[] = [];
  for (const uid of userIds) {
    const entity = await resolveEntity(uid);
    users.push(await client.getInputEntity(entity) as unknown as Api.InputUser);
  }

  const result = await client.invoke(new Api.messages.CreateChat({
    title,
    users,
  }));
  out({ created: true, title });
}

async function cmdGroupInfo(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio group info <chat>");
  assertIdentifierAllowed(chatId, "inspect group");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "inspect group");

  const info = serializeChat(entity);

  // Get full info for description, etc.
  if (entity instanceof Api.Channel) {
    try {
      const full = await client.invoke(new Api.channels.GetFullChannel({
        channel: await client.getInputEntity(entity) as unknown as Api.InputChannel,
      }));
      if (full.fullChat instanceof Api.ChannelFull) {
        (info as any).about = full.fullChat.about;
        (info as any).membersCount = full.fullChat.participantsCount;
        (info as any).adminsCount = full.fullChat.adminsCount;
        (info as any).onlineCount = full.fullChat.onlineCount;
      }
    } catch {}
  }

  out(info);
}

async function cmdGroupMembers(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio group members <chat> [--limit N]");

  const limit = numFlag(flags, "limit", 200);
  const banList = loadCliBanList();
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "list members for");
  const participants = await client.getParticipants(entity, { limit });

  const members = participants
    .filter((u): u is Api.User => u instanceof Api.User)
    .filter((u) => !matchBannedEntity(banList, u))
    .map((u) => serializeUser(u));
  out(members);
}

async function cmdGroupAdd(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const userId = positional[1];
  if (!chatId || !userId) die("Usage: tellatio group add <chat> <user>");

  assertIdentifierAllowed(chatId, "add members to");
  assertIdentifierAllowed(userId, "add banned users to groups");
  const chatEntity = await resolveEntity(chatId);
  const userEntity = await resolveEntity(userId);
  assertEntityAllowed(chatEntity, "add members to");
  assertEntityAllowed(userEntity, "add banned users to groups");

  if (chatEntity instanceof Api.Channel) {
    await client.invoke(new Api.channels.InviteToChannel({
      channel: await client.getInputEntity(chatEntity) as unknown as Api.InputChannel,
      users: [await client.getInputEntity(userEntity) as unknown as Api.InputUser],
    }));
  } else {
    await client.invoke(new Api.messages.AddChatUser({
      chatId: chatEntity.id as any,
      userId: await client.getInputEntity(userEntity) as unknown as Api.InputUser,
      fwdLimit: 100,
    }));
  }
  out({ added: userId, to: chatId });
}

async function cmdGroupKick(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const userId = positional[1];
  if (!chatId || !userId) die("Usage: tellatio group kick <chat> <user>");

  assertIdentifierAllowed(chatId, "remove members from");
  const chatEntity = await resolveEntity(chatId);
  const userEntity = await resolveEntity(userId);
  assertEntityAllowed(chatEntity, "remove members from");

  if (chatEntity instanceof Api.Channel) {
    await client.invoke(new Api.channels.EditBanned({
      channel: await client.getInputEntity(chatEntity) as unknown as Api.InputChannel,
      participant: await client.getInputEntity(userEntity) as unknown as Api.TypeInputPeer,
      bannedRights: new Api.ChatBannedRights({
        untilDate: 0,
        viewMessages: true,
      }),
    }));
  } else {
    await client.invoke(new Api.messages.DeleteChatUser({
      chatId: chatEntity.id as any,
      userId: await client.getInputEntity(userEntity) as unknown as Api.InputUser,
    }));
  }
  out({ kicked: userId, from: chatId });
}

async function cmdGroupTitle(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const title = positional.slice(1).join(" ");
  if (!chatId || !title) die("Usage: tellatio group title <chat> <new-title>");

  assertIdentifierAllowed(chatId, "edit group title for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "edit group title for");

  if (entity instanceof Api.Channel) {
    await client.invoke(new Api.channels.EditTitle({
      channel: await client.getInputEntity(entity) as unknown as Api.InputChannel,
      title,
    }));
  } else {
    await client.invoke(new Api.messages.EditChatTitle({
      chatId: entity.id as any,
      title,
    }));
  }
  out({ chatId, title });
}

async function cmdGroupLeave(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio group leave <chat>");

  assertIdentifierAllowed(chatId, "leave");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "leave");

  if (entity instanceof Api.Channel) {
    await client.invoke(new Api.channels.LeaveChannel({
      channel: await client.getInputEntity(entity) as unknown as Api.InputChannel,
    }));
  } else {
    const me = await client.getMe() as Api.User;
    await client.invoke(new Api.messages.DeleteChatUser({
      chatId: entity.id as any,
      userId: await client.getInputEntity(me) as unknown as Api.InputUser,
    }));
  }
  out({ left: chatId });
}

async function cmdGroupDescription(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const about = positional.slice(1).join(" ");
  if (!chatId) die("Usage: tellatio group description <chat> <text>");

  assertIdentifierAllowed(chatId, "edit group description for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "edit group description for");

  await client.invoke(new Api.messages.EditChatAbout({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    about: about || "",
  }));
  out({ chatId, about });
}

// ── media ───────────────────────────────────────────────────────

async function cmdMediaSend(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const filePath = positional[1];
  const caption = positional.slice(2).join(" ") || undefined;
  if (!chatId || !filePath) die("Usage: tellatio media send <chat> <file-path> [caption] [--voice] [--video-note]");

  assertWritesAllowed("send media");
  const upload = readUpload(dataDirFromEnv(), filePath);

  assertIdentifierAllowed(chatId, "send media to");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "send media to");
  const voiceNote = flags["voice"] === "true";
  const videoNote = flags["video-note"] === "true";

  const result = await client.sendFile(entity, {
    file: new CustomFile(upload.name, upload.buffer.length, "", upload.buffer),
    caption,
    voiceNote,
    videoNote,
  });
  out(serializeMessage(result));
}

async function cmdMediaDownload(positional: string[]): Promise<void> {
  assertWritesAllowed("download media");
  const chatId = positional[0];
  const msgId = positional[1];
  const outputPath = positional[2];
  if (!chatId || !msgId || !outputPath) die("Usage: tellatio media download <chat> <msg-id> <output-path>");

  assertIdentifierAllowed(chatId, "download media from");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "download media from");
  const messages = await client.getMessages(entity, { ids: [parseInt(msgId, 10)] });
  if (messages.length === 0) die("Message not found");

  const msg = messages[0];
  if (!msg.media || msg.media instanceof Api.MessageMediaEmpty) die("No media in this message");

  const download = createDownload(dataDirFromEnv(), outputPath);
  try {
    await client.downloadMedia(msg, { outputFile: download.writer as any });
    if (download.size === 0) die("No downloadable media bytes");
    out({ downloaded: download.path, size: download.size });
  } catch (err) {
    download.discard();
    throw err;
  } finally {
    download.close();
  }
}

// ── profile ─────────────────────────────────────────────────────

async function cmdProfileSetBio(positional: string[]): Promise<void> {
  const bio = positional.join(" ");
  await client.invoke(new Api.account.UpdateProfile({ about: bio }));
  out({ bio });
}

async function cmdProfileSetName(positional: string[]): Promise<void> {
  const firstName = positional[0];
  const lastName = positional.slice(1).join(" ") || "";
  if (!firstName) die("Usage: tellatio profile set-name <first-name> [last-name]");
  await client.invoke(new Api.account.UpdateProfile({ firstName, lastName }));
  out({ firstName, lastName });
}

async function cmdProfileSetUsername(positional: string[]): Promise<void> {
  const username = positional[0] || "";
  await client.invoke(new Api.account.UpdateUsername({ username }));
  out({ username });
}

// ── drafts ──────────────────────────────────────────────────────

async function cmdDraftSet(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const text = positional.slice(1).join(" ");
  if (!chatId) die("Usage: tellatio draft set <chat> <text>");

  assertIdentifierAllowed(chatId, "set drafts for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "set drafts for");
  await client.invoke(new Api.messages.SaveDraft({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    message: text || "",
  }));
  out({ chatId, draft: text });
}

async function cmdDraftClear(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio draft clear <chat>");

  assertIdentifierAllowed(chatId, "clear drafts for");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "clear drafts for");
  await client.invoke(new Api.messages.SaveDraft({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    message: "",
  }));
  out({ chatId, draft: null });
}



export {
cmdBansAdd,cmdBansCheck,cmdBansList,cmdBansRemove,cmdChatsActivity,cmdChatsFolder,cmdChatsInfo,cmdChatsList,cmdChatsResolve,cmdChatsSearch,cmdChatsStatus,cmdChatsUnread,cmdContactsAdd,cmdContactsBlock,cmdContactsDelete,cmdContactsList,cmdContactsUnblock,cmdDraftClear,cmdDraftSet,cmdFoldersAdd,cmdFoldersCreate,cmdFoldersDelete,cmdFoldersExcludeAdd,
cmdFoldersExcludeRemove,cmdFoldersInfo,cmdFoldersList,cmdFoldersPin,cmdFoldersRemove,cmdFoldersRename,cmdFoldersReorder,cmdFoldersSources,cmdFoldersUnpin,cmdFoldersUpdate,cmdGroupAdd,cmdGroupCreate,cmdGroupDescription,cmdGroupInfo,cmdGroupKick,cmdGroupLeave,cmdGroupMembers,cmdGroupTitle,cmdMe,cmdMediaDownload,cmdMediaSend,cmdMsgDelete,cmdMsgEdit,cmdMsgForward,cmdMsgMarkRead,cmdMsgPin,cmdMsgRead,cmdMsgSchedule,cmdMsgScheduleDelete,cmdMsgScheduleList,cmdMsgSearch,cmdMsgSend,cmdMsgUnpin,cmdProfileSetBio,
cmdProfileSetName,
cmdProfileSetUsername
};
