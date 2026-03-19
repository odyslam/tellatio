#!/usr/bin/env node
/**
 * Tellatio CLI — Full Telegram API for agents.
 * All output is JSON for easy parsing.
 *
 * Usage: tellatio <command> [subcommand] [args] [--flags]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";

// ─── Env & Config ───────────────────────────────────────────────

function loadEnv(): void {
  try {
    const envPath = path.resolve(__dirname, "..", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { die(`Missing env var: ${name}`); }
  return v!;
}

// ─── Helpers ────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = "true";
        i++;
      }
    } else {
      positional.push(argv[i]);
      i++;
    }
  }
  return { positional, flags };
}

function flag(flags: Record<string, string>, name: string, def?: string): string | undefined {
  return flags[name] ?? def;
}

function numFlag(flags: Record<string, string>, name: string, def: number): number {
  const v = flags[name];
  return v ? parseInt(v, 10) : def;
}

// ─── Telegram Client ────────────────────────────────────────────

let client: TelegramClient;

async function connect(): Promise<void> {
  const apiId = parseInt(requireEnv("TELEGRAM_API_ID"), 10);
  const apiHash = requireEnv("TELEGRAM_API_HASH");
  const session = new StringSession(requireEnv("TELEGRAM_SESSION"));

  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });
  client.setLogLevel("error" as any);
  await client.connect();
}

async function disconnect(): Promise<void> {
  if (client) await client.disconnect();
}

// ─── Entity Resolution ─────────────────────────────────────────

async function resolveEntity(identifier: string): Promise<any> {
  // Try as username, phone, or ID
  try {
    return await client.getEntity(identifier);
  } catch {
    // Try as numeric ID
    try {
      const id = BigInt(identifier);
      return await client.getEntity(id as any);
    } catch {
      die(`Cannot resolve "${identifier}". Use a username, phone (+...), or numeric ID.`);
    }
  }
}

function serializeUser(u: Api.User): Record<string, unknown> {
  return {
    id: u.id.toString(),
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    phone: u.phone,
    bot: u.bot,
    verified: u.verified,
    premium: u.premium,
    status: u.status?.className,
  };
}

function serializeChat(c: any): Record<string, unknown> {
  if (c instanceof Api.User) return { type: "user", ...serializeUser(c) };
  if (c instanceof Api.Chat) return {
    type: "chat", id: c.id.toString(), title: c.title,
    participantsCount: c.participantsCount,
  };
  if (c instanceof Api.Channel) return {
    type: c.megagroup ? "supergroup" : "channel",
    id: c.id.toString(), title: c.title, username: c.username,
    participantsCount: c.participantsCount,
  };
  return { type: "unknown", id: String((c as any).id) };
}

function serializeMessage(m: Api.Message): Record<string, unknown> {
  let senderName = "Unknown";
  if (m.sender instanceof Api.User) {
    senderName = [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ") || "Unknown";
  } else if (m.sender && "title" in m.sender) {
    senderName = (m.sender as any).title;
  }

  return {
    id: m.id,
    date: m.date,
    dateISO: new Date(m.date * 1000).toISOString(),
    senderId: m.senderId?.toString(),
    senderName,
    text: m.text || m.message || "",
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
  const dialogs = await client.getDialogs({ limit });
  const results = dialogs.map((d) => ({
    id: d.id?.toString(),
    name: d.name || d.title,
    isGroup: d.isGroup,
    isChannel: d.isChannel,
    isUser: d.isUser,
    unreadCount: d.unreadCount,
    lastMessage: d.message ? {
      id: d.message.id,
      date: d.message.date,
      text: d.message.text || d.message.message || "",
    } : null,
  }));
  out(results);
}

async function cmdChatsSearch(positional: string[], flags: Record<string, string>): Promise<void> {
  const query = positional[0];
  if (!query) die("Usage: tellatio chats search <query>");
  const limit = numFlag(flags, "limit", 20);

  const result = await client.invoke(new Api.contacts.Search({ q: query, limit }));
  const entities: Record<string, unknown>[] = [];

  for (const u of result.users) {
    if (u instanceof Api.User) entities.push(serializeUser(u));
  }
  for (const c of result.chats) {
    entities.push(serializeChat(c as Api.User | Api.Chat | Api.Channel));
  }
  out(entities);
}

async function cmdChatsInfo(positional: string[]): Promise<void> {
  const id = positional[0];
  if (!id) die("Usage: tellatio chats info <chat>");
  const entity = await resolveEntity(id);
  out(serializeChat(entity));
}

async function cmdChatsFolder(positional: string[]): Promise<void> {
  const folderName = positional[0];
  if (!folderName) die("Usage: tellatio chats folder <name>");

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
  for (const peer of folder.includePeers) {
    try {
      const entity = await client.getEntity(peer);
      chats.push(serializeChat(entity));
    } catch {}
  }
  out(chats);
}

async function cmdChatsUnread(flags: Record<string, string>): Promise<void> {
  const limit = numFlag(flags, "limit", 50);
  const dialogs = await client.getDialogs({ limit });
  const unread = dialogs
    .filter((d) => d.unreadCount > 0)
    .map((d) => ({
      id: d.id?.toString(),
      name: d.name || d.title,
      isGroup: d.isGroup,
      isChannel: d.isChannel,
      unreadCount: d.unreadCount,
      lastMessage: d.message ? {
        id: d.message.id,
        date: d.message.date,
        dateISO: new Date(d.message.date * 1000).toISOString(),
        text: d.message.text || d.message.message || "",
      } : null,
    }));
  out(unread);
}

async function cmdChatsActivity(positional: string[], flags: Record<string, string>): Promise<void> {
  const folderName = positional[0];
  if (!folderName) die("Usage: tellatio chats activity <folder> [--since X]");

  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("today");

  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folder = result.filters.find(
    (f): f is Api.DialogFilter =>
      f instanceof Api.DialogFilter && f.title.text === folderName,
  );
  if (!folder) die(`Folder "${folderName}" not found`);

  const activity: Record<string, unknown>[] = [];

  for (const peer of folder.includePeers) {
    try {
      const entity = await client.getEntity(peer);
      const chatName = entity instanceof Api.User
        ? [entity.firstName, entity.lastName].filter(Boolean).join(" ")
        : (entity as any).title || "Unknown";

      const messages = await client.getMessages(entity, { limit: 100 });
      const recent = messages.filter((m) => m.date >= sinceTs);

      if (recent.length > 0) {
        activity.push({
          chat: chatName,
          chatId: (entity as any).id?.toString(),
          isGroup: !(entity instanceof Api.User),
          messageCount: recent.length,
          lastMessage: {
            date: recent[0].date,
            dateISO: new Date(recent[0].date * 1000).toISOString(),
            text: (recent[0].text || recent[0].message || "").slice(0, 200),
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

  const entity = await resolveEntity(chatId);
  if (!(entity instanceof Api.User)) die("Online status is only available for users, not groups/channels");

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

// ── folders ─────────────────────────────────────────────────────

async function cmdFoldersList(): Promise<void> {
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folders = result.filters
    .filter((f): f is Api.DialogFilter => f instanceof Api.DialogFilter)
    .map((f) => ({
      id: f.id,
      title: f.title.text,
      peerCount: f.includePeers.length,
      emoticon: f.emoticon,
    }));
  out(folders);
}

// ── msg ─────────────────────────────────────────────────────────

/**
 * Parse a --since or --date value into a unix timestamp.
 * Supports: "yesterday", "today", "Nd" (N days ago), "Nh" (N hours ago), "YYYY-MM-DD"
 */
function parseTimeFilter(value: string): number {
  const now = Date.now();
  const v = value.toLowerCase().trim();

  if (v === "yesterday") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  if (v === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Relative: "2d", "3h", "30m"
  const relMatch = v.match(/^(\d+)([dhm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return Math.floor((now - ms) / 1000);
  }

  // Absolute date: YYYY-MM-DD
  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return Math.floor(new Date(v + "T00:00:00Z").getTime() / 1000);
  }

  die(`Cannot parse time: "${value}". Use: yesterday, today, Nd, Nh, Nm, or YYYY-MM-DD`);
}

function parseUntilFilter(value: string): number {
  const v = value.toLowerCase().trim();

  // For a date, set to end of that day
  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return Math.floor(new Date(v + "T23:59:59Z").getTime() / 1000);
  }
  if (v === "yesterday") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(23, 59, 59, 0);
    return Math.floor(d.getTime() / 1000);
  }
  if (v === "today") {
    return Math.floor(Date.now() / 1000);
  }

  // Otherwise same as since
  return parseTimeFilter(value);
}

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

  const entity = await resolveEntity(chatId);
  let messages = await client.getMessages(entity, { limit, offsetId, minId });

  // Apply time filters
  if (sinceTs) messages = messages.filter((m) => m.date >= sinceTs);
  if (untilTs) messages = messages.filter((m) => m.date <= untilTs);

  out(messages.map((m) => serializeMessage(m)));
}

async function cmdMsgSend(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const text = positional.slice(1).join(" ");
  if (!chatId || !text) die("Usage: tellatio msg send <chat> <text> [--reply-to N] [--silent] [--no-preview]");

  const entity = await resolveEntity(chatId);
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

  const entity = await resolveEntity(chatId);
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

  const entity = await resolveEntity(chatId);
  const revoke = flags["revoke"] === "true";
  await client.deleteMessages(entity, msgIds, { revoke });
  out({ deleted: msgIds });
}

async function cmdMsgForward(positional: string[]): Promise<void> {
  const fromChat = positional[0];
  const toChat = positional[1];
  const msgIds = positional.slice(2).map((id) => parseInt(id, 10));
  if (!fromChat || !toChat || msgIds.length === 0) die("Usage: tellatio msg forward <from-chat> <to-chat> <msg-id> [msg-id...]");

  const fromEntity = await resolveEntity(fromChat);
  const toEntity = await resolveEntity(toChat);
  const result = await client.forwardMessages(toEntity, { messages: msgIds, fromPeer: fromEntity });
  out((result as Api.Message[]).map((m) => serializeMessage(m)));
}

async function cmdMsgSearch(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const query = positional.slice(1).join(" ");
  if (!chatId || !query) die("Usage: tellatio msg search <chat> <query> [--limit N]");

  const limit = numFlag(flags, "limit", 20);
  const entity = await resolveEntity(chatId);

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
      .map((m) => serializeMessage(m));
    out(msgs);
  } else {
    out([]);
  }
}

async function cmdMsgPin(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  if (!chatId || !msgId) die("Usage: tellatio msg pin <chat> <msg-id> [--silent]");

  const entity = await resolveEntity(chatId);
  const silent = flags["silent"] === "true";
  await client.pinMessage(entity, parseInt(msgId, 10), { notify: !silent });
  out({ pinned: parseInt(msgId, 10) });
}

async function cmdMsgUnpin(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  if (!chatId || !msgId) die("Usage: tellatio msg unpin <chat> <msg-id>");

  const entity = await resolveEntity(chatId);
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

  const entity = await resolveEntity(chatId);
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

  const entity = await resolveEntity(chatId);
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

  const entity = await resolveEntity(chatId);
  await client.invoke(new Api.messages.DeleteScheduledMessages({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    id: msgIds,
  }));
  out({ deleted: msgIds });
}

async function cmdMsgMarkRead(positional: string[], flags: Record<string, string>): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio msg mark-read <chat> [--max-id N]");

  const entity = await resolveEntity(chatId);
  const maxId = numFlag(flags, "max-id", 0);
  await client.markAsRead(entity, maxId || undefined);
  out({ markedRead: chatId });
}

// ── contacts ────────────────────────────────────────────────────

async function cmdContactsList(): Promise<void> {
  const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }));
  if (result instanceof Api.contacts.Contacts) {
    const users = result.users
      .filter((u): u is Api.User => u instanceof Api.User)
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
  const entity = await resolveEntity(chatId);

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
  const entity = await resolveEntity(chatId);
  const participants = await client.getParticipants(entity, { limit });

  const members = participants
    .filter((u): u is Api.User => u instanceof Api.User)
    .map((u) => serializeUser(u));
  out(members);
}

async function cmdGroupAdd(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const userId = positional[1];
  if (!chatId || !userId) die("Usage: tellatio group add <chat> <user>");

  const chatEntity = await resolveEntity(chatId);
  const userEntity = await resolveEntity(userId);

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

  const chatEntity = await resolveEntity(chatId);
  const userEntity = await resolveEntity(userId);

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

  const entity = await resolveEntity(chatId);

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

  const entity = await resolveEntity(chatId);

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

  const entity = await resolveEntity(chatId);

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

  if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);

  const entity = await resolveEntity(chatId);
  const voiceNote = flags["voice"] === "true";
  const videoNote = flags["video-note"] === "true";

  const result = await client.sendFile(entity, {
    file: filePath,
    caption,
    voiceNote,
    videoNote,
  });
  out(serializeMessage(result));
}

async function cmdMediaDownload(positional: string[]): Promise<void> {
  const chatId = positional[0];
  const msgId = positional[1];
  const outputPath = positional[2];
  if (!chatId || !msgId || !outputPath) die("Usage: tellatio media download <chat> <msg-id> <output-path>");

  const entity = await resolveEntity(chatId);
  const messages = await client.getMessages(entity, { ids: [parseInt(msgId, 10)] });
  if (messages.length === 0) die("Message not found");

  const msg = messages[0];
  if (!msg.media || msg.media instanceof Api.MessageMediaEmpty) die("No media in this message");

  const buffer = await client.downloadMedia(msg) as Buffer;
  if (!buffer) die("Failed to download media");

  fs.writeFileSync(outputPath, buffer);
  out({ downloaded: outputPath, size: buffer.length });
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

  const entity = await resolveEntity(chatId);
  await client.invoke(new Api.messages.SaveDraft({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    message: text || "",
  }));
  out({ chatId, draft: text });
}

async function cmdDraftClear(positional: string[]): Promise<void> {
  const chatId = positional[0];
  if (!chatId) die("Usage: tellatio draft clear <chat>");

  const entity = await resolveEntity(chatId);
  await client.invoke(new Api.messages.SaveDraft({
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    message: "",
  }));
  out({ chatId, draft: null });
}

// ── help ────────────────────────────────────────────────────────

function printHelp(): void {
  out({
    usage: "tellatio <command> [subcommand] [args] [--flags]",
    commands: {
      me: "Get your profile info",
      chats: {
        list: "List recent chats [--limit N]",
        search: "Search chats <query> [--limit N]",
        info: "Get chat details <chat>",
        folder: "List chats in a folder <name>",
        unread: "List chats with unread messages [--limit N]",
        activity: "Activity digest for a folder <name> [--since X]",
        status: "Check user's online status <user>",
      },
      folders: {
        list: "List all folders",
      },
      msg: {
        read: "Read messages <chat> [--limit N] [--since X] [--until X] [--date X]",
        send: "Send a message <chat> <text> [--reply-to N] [--silent] [--no-preview]",
        edit: "Edit a message <chat> <msg-id> <text>",
        delete: "Delete messages <chat> <msg-id> [msg-id...] [--revoke]",
        forward: "Forward messages <from-chat> <to-chat> <msg-id> [msg-id...]",
        search: "Search messages <chat> <query> [--limit N]",
        pin: "Pin a message <chat> <msg-id> [--silent]",
        unpin: "Unpin a message <chat> <msg-id>",
        "mark-read": "Mark chat as read <chat> [--max-id N]",
        schedule: "Schedule a message <chat> <text> --at <datetime>",
        "schedule-list": "List scheduled messages <chat>",
        "schedule-delete": "Delete scheduled messages <chat> <msg-id> [msg-id...]",
      },
      contacts: {
        list: "List all contacts",
        add: "Add a contact <phone> <first-name> [last-name]",
        delete: "Delete a contact <user>",
        block: "Block a user <user>",
        unblock: "Unblock a user <user>",
      },
      group: {
        create: "Create a group <title> <user> [user...]",
        info: "Get group info <chat>",
        members: "List members <chat> [--limit N]",
        add: "Add member <chat> <user>",
        kick: "Remove member <chat> <user>",
        title: "Set group title <chat> <new-title>",
        description: "Set group description <chat> <text>",
        leave: "Leave a group <chat>",
      },
      media: {
        send: "Send a file <chat> <file-path> [caption] [--voice] [--video-note]",
        download: "Download media <chat> <msg-id> <output-path>",
      },
      profile: {
        "set-bio": "Set bio <text>",
        "set-name": "Set name <first-name> [last-name]",
        "set-username": "Set username <username>",
      },
      draft: {
        set: "Set a draft <chat> <text>",
        clear: "Clear a draft <chat>",
      },
    },
    notes: [
      "<chat> can be a username (john_doe), phone (+1234567890), or numeric ID",
      "All output is JSON",
    ],
  });
}

// ─── Router ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const sub = positional[1];
  const rest = positional.slice(2);

  if (!cmd || cmd === "help") {
    printHelp();
    return;
  }

  await connect();

  try {
    switch (cmd) {
      case "me":
        await cmdMe();
        break;

      case "chats":
        switch (sub) {
          case "list": await cmdChatsList(flags); break;
          case "search": await cmdChatsSearch(rest, flags); break;
          case "info": await cmdChatsInfo(rest); break;
          case "folder": await cmdChatsFolder(rest); break;
          case "unread": await cmdChatsUnread(flags); break;
          case "activity": await cmdChatsActivity(rest, flags); break;
          case "status": await cmdChatsStatus(rest); break;
          default: die(`Unknown subcommand: chats ${sub}. Try: list, search, info, folder, unread, activity, status`);
        }
        break;

      case "folders":
        switch (sub) {
          case "list": await cmdFoldersList(); break;
          default: die(`Unknown subcommand: folders ${sub}. Try: list`);
        }
        break;

      case "msg":
        switch (sub) {
          case "read": await cmdMsgRead(rest, flags); break;
          case "send": await cmdMsgSend(rest, flags); break;
          case "edit": await cmdMsgEdit(rest); break;
          case "delete": await cmdMsgDelete(rest, flags); break;
          case "forward": await cmdMsgForward(rest); break;
          case "search": await cmdMsgSearch(rest, flags); break;
          case "pin": await cmdMsgPin(rest, flags); break;
          case "unpin": await cmdMsgUnpin(rest); break;
          case "mark-read": await cmdMsgMarkRead(rest, flags); break;
          case "schedule": await cmdMsgSchedule(rest, flags); break;
          case "schedule-list": await cmdMsgScheduleList(rest); break;
          case "schedule-delete": await cmdMsgScheduleDelete(rest); break;
          default: die(`Unknown subcommand: msg ${sub}. Try: read, send, edit, delete, forward, search, pin, unpin, mark-read, schedule, schedule-list, schedule-delete`);
        }
        break;

      case "contacts":
        switch (sub) {
          case "list": await cmdContactsList(); break;
          case "add": await cmdContactsAdd(rest); break;
          case "delete": await cmdContactsDelete(rest); break;
          case "block": await cmdContactsBlock(rest); break;
          case "unblock": await cmdContactsUnblock(rest); break;
          default: die(`Unknown subcommand: contacts ${sub}. Try: list, add, delete, block, unblock`);
        }
        break;

      case "group":
        switch (sub) {
          case "create": await cmdGroupCreate(rest, flags); break;
          case "info": await cmdGroupInfo(rest); break;
          case "members": await cmdGroupMembers(rest, flags); break;
          case "add": await cmdGroupAdd(rest); break;
          case "kick": await cmdGroupKick(rest); break;
          case "title": await cmdGroupTitle(rest); break;
          case "description": await cmdGroupDescription(rest); break;
          case "leave": await cmdGroupLeave(rest); break;
          default: die(`Unknown subcommand: group ${sub}. Try: create, info, members, add, kick, title, description, leave`);
        }
        break;

      case "media":
        switch (sub) {
          case "send": await cmdMediaSend(rest, flags); break;
          case "download": await cmdMediaDownload(rest); break;
          default: die(`Unknown subcommand: media ${sub}. Try: send, download`);
        }
        break;

      case "profile":
        switch (sub) {
          case "set-bio": await cmdProfileSetBio(rest); break;
          case "set-name": await cmdProfileSetName(rest); break;
          case "set-username": await cmdProfileSetUsername(rest); break;
          default: die(`Unknown subcommand: profile ${sub}. Try: set-bio, set-name, set-username`);
        }
        break;

      case "draft":
        switch (sub) {
          case "set": await cmdDraftSet(rest); break;
          case "clear": await cmdDraftClear(rest); break;
          default: die(`Unknown subcommand: draft ${sub}. Try: set, clear`);
        }
        break;

      default:
        die(`Unknown command: ${cmd}. Run "tellatio help" for usage.`);
    }
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
