import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TelegramClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { normalizeAssociationName } from "../association";
import * as attio from "../attio";
import { openState, type StateStore, type RunState } from "../state";
import {
  compileBanList,
  describeBannedUser,
  matchBannedIdentifier,
  matchBannedTelegramChat,
  matchBannedTelegramUser,
  parseEnvBannedUsers,
  type BanList,
  type BannedTelegramUser,
} from "../bans";
import { evaluateWriteGuard, sanitizeUntrusted, sanitizeUntrustedValue } from "../guard";

const execFileAsync = promisify(execFile);

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message === "TIMEOUT") return;
  throw reason;
});

// ─── Env & Config ───────────────────────────────────────────────

function projectRootDir(): string {
  return path.resolve(__dirname, "..", "..");
}

function loadEnv(): void {
  try {
    const envPath = path.join(projectRootDir(), ".env");
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

let commandOutput: unknown;
let activeBanList: BanList = compileBanList([]);

function die(msg: string): never {
  throw new Error(msg);
}

function out(data: unknown): void {
  commandOutput = sanitizeUntrustedValue(data);
}

function numFlag(flags: Record<string, string>, name: string, def: number): number {
  const v = flags[name];
  return v ? parseInt(v, 10) : def;
}

async function runTelegram(operation: () => Promise<void>): Promise<unknown> {
  commandOutput = undefined;
  loadEnv();
  await connect();
  try {
    await refreshActiveBanList();
    await operation();
    return commandOutput ?? null;
  } finally {
    await disconnect();
  }
}

async function runTelegramWrite(operation: string, fn: () => Promise<void>): Promise<unknown> {
  assertWritesAllowed(operation);
  return runTelegram(fn);
}

async function runTelegramMaybeWrite(operation: string, shouldGuard: boolean, fn: () => Promise<void>): Promise<unknown> {
  if (shouldGuard) assertWritesAllowed(operation);
  return runTelegram(fn);
}

async function runAttio(operation: () => Promise<void>): Promise<unknown> {
  commandOutput = undefined;
  loadEnv();
  attio.initAttio(requireEnv("ATTIO_API_KEY"));
  await operation();
  return commandOutput ?? null;
}

async function runTelegramAndAttio(operation: () => Promise<void>): Promise<unknown> {
  commandOutput = undefined;
  loadEnv();
  attio.initAttio(requireEnv("ATTIO_API_KEY"));
  await connect();
  try {
    await refreshActiveBanList();
    await operation();
    return commandOutput ?? null;
  } finally {
    await disconnect();
  }
}

async function runLocal(operation: () => Promise<void>): Promise<unknown> {
  commandOutput = undefined;
  loadEnv();
  await operation();
  return commandOutput ?? null;
}

function commandFlags(values: Record<string, string | number | boolean | undefined>): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    flags[key] = value === true ? "true" : String(value);
  }
  return flags;
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function flagEnabled(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

function dryRun(flags: Record<string, string>): boolean {
  return flagEnabled(flags, "dry-run") || flagEnabled(flags, "dryRun");
}

function parseBooleanValue(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  die(`${name} must be true or false`);
}

function optionalBooleanFlag(flags: Record<string, string>, name: string, fallback: boolean | undefined): boolean | undefined {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  return parseBooleanValue(raw, `--${name}`);
}

function dataDirFromEnv(): string {
  return process.env["DATA_DIR"] || path.join(projectRootDir(), "data");
}

function banFolderNameFromEnv(): string {
  return process.env["TELLATIO_BAN_FOLDER_NAME"] || "Banned";
}

function isBanFolderName(name: string): boolean {
  return name.trim().toLowerCase() === banFolderNameFromEnv().trim().toLowerCase();
}

function assertNotBanFolderName(name: string, operation: string): void {
  if (isBanFolderName(name)) {
    die(`Use tellatio bans ${operation} for the "${banFolderNameFromEnv()}" folder`);
  }
}

function openLocalState(): { dataDir: string; store: StateStore } {
  const dataDir = dataDirFromEnv();
  return { dataDir, store: openState(dataDir) };
}

function recordRunState(name: string, run: RunState): void {
  let store: StateStore | undefined;
  try {
    store = openLocalState().store;
    store.setRunState(name, run);
  } catch {
    // Run metadata is useful for doctor, but should not make the primary command fail.
  } finally {
    store?.close();
  }
}

function loadCliBanList(): BanList {
  return activeBanList;
}

async function refreshActiveBanList(): Promise<void> {
  activeBanList = compileBanList([
    ...parseEnvBannedUsers(),
    ...await loadBanFolderUsers(banFolderNameFromEnv()),
  ]);
}

function matchBannedEntity(banList: BanList, entity: unknown): BannedTelegramUser | undefined {
  if (entity instanceof Api.User) {
    return matchBannedTelegramChat(banList, {
      chatId: entity.id.toString(),
      chatType: "dm",
      userIdStr: entity.id.toString(),
      username: entity.username,
    });
  }

  if (entity instanceof Api.Chat) {
    return matchBannedTelegramChat(banList, {
      chatId: entity.id.toString(),
      chatType: "group",
    });
  }

  if (entity instanceof Api.Channel) {
    return matchBannedTelegramChat(banList, {
      chatId: entity.id.toString(),
      chatType: entity.megagroup ? "supergroup" : "channel",
      username: entity.username,
    });
  }

  return undefined;
}

async function loadBanFolderUsers(folderName: string): Promise<BannedTelegramUser[]> {
  const folder = findDialogFolder(await loadDialogFilters(), folderName);
  if (!folder) return [];

  const users: BannedTelegramUser[] = [];
  for (const peer of folder.includePeers) {
    try {
      const entity = await client.getEntity(peer);
      const chat = serializeChat(entity);
      if (entity instanceof Api.User) {
        users.push({
          chatId: entity.id.toString(),
          chatType: "dm",
          userId: entity.id.toString(),
          username: entity.username,
          displayName: chatDisplayName(entity),
          source: "folder",
        });
      } else if (entity instanceof Api.Chat) {
        users.push({
          chatId: entity.id.toString(),
          chatType: "group",
          displayName: entity.title,
          source: "folder",
        });
      } else if (entity instanceof Api.Channel) {
        users.push({
          chatId: entity.id.toString(),
          chatType: entity.megagroup ? "supergroup" : "channel",
          username: entity.username,
          displayName: entity.title,
          source: "folder",
        });
      } else {
        users.push({
          chatId: String(chat.id || inputPeerKey(peer)),
          chatType: "unknown",
          displayName: String(chat.title || chat.name || "unknown"),
          source: "folder",
        });
      }
    } catch {}
  }

  return users;
}

function serializeBan(entry: BannedTelegramUser): Record<string, unknown> {
  return {
    chatId: entry.chatId,
    chatType: entry.chatType,
    userId: entry.userId,
    username: entry.username,
    displayName: entry.displayName,
    reason: entry.reason,
    createdAt: entry.createdAt,
    source: entry.source,
  };
}

function banEntryFromEntity(entity: unknown, reason?: string): BannedTelegramUser {
  const createdAt = new Date().toISOString();
  if (entity instanceof Api.User) {
    return {
      chatId: entity.id.toString(),
      chatType: "dm",
      userId: entity.id.toString(),
      username: entity.username,
      displayName: chatDisplayName(entity),
      reason,
      createdAt,
      source: "folder",
    };
  }
  if (entity instanceof Api.Chat) {
    return {
      chatId: entity.id.toString(),
      chatType: "group",
      displayName: entity.title,
      reason,
      createdAt,
      source: "folder",
    };
  }
  if (entity instanceof Api.Channel) {
    return {
      chatId: entity.id.toString(),
      chatType: entity.megagroup ? "supergroup" : "channel",
      username: entity.username,
      displayName: entity.title,
      reason,
      createdAt,
      source: "folder",
    };
  }

  die("Cannot ban this Telegram entity type");
}

function activeBanFolderSummary(folder: Api.DialogFilter | undefined): Record<string, unknown> {
  return {
    folderName: banFolderNameFromEnv(),
    exists: Boolean(folder),
    peerCount: folder?.includePeers.length || 0,
  };
}

function assertIdentifierAllowed(identifier: string, operation: string): void {
  const match = matchBannedIdentifier(loadCliBanList(), identifier);
  if (match) {
    die(`Refusing to ${operation} banned Telegram user ${describeBannedUser(match)}`);
  }
}

function assertEntityAllowed(entity: unknown, operation: string): void {
  const match = matchBannedEntity(loadCliBanList(), entity);
  if (match) {
    die(`Refusing to ${operation} banned Telegram user ${describeBannedUser(match)}`);
  }
}

function assertWritesAllowed(operation: string): void {
  const decision = evaluateWriteGuard(operation);
  if (decision.mode === "off") return;
  if (decision.mode === "enforce" && !decision.allowed) {
    die(
      `Refusing to ${operation}: write-guard is in enforce mode. ` +
        `Set TELLATIO_ALLOW_WRITES=1 in the environment to allow this destructive operation.`,
    );
  }
  if (decision.mode === "warn") {
    console.error(
      "[write-guard] WARNING: performing destructive operation: " +
        operation +
        " (set TELLATIO_WRITE_GUARD=enforce to require confirmation)",
    );
  }
}

function isMessageFromBannedUser(message: Api.Message, banList: BanList): boolean {
  if (message.sender instanceof Api.User) {
    return Boolean(matchBannedTelegramUser(banList, {
      userIdStr: message.sender.id.toString(),
      username: message.sender.username,
    }));
  }

  return Boolean(matchBannedTelegramUser(banList, {
    userIdStr: message.senderId?.toString(),
  }));
}

function filterBannedMessages(messages: Api.Message[], banList: BanList): Api.Message[] {
  return messages.filter((message) => !isMessageFromBannedUser(message, banList));
}

function filterBannedDialogs<T extends { entity?: unknown }>(dialogs: T[], banList: BanList): T[] {
  return dialogs.filter((dialog) => !matchBannedEntity(banList, dialog.entity));
}

// ─── Telegram Client ────────────────────────────────────────────

let client: TelegramClient;

async function connect(): Promise<void> {
  const apiId = parseInt(requireEnv("TELEGRAM_API_ID"), 10);
  const apiHash = requireEnv("TELEGRAM_API_HASH");
  const session = new StringSession(requireEnv("TELEGRAM_SESSION"));

  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
  });
  client.setLogLevel(LogLevel.NONE);
  await client.connect();
}

async function disconnect(): Promise<void> {
  if (!client) return;
  try {
    await client.disconnect();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "TIMEOUT") {
      throw err;
    }
  }
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
      const dialogEntity = await resolveEntityFromRecentDialogs(identifier);
      if (dialogEntity) return dialogEntity;

      const folderEntity = await resolveEntityFromDialogFilters(identifier);
      if (folderEntity) return folderEntity;

      die(`Cannot resolve "${identifier}". Use a username, phone (+...), or numeric ID.`);
    }
  }
}

function entityIdString(entity: unknown): string | undefined {
  if (entity && typeof entity === "object" && "id" in entity) {
    return (entity as { id: unknown }).id?.toString();
  }

  return undefined;
}

function dialogCanonicalId(dialog: { id?: unknown; entity?: unknown }): string | undefined {
  const entityId = entityIdString(dialog.entity);
  if (entityId) return entityId;
  if (dialog && typeof dialog === "object" && "id" in dialog) {
    return (dialog as { id?: unknown }).id?.toString();
  }
  return undefined;
}

async function resolveEntityFromRecentDialogs(identifier: string): Promise<unknown | undefined> {
  const dialogs = await client.getDialogs({ limit: 500 });

  for (const dialog of dialogs) {
    const entity = dialog.entity as unknown;
    if (entityIdString(entity) === identifier) {
      return entity;
    }
  }

  return undefined;
}

async function resolveEntityFromDialogFilters(identifier: string): Promise<unknown | undefined> {
  const filters = await loadDialogFilters();
  const seen = new Set<string>();

  for (const filter of filters) {
    const peers = filter instanceof Api.DialogFilter
      ? [...filter.includePeers, ...filter.excludePeers, ...filter.pinnedPeers]
      : filter instanceof Api.DialogFilterChatlist
        ? [...filter.includePeers, ...filter.pinnedPeers]
        : [];

    for (const peer of peers) {
      const key = inputPeerKey(peer);
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const entity = await client.getEntity(peer);
        if (entityIdString(entity) === identifier) return entity;
      } catch {}
    }
  }

  return undefined;
}

function serializeUser(u: Api.User): Record<string, unknown> {
  return {
    id: u.id.toString(),
    firstName: sanitizeUntrusted(u.firstName) || undefined,
    lastName: sanitizeUntrusted(u.lastName) || undefined,
    username: u.username,
    phone: u.phone,
    bot: u.bot,
    verified: u.verified,
    premium: u.premium,
    status: u.status?.className,
  };
}

function serializeChat(c: any): Record<string, unknown> {
  if (c instanceof Api.User) return { type: "user", untrusted: true, ...serializeUser(c) };
  if (c instanceof Api.Chat) return {
    type: "chat", untrusted: true, id: c.id.toString(), title: sanitizeUntrusted(c.title),
    participantsCount: c.participantsCount,
  };
  if (c instanceof Api.Channel) return {
    type: c.megagroup ? "supergroup" : "channel", untrusted: true,
    id: c.id.toString(), title: sanitizeUntrusted(c.title), username: c.username,
    participantsCount: c.participantsCount,
  };
  return { type: "unknown", id: String((c as any).id) };
}

function serializeInputPeer(peer: Api.TypeInputPeer): Record<string, unknown> {
  if (peer instanceof Api.InputPeerSelf) return { type: "self", key: inputPeerKey(peer) };
  if (peer instanceof Api.InputPeerChat) return {
    type: "chat",
    key: inputPeerKey(peer),
    chatId: peer.chatId.toString(),
  };
  if (peer instanceof Api.InputPeerUser) return {
    type: "user",
    key: inputPeerKey(peer),
    userId: peer.userId.toString(),
    accessHash: peer.accessHash.toString(),
  };
  if (peer instanceof Api.InputPeerChannel) return {
    type: "channel",
    key: inputPeerKey(peer),
    channelId: peer.channelId.toString(),
    accessHash: peer.accessHash.toString(),
  };
  return { type: peer.className, key: inputPeerKey(peer) };
}

function associationChatType(c: unknown): "dm" | "group" | "supergroup" | "channel" | "unknown" {
  if (c instanceof Api.User) return "dm";
  if (c instanceof Api.Chat) return "group";
  if (c instanceof Api.Channel) return c.megagroup ? "supergroup" : "channel";
  return "unknown";
}

function chatDisplayName(c: unknown, fallback = "Unknown"): string {
  if (c instanceof Api.User) {
    return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.username || fallback;
  }
  if (c instanceof Api.Chat || c instanceof Api.Channel) return c.title;
  return fallback;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = normalizeAssociationName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

// ── folders ─────────────────────────────────────────────────────

interface ResolvedFolderPeer {
  peer: Api.TypeInputPeer;
  chat: Record<string, unknown>;
}

function isDialogFolder(filter: Api.TypeDialogFilter): filter is Api.DialogFilter {
  return filter instanceof Api.DialogFilter;
}

function dialogFolderTitle(folder: Api.DialogFilter): string {
  return folder.title.text;
}

function serializeFolder(folder: Api.DialogFilter): Record<string, unknown> {
  return {
    id: folder.id,
    title: dialogFolderTitle(folder),
    peerCount: folder.includePeers.length,
    pinnedPeerCount: folder.pinnedPeers.length,
    excludePeerCount: folder.excludePeers.length,
    contacts: Boolean(folder.contacts),
    nonContacts: Boolean(folder.nonContacts),
    groups: Boolean(folder.groups),
    channels: Boolean(folder.broadcasts),
    bots: Boolean(folder.bots),
    excludeMuted: Boolean(folder.excludeMuted),
    excludeRead: Boolean(folder.excludeRead),
    excludeArchived: Boolean(folder.excludeArchived),
    emoticon: folder.emoticon,
    color: folder.color,
  };
}

async function loadDialogFilters(): Promise<Api.TypeDialogFilter[]> {
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  return result.filters;
}

function dialogFolders(filters: Api.TypeDialogFilter[]): Api.DialogFilter[] {
  return filters.filter(isDialogFolder);
}

function findDialogFolder(filters: Api.TypeDialogFilter[], name: string): Api.DialogFilter | undefined {
  return dialogFolders(filters).find((folder) => dialogFolderTitle(folder) === name);
}

function requireDialogFolder(filters: Api.TypeDialogFilter[], name: string): Api.DialogFilter {
  const folder = findDialogFolder(filters, name);
  if (folder) return folder;

  const names = dialogFolders(filters).map(dialogFolderTitle);
  die(`Folder "${name}" not found. Available: ${names.join(", ")}`);
}

function nextDialogFolderId(filters: Api.TypeDialogFilter[]): number {
  const used = new Set<number>();
  for (const filter of filters) {
    if (filter instanceof Api.DialogFilter || filter instanceof Api.DialogFilterChatlist) {
      used.add(filter.id);
    }
  }

  for (let id = 2; id <= 255; id += 1) {
    if (!used.has(id)) return id;
  }

  die("No available Telegram folder IDs remain");
}

function folderTitle(title: string): Api.TextWithEntities {
  return new Api.TextWithEntities({ text: title, entities: [] });
}

function folderHasBuiltInSource(folder: Api.DialogFilter): boolean {
  return Boolean(folder.contacts || folder.nonContacts || folder.groups || folder.broadcasts || folder.bots);
}

function validateDialogFolderName(name: string): void {
  if (Array.from(name).length > 12) {
    die("Telegram folder names are limited to 12 characters");
  }
}

function cloneDialogFolder(
  folder: Api.DialogFilter,
  overrides: Partial<{
    contacts: boolean;
    nonContacts: boolean;
    groups: boolean;
    broadcasts: boolean;
    bots: boolean;
    excludeMuted: boolean;
    excludeRead: boolean;
    excludeArchived: boolean;
    id: number;
    title: Api.TypeTextWithEntities;
    emoticon: string;
    color: number;
    pinnedPeers: Api.TypeInputPeer[];
    includePeers: Api.TypeInputPeer[];
    excludePeers: Api.TypeInputPeer[];
  }>,
): Api.DialogFilter {
  return new Api.DialogFilter({
    contacts: overrides.contacts ?? folder.contacts,
    nonContacts: overrides.nonContacts ?? folder.nonContacts,
    groups: overrides.groups ?? folder.groups,
    broadcasts: overrides.broadcasts ?? folder.broadcasts,
    bots: overrides.bots ?? folder.bots,
    excludeMuted: overrides.excludeMuted ?? folder.excludeMuted,
    excludeRead: overrides.excludeRead ?? folder.excludeRead,
    excludeArchived: overrides.excludeArchived ?? folder.excludeArchived,
    titleNoanimate: folder.titleNoanimate,
    id: overrides.id ?? folder.id,
    title: overrides.title ?? folder.title,
    emoticon: overrides.emoticon ?? folder.emoticon,
    color: overrides.color ?? folder.color,
    pinnedPeers: overrides.pinnedPeers ?? folder.pinnedPeers,
    includePeers: overrides.includePeers ?? folder.includePeers,
    excludePeers: overrides.excludePeers ?? folder.excludePeers,
  });
}

async function saveDialogFolder(folder: Api.DialogFilter): Promise<boolean> {
  return await client.invoke(new Api.messages.UpdateDialogFilter({
    id: folder.id,
    filter: folder,
  }));
}

async function resolveFolderPeer(identifier: string): Promise<ResolvedFolderPeer> {
  const entity = await resolveEntity(identifier);
  return {
    peer: await client.getInputEntity(entity) as unknown as Api.TypeInputPeer,
    chat: serializeChat(entity),
  };
}

async function resolveFolderPeers(value: string): Promise<ResolvedFolderPeer[]> {
  const identifiers = csv(value);
  if (identifiers.length === 0) die("Expected at least one chat identifier");

  const peers: ResolvedFolderPeer[] = [];
  for (const identifier of identifiers) {
    peers.push(await resolveFolderPeer(identifier));
  }
  return peers;
}

function inputPeerKey(peer: Api.TypeInputPeer): string {
  if (peer instanceof Api.InputPeerSelf) return "self";
  if (peer instanceof Api.InputPeerChat) return `chat:${peer.chatId.toString()}`;
  if (peer instanceof Api.InputPeerUser) return `user:${peer.userId.toString()}`;
  if (peer instanceof Api.InputPeerChannel) return `channel:${peer.channelId.toString()}`;
  if (peer instanceof Api.InputPeerUserFromMessage) return `user:${peer.userId.toString()}`;
  if (peer instanceof Api.InputPeerChannelFromMessage) return `channel:${peer.channelId.toString()}`;

  return peer.className;
}

function folderDryRun(action: string, before: Api.DialogFilter | Api.DialogFilter[], after: Api.DialogFilter | Api.DialogFilter[], extra: Record<string, unknown> = {}): void {
  const serialize = (folder: Api.DialogFilter) => serializeFolder(folder);
  out({
    dryRun: true,
    action,
    before: Array.isArray(before) ? before.map(serialize) : serialize(before),
    after: Array.isArray(after) ? after.map(serialize) : serialize(after),
    ...extra,
  });
}

function sourceFlagOverrides(folder: Api.DialogFilter, flags: Record<string, string>): Partial<{
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
}> {
  return {
    contacts: optionalBooleanFlag(flags, "contacts", folder.contacts),
    nonContacts: optionalBooleanFlag(flags, "non-contacts", folder.nonContacts),
    groups: optionalBooleanFlag(flags, "groups", folder.groups),
    broadcasts: optionalBooleanFlag(flags, "channels", folder.broadcasts),
    bots: optionalBooleanFlag(flags, "bots", folder.bots),
    excludeMuted: optionalBooleanFlag(flags, "exclude-muted", folder.excludeMuted),
    excludeRead: optionalBooleanFlag(flags, "exclude-read", folder.excludeRead),
    excludeArchived: optionalBooleanFlag(flags, "exclude-archived", folder.excludeArchived),
  };
}

function ensureFolderHasSourceOrPeers(folder: Api.DialogFilter): void {
  if (folder.includePeers.length > 0 || folderHasBuiltInSource(folder)) return;
  die("Telegram folders need at least one included chat or built-in source. Add a source, add a chat, or delete the folder.");
}


export {
  activeBanFolderSummary,
  assertEntityAllowed,
  assertIdentifierAllowed,
  assertNotBanFolderName,
  assertWritesAllowed,
  activeBanList,
  associationChatType,
  banEntryFromEntity,
  banFolderNameFromEnv,
  chatDisplayName,
  client,
  cloneDialogFolder,
  commandFlags,
  compactText,
  connect,
  csv,
  dataDirFromEnv,
  dialogCanonicalId,
  dialogFolderTitle,
  dialogFolders,
  die,
  disconnect,
  dryRun,
  ensureFolderHasSourceOrPeers,
  entityIdString,
  execFileAsync,
  filterBannedDialogs,
  filterBannedMessages,
  findDialogFolder,
  flagEnabled,
  folderDryRun,
  folderHasBuiltInSource,
  folderTitle,
  inputPeerKey,
  isBanFolderName,
  isMessageFromBannedUser,
  loadCliBanList,
  loadDialogFilters,
  loadEnv,
  matchBannedEntity,
  nextDialogFolderId,
  numFlag,
  openLocalState,
  out,
  recordRunState,
  refreshActiveBanList,
  requireDialogFolder,
  requireEnv,
  resolveEntity,
  resolveEntityFromDialogFilters,
  resolveFolderPeers,
  runAttio,
  runLocal,
  runTelegram,
  runTelegramAndAttio,
  runTelegramMaybeWrite,
  runTelegramWrite,
  saveDialogFolder,
  serializeBan,
  serializeChat,
  serializeFolder,
  serializeInputPeer,
  serializeUser,
  sourceFlagOverrides,
  uniqueStrings,
  validateDialogFolderName
};
