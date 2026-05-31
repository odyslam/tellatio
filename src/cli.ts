#!/usr/bin/env node
/**
 * Tellatio CLI — Full Telegram API for agents.
 * Powered by incur for agent discovery, schemas, and token-efficient TOON output.
 *
 * Usage: tellatio <command> [subcommand] [args] [--flags]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cli, z } from "incur";
import { TelegramClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { loadConfig } from "./config";
import { normalizeAssociationName, suggestAssociation } from "./association";
import * as attio from "./attio";
import type { AssociationSuggestion, TelegramAssociation } from "./association";
import { canonicalCompanyName } from "./association";
import {
  identityDisplayName,
  identityUsername,
  type TelegramIdentityInput,
} from "./identity";
import { loadState, saveState, setRunState, type RunState, type SyncState } from "./state";
import {
  compileBanList,
  describeBannedUser,
  matchBannedIdentifier,
  matchBannedTelegramChat,
  matchBannedTelegramUser,
  parseEnvBannedUsers,
  type BanList,
  type BannedTelegramUser,
} from "./bans";
import { evaluateWriteGuard, sanitizeUntrusted, UNTRUSTED_ADVISORY } from "./guard";

const execFileAsync = promisify(execFile);

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message === "TIMEOUT") return;
  throw reason;
});

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

let commandOutput: unknown;
let activeBanList: BanList = compileBanList([]);

function die(msg: string): never {
  throw new Error(msg);
}

function out(data: unknown): void {
  commandOutput = data;
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
  return process.env["DATA_DIR"] || path.resolve(__dirname, "..", "data");
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

function loadLocalState(): { dataDir: string; state: SyncState } {
  const dataDir = dataDirFromEnv();
  return { dataDir, state: loadState(dataDir) };
}

function recordRunState(name: string, run: RunState): void {
  try {
    const { dataDir, state } = loadLocalState();
    setRunState(state, name, run);
    saveState(dataDir, state);
  } catch {
    // Run metadata is useful for doctor, but should not make the primary command fail.
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

interface KnownCompany {
  recordId?: string;
  name: string;
  domains: string[];
}

interface CompanyProfileSignal {
  recordId?: string;
  name: string;
  count: number;
  people: string[];
}

async function fetchTelegramBio(user: Api.User): Promise<string | undefined> {
  try {
    const full = await client.invoke(new Api.users.GetFullUser({ id: user }));
    const about = (full.fullUser as { about?: string } | undefined)?.about;
    const bio = about ? compactText(about) : "";
    return bio || undefined;
  } catch {
    return undefined;
  }
}

function createBioFetcher(includeProfileDescriptions: boolean): (user: Api.User) => Promise<string | undefined> {
  const bioByUserId = new Map<string, string | undefined>();

  return async (user: Api.User): Promise<string | undefined> => {
    if (!includeProfileDescriptions) return undefined;

    const userId = user.id.toString();
    if (bioByUserId.has(userId)) return bioByUserId.get(userId);

    const bio = await fetchTelegramBio(user);
    bioByUserId.set(userId, bio);
    return bio;
  };
}

function meaningfulCompanyToken(value: string): string {
  const normalized = normalizeAssociationName(value);
  if (normalized === "0x") return normalized;
  return normalized.length > 2 ? normalized : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function companyAliases(company: KnownCompany): string[] {
  return uniqueStrings([
    company.name,
    ...company.domains,
    ...company.domains.map((domain) => domain.split(".")[0] || ""),
  ]);
}

function textMentionsCompanyAlias(text: string, alias: string): boolean {
  const normalizedAlias = meaningfulCompanyToken(alias);
  if (!normalizedAlias) return false;

  const lowerText = text.toLowerCase();
  const lowerAlias = alias.toLowerCase().trim();
  if (lowerAlias.includes(".") && lowerText.includes(lowerAlias)) return true;

  if (/[^a-z0-9]/i.test(alias) && normalizedAlias.length > 4) {
    return normalizeAssociationName(text).includes(normalizedAlias);
  }

  const pattern = lowerAlias.split(/\s+/).map(escapeRegExp).join("[^a-z0-9]+");
  return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, "i").test(text);
}

function knownCompanyMatch(raw: string, knownCompanies: KnownCompany[]): KnownCompany | undefined {
  const normalizedRaw = meaningfulCompanyToken(raw);
  if (!normalizedRaw) return undefined;

  const aliasMatches = knownCompanies.flatMap((company) =>
    companyAliases(company)
      .map((alias) => ({ company, normalizedAlias: meaningfulCompanyToken(alias) }))
      .filter((match) => match.normalizedAlias),
  );

  const exactMatches = aliasMatches.filter((match) => match.normalizedAlias === normalizedRaw);
  if (exactMatches.length > 0) return exactMatches[0].company;

  if (normalizedRaw.length <= 3) return undefined;

  for (const company of knownCompanies) {
    for (const alias of companyAliases(company)) {
      const normalizedAlias = meaningfulCompanyToken(alias);
      if (!normalizedAlias) continue;
      if (
        normalizedRaw === normalizedAlias
        || ((normalizedAlias.length >= 5 || normalizedAlias === "0x") && normalizedRaw.includes(normalizedAlias))
        || (normalizedRaw.length >= 5 && normalizedAlias.includes(normalizedRaw))
      ) {
        return company;
      }
    }
  }

  return undefined;
}

function knownCompaniesWithRecordIds(knownCompanies: KnownCompany[]): attio.AttioRecordSummary[] {
  return knownCompanies.filter((company): company is attio.AttioRecordSummary => Boolean(company.recordId));
}

function loadOwnCompanyNames(): string[] {
  return csv(process.env["TELLATIO_OWN_COMPANY_NAMES"] || "Phylax,Phylax Systems,Credible Layer");
}

function isExcludedCompany(name: string, excludedCompanyNames: string[]): boolean {
  const normalized = normalizeAssociationName(name);
  return excludedCompanyNames.some((excluded) => normalizeAssociationName(excluded) === normalized);
}

async function loadKnownCompanies(
  approvedAssociations: TelegramAssociation[] = [],
  limit = 500,
): Promise<KnownCompany[]> {
  const byKey = new Map<string, KnownCompany>();

  function add(company: KnownCompany): void {
    const key = normalizeAssociationName(company.name);
    if (!key) return;
    const existing = byKey.get(key);
    byKey.set(key, {
      recordId: existing?.recordId || company.recordId,
      name: existing?.name || company.name,
      domains: uniqueStrings([...(existing?.domains || []), ...company.domains]),
    });
  }

  for (const company of await attio.listCompanySummaries(limit)) {
    add({ recordId: company.recordId, name: company.name, domains: company.domains });
  }

  for (const association of approvedAssociations) {
    if (association.targetObject !== "companies" || !association.targetName) continue;
    const resolved = await attio.resolveCompanyByName(association.targetName);
    add({
      recordId: resolved.record?.recordId || association.targetRecordId,
      name: resolved.record?.name || association.targetName,
      domains: resolved.record?.domains || [],
    });
  }

  return Array.from(byKey.values());
}

function inferCompanyHintsFromText(
  text: string | undefined,
  knownCompanies: KnownCompany[],
  excludedHandles: string[] = [],
  excludedCompanyNames: string[] = [],
): string[] {
  if (!text) return [];

  const hints: string[] = [];

  for (const company of knownCompanies) {
    if (isExcludedCompany(company.name, excludedCompanyNames)) continue;

    if (companyAliases(company).some((name) => textMentionsCompanyAlias(text, name))) {
      hints.push(company.name);
    }
  }

  const excluded = new Set(excludedHandles.map((handle) => normalizeAssociationName(handle)));
  const explicitCompanyPatterns = [
    /(?:^|[\s|,;])(?:at|for|with)\s+([a-z0-9][a-z0-9 ._-]{2,40})/gi,
    /@([a-z0-9_]{3,40})/gi,
  ];
  for (const pattern of explicitCompanyPatterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]?.replace(/[_-]+/g, " ").trim();
      if (!raw) continue;
      const normalized = normalizeAssociationName(raw);
      if (!normalized || excluded.has(normalized)) continue;
      const knownCompany = knownCompanyMatch(raw, knownCompanies);
      if (knownCompany && !isExcludedCompany(knownCompany.name, excludedCompanyNames)) {
        hints.push(knownCompany.name);
      }
    }
  }

  return uniqueStrings(hints);
}

function telegramUserLabel(user: Api.User): string {
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return displayName || (user.username ? `@${user.username}` : user.id.toString());
}

async function collectCompanyProfileSignals(
  entity: unknown,
  knownCompanies: KnownCompany[],
  fetchBio: (user: Api.User) => Promise<string | undefined>,
  participantLimit: number,
  excludedCompanyNames: string[],
  banList: BanList = loadCliBanList(),
): Promise<CompanyProfileSignal[]> {
  if (!knownCompanies.length) return [];
  if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) return [];

  const byCompany = new Map<string, CompanyProfileSignal>();

  try {
    const users = await client.getParticipants(entity as never, {});
    for (const user of users.slice(0, participantLimit)) {
      if (!(user instanceof Api.User) || user.bot) continue;
      if (matchBannedEntity(banList, user)) continue;

      const bio = await fetchBio(user);
      const hints = inferCompanyHintsFromText(
        bio,
        knownCompanies,
        [user.username || ""],
        excludedCompanyNames,
      );
      for (const hint of hints) {
        const key = normalizeAssociationName(hint);
        const knownCompany = knownCompanyMatch(hint, knownCompanies);
        const existing = byCompany.get(key);
        const person = telegramUserLabel(user);
        byCompany.set(key, {
          recordId: existing?.recordId || knownCompany?.recordId,
          name: existing?.name || hint,
          count: (existing?.count || 0) + 1,
          people: uniqueStrings([...(existing?.people || []), person]),
        });
      }
    }
  } catch {
    return [];
  }

  return Array.from(byCompany.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function recentGroupSenders(
  entity: Api.Chat | Api.Channel,
  sinceTs: number,
  messageLimit: number,
): Promise<Api.User[]> {
  const byUserId = new Map<string, Api.User>();

  try {
    const messages = await client.getMessages(entity as never, { limit: messageLimit });
    for (const message of messages) {
      if (message.date < sinceTs) continue;
      if (!(message.sender instanceof Api.User) || message.sender.bot) continue;
      byUserId.set(message.sender.id.toString(), message.sender);
    }
  } catch {
    return [];
  }

  return Array.from(byUserId.values());
}

function confidenceFromProfileSignal(signal: CompanyProfileSignal): number {
  if (signal.count >= 3) return 0.88;
  if (signal.count === 2) return 0.8;
  return 0.62;
}

function withCompanyProfileSignals(
  suggestion: AssociationSuggestion,
  signals: CompanyProfileSignal[],
): AssociationSuggestion {
  if (suggestion.telegramChatType === "dm" || signals.length === 0) return suggestion;

  const top = signals[0];
  const tied = signals.filter((signal) => signal.count === top.count);
  if (tied.length > 1) {
    return {
      ...suggestion,
      reasons: [
        ...suggestion.reasons,
        `profile company hints ambiguous: ${tied.slice(0, 3).map((signal) => `${signal.name} (${signal.count})`).join(", ")}`,
      ],
    };
  }

  const profileConfidence = confidenceFromProfileSignal(top);
  const currentTarget = suggestion.suggestedTargetName
    ? canonicalCompanyName(suggestion.suggestedTargetName)
    : "";
  const profileTarget = canonicalCompanyName(top.name);
  const sameTarget = currentTarget
    && normalizeAssociationName(currentTarget) === normalizeAssociationName(profileTarget);
  const shouldSetTarget = !currentTarget || suggestion.suggestedTargetObject !== "companies" || sameTarget;
  const confidence = Math.max(
    suggestion.confidence,
    sameTarget ? Math.min(0.95, profileConfidence + 0.08) : profileConfidence,
  );

  return {
    ...suggestion,
    suggestedTargetObject: shouldSetTarget ? "companies" : suggestion.suggestedTargetObject,
    suggestedTargetName: shouldSetTarget ? profileTarget : suggestion.suggestedTargetName,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
    proposedStatus: confidence >= 0.85 ? "approved" : confidence >= 0.45 ? "suggested" : "ignored",
    reasons: [
      ...suggestion.reasons,
      `participant profile descriptions mention ${top.name}: ${top.people.slice(0, 4).join(", ")}`,
    ],
  };
}

function telegramIdentityFromUser(
  user: Api.User,
  source: string,
  lastObservedAt?: string,
  bio?: string,
  companyHints: string[] = [],
): TelegramIdentityInput | null {
  if (user.bot) return null;

  return {
    telegramUserId: user.id.toString(),
    firstName: user.firstName || undefined,
    lastName: user.lastName || undefined,
    username: user.username || undefined,
    phone: user.phone || undefined,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.id.toString(),
    bio,
    companyHints,
    source,
    lastObservedAt,
  };
}

function serializePersonCandidate(candidate: attio.PersonSummary): Record<string, unknown> {
  return {
    recordId: candidate.recordId,
    name: candidate.name,
    emails: candidate.emails,
    phones: candidate.phones,
    telegramUsernames: candidate.telegramUsernames,
    telegramUserIds: candidate.telegramUserIds,
    createdAt: candidate.createdAt,
  };
}

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
  const banList = loadCliBanList();
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const results = dialogs.map((d) => ({
    id: dialogCanonicalId(d) || "",
    canonicalId: entityIdString(d.entity) || dialogCanonicalId(d) || "",
    dialogId: d.id?.toString(),
    name: sanitizeUntrusted(d.name || d.title),
    isGroup: d.isGroup,
    isChannel: d.isChannel,
    isUser: d.isUser,
    unreadCount: d.unreadCount,
    lastMessage: d.message ? {
      id: d.message.id,
      date: d.message.date,
      text: sanitizeUntrusted(d.message.text || d.message.message || ""),
    } : null,
  }));
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
  const banList = loadCliBanList();
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const unread = dialogs
    .filter((d) => d.unreadCount > 0)
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
        text: sanitizeUntrusted(d.message.text || d.message.message || ""),
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

async function cmdFoldersList(): Promise<void> {
  const folders = dialogFolders(await loadDialogFilters()).map(serializeFolder);
  out(folders);
}

async function cmdFoldersCreate(positional: string[], flags: Record<string, string>): Promise<void> {
  const name = positional[0];
  if (!name) die("Usage: tellatio folders create <name> [--chats chat1,chat2] [--contacts] [--groups] [--channels] [--bots]");
  assertNotBanFolderName(name, "add");
  validateDialogFolderName(name);

  const filters = await loadDialogFilters();
  if (findDialogFolder(filters, name)) die(`Folder "${name}" already exists`);

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
    color: flags["color"] ? parseInt(flags["color"], 10) : undefined,
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

async function cmdFoldersRename(positional: string[]): Promise<void> {
  const from = positional[0];
  const to = positional[1];
  if (!from || !to) die("Usage: tellatio folders rename <old-name> <new-name>");
  assertNotBanFolderName(from, "list/remove");
  assertNotBanFolderName(to, "add");
  validateDialogFolderName(to);

  const filters = await loadDialogFilters();
  const folder = requireDialogFolder(filters, from);
  const existing = findDialogFolder(filters, to);
  if (existing && existing.id !== folder.id) die(`Folder "${to}" already exists`);

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
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders add <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "add");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
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

  const updated = added.length > 0
    ? cloneDialogFolder(folder, { includePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.add", folder, updated, { added, alreadyPresent });
    return;
  }

  const ok = added.length > 0 ? await saveDialogFolder(updated) : true;

  out({
    updated: ok,
    folder: serializeFolder(updated),
    added,
    alreadyPresent,
  });
}

async function cmdFoldersRemove(positional: string[]): Promise<void> {
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders remove <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const removeKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const existingKeys = new Set(folder.includePeers.map(inputPeerKey));
  const includePeers = folder.includePeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const pinnedPeers = folder.pinnedPeers.filter((peer) => !removeKeys.has(inputPeerKey(peer)));
  const removed = peers
    .filter((peer) => existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const notPresent = peers
    .filter((peer) => !existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);

  if (removed.length > 0 && includePeers.length === 0 && !folderHasBuiltInSource(folder)) {
    die("Removing these chats would leave the folder with no included chats or built-in source. Delete the folder instead, or keep at least one chat.");
  }

  const updated = removed.length > 0
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.remove", folder, updated, { removed, notPresent });
    return;
  }

  const ok = removed.length > 0 ? await saveDialogFolder(updated) : true;

  out({
    updated: ok,
    folder: serializeFolder(updated),
    removed,
    notPresent,
  });
}

async function cmdFoldersPin(positional: string[]): Promise<void> {
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders pin <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "add");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
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

  const updated = pinned.length > 0
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.pin", folder, updated, { pinned, alreadyPinned });
    return;
  }

  const ok = pinned.length > 0 ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), pinned, alreadyPinned });
}

async function cmdFoldersUnpin(positional: string[]): Promise<void> {
  const name = positional[0];
  const chat = positional[1];
  if (!name || !chat) die("Usage: tellatio folders unpin <folder> <chat|chat1,chat2>");
  assertNotBanFolderName(name, "remove");

  const folder = requireDialogFolder(await loadDialogFilters(), name);
  const peers = await resolveFolderPeers(chat);
  const unpinKeys = new Set(peers.map((peer) => inputPeerKey(peer.peer)));
  const existingKeys = new Set(folder.pinnedPeers.map(inputPeerKey));
  const pinnedPeers = folder.pinnedPeers.filter((peer) => !unpinKeys.has(inputPeerKey(peer)));
  const unpinned = peers
    .filter((peer) => existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);
  const notPinned = peers
    .filter((peer) => !existingKeys.has(inputPeerKey(peer.peer)))
    .map((peer) => peer.chat);

  const updated = unpinned.length > 0 ? cloneDialogFolder(folder, { pinnedPeers }) : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.unpin", folder, updated, { unpinned, notPinned });
    return;
  }

  const ok = unpinned.length > 0 ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), unpinned, notPinned });
}

async function cmdFoldersExcludeAdd(positional: string[]): Promise<void> {
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

  const updated = excluded.length > 0
    ? cloneDialogFolder(folder, { includePeers, pinnedPeers, excludePeers })
    : folder;
  if (positional[2] === "dry-run") {
    folderDryRun("folders.exclude-add", folder, updated, { excluded, alreadyExcluded });
    return;
  }

  const ok = excluded.length > 0 ? await saveDialogFolder(updated) : true;
  out({ updated: ok, folder: serializeFolder(updated), excluded, alreadyExcluded });
}

async function cmdFoldersExcludeRemove(positional: string[]): Promise<void> {
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
  const order = csv(positional[0] || "");
  if (order.length === 0) die("Usage: tellatio folders reorder <folder1,folder2,...>");

  const filters = await loadDialogFilters();
  const folders = dialogFolders(filters);
  const byTitle = new Map(folders.map((folder) => [dialogFolderTitle(folder), folder]));
  const seen = new Set<string>();
  const selected: Api.DialogFilter[] = [];

  for (const name of order) {
    if (seen.has(name)) die(`Duplicate folder in reorder list: ${name}`);
    seen.add(name);

    const folder = byTitle.get(name);
    if (!folder) {
      const names = folders.map(dialogFolderTitle);
      die(`Folder "${name}" not found. Available: ${names.join(", ")}`);
    }
    selected.push(folder);
  }

  const remaining = folders.filter((folder) => !seen.has(dialogFolderTitle(folder)));
  const nextFolders = [...selected, ...remaining];
  const nextOrder = nextFolders.map((folder) => folder.id);

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

// ── discover ────────────────────────────────────────────────────

async function cmdDiscoverAssociations(flags: Record<string, string>): Promise<void> {
  const limit = numFlag(flags, "limit", 100);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const includeIgnored = flags["include-ignored"] === "true";
  out(await discoverAssociationSuggestions(limit, sinceTs, includeIgnored, loadCliBanList()));
}

async function discoverAssociationSuggestions(
  limit: number,
  sinceTs: number,
  includeIgnored: boolean,
  banList: BanList = loadCliBanList(),
): Promise<ReturnType<typeof suggestAssociation>[]> {
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);

  return dialogs
    .filter((dialog) => dialog.message && dialog.message.date >= sinceTs)
    .map((dialog) => {
      const entity = dialog.entity;
      const title = chatDisplayName(entity, dialog.name || dialog.title || "Unknown");
      const lastText = compactText(dialog.message?.text || dialog.message?.message || "");
      return suggestAssociation({
        chatId: dialogCanonicalId(dialog) || "",
        title,
        type: associationChatType(entity),
        lastMessageAt: dialog.message ? new Date(dialog.message.date * 1000).toISOString() : undefined,
        lastMessageText: lastText,
      });
    })
    .filter((suggestion) => suggestion.telegramChatId)
    .filter((suggestion) => includeIgnored || suggestion.proposedStatus !== "ignored")
    .sort((a, b) => b.confidence - a.confidence);
}

// ── associations ────────────────────────────────────────────────

async function cmdAssociationsUpsert(flags: Record<string, string>): Promise<void> {
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const chatId = flags["chat-id"];
  const title = flags["title"];
  const type = flags["type"] || "unknown";
  const targetObject = flags["target-object"];
  const targetName = flags["target-name"];
  const targetRecordId = flags["target-record-id"] || "";
  const status = flags["status"] || "suggested";
  const syncMode = flags["sync-mode"] || "transcript";
  const confidence = flags["confidence"] ? Number.parseFloat(flags["confidence"]) : 0;
  const reason = flags["reason"] || "";

  if (!chatId || !title || !targetObject) {
    die("Required flags: --chat-id, --title, --target-object");
  }

  if (!["dm", "group", "supergroup", "channel", "unknown"].includes(type)) {
    die("--type must be dm, group, supergroup, channel, or unknown");
  }
  if (!["suggested", "approved", "ignored", "needs_review"].includes(status)) {
    die("--status must be suggested, approved, ignored, or needs_review");
  }
  if (!["transcript", "summary", "stats"].includes(syncMode)) {
    die("--sync-mode must be transcript, summary, or stats");
  }
  if (status === "approved" && !targetRecordId) {
    die("--target-record-id is required when --status is approved");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    die("--confidence must be between 0 and 1");
  }

  const association: TelegramAssociation = {
    telegramChatId: chatId,
    telegramChatTitle: title,
    telegramChatType: type as TelegramAssociation["telegramChatType"],
    targetObject,
    targetName,
    targetRecordId,
    status: status as TelegramAssociation["status"],
    confidence,
    reason,
    syncMode: syncMode as TelegramAssociation["syncMode"],
    lastObservedAt: new Date().toISOString(),
  };

  if (dryRun(flags)) {
    const existing = await attio.findTelegramAssociation(objectSlug, association.telegramChatId);
    out({
      dryRun: true,
      action: "associations.upsert",
      object: objectSlug,
      existingRecordId: existing?.recordId,
      association,
    });
    return;
  }

  const recordId = await attio.upsertTelegramAssociation(objectSlug, association);
  out({ recordId, object: objectSlug, association });
}

async function cmdAssociationsReconcile(flags: Record<string, string>): Promise<void> {
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const limit = numFlag(flags, "limit", 100);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const minConfidence = flags["min-confidence"] ? Number.parseFloat(flags["min-confidence"]) : 0.45;
  const includeProfileDescriptions = flags["include-profile-descriptions"] !== "false";
  const profileParticipantLimit = numFlag(flags, "profile-participant-limit", 30);
  const companyLimit = numFlag(flags, "company-limit", 500);
  const isDryRun = dryRun(flags);
  const banList = loadCliBanList();

  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    die("--min-confidence must be between 0 and 1");
  }

  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const dialogByChatId = new Map<string, (typeof dialogs)[number]>();
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity || !("id" in entity)) continue;
    dialogByChatId.set(entity.id.toString(), dialog);
  }

  const approvedAssociations = await attio.listApprovedTelegramAssociations(objectSlug);
  const knownCompanies = includeProfileDescriptions
    ? await loadKnownCompanies(approvedAssociations, companyLimit)
    : [];
  const fetchBio = createBioFetcher(includeProfileDescriptions);
  const excludedCompanyNames = loadOwnCompanyNames();
  const suggestions = await discoverAssociationSuggestions(limit, sinceTs, false, banList);
  const result = {
    approved: [] as Array<Record<string, unknown>>,
    needsReview: [] as Array<Record<string, unknown>>,
    skippedApproved: [] as Array<Record<string, unknown>>,
    ignored: [] as Array<Record<string, unknown>>,
    wouldUpsert: [] as Array<TelegramAssociation>,
  };

  for (const originalSuggestion of suggestions) {
    const dialog = dialogByChatId.get(originalSuggestion.telegramChatId);
    const profileSignals = includeProfileDescriptions && dialog?.entity
      ? await collectCompanyProfileSignals(
        dialog.entity,
        knownCompanies,
        fetchBio,
        profileParticipantLimit,
        excludedCompanyNames,
        banList,
      )
      : [];
    const suggestion = withCompanyProfileSignals(originalSuggestion, profileSignals);

    if (!suggestion.suggestedTargetObject || !suggestion.suggestedTargetName || suggestion.confidence < minConfidence) {
      result.ignored.push({
        chat: suggestion.telegramChatTitle,
        confidence: suggestion.confidence,
        reason: "below confidence threshold or no inferred target",
        profileSignals,
      });
      continue;
    }

    const existing = await attio.findTelegramAssociation(objectSlug, suggestion.telegramChatId);
    if (existing?.status === "approved" && existing.targetRecordId) {
      result.skippedApproved.push({
        chat: suggestion.telegramChatTitle,
        targetObject: existing.targetObject,
        targetRecordId: existing.targetRecordId,
      });
      continue;
    }

    let status: TelegramAssociation["status"] = "needs_review";
    let targetRecordId = "";
    let resolutionReason = "";

    let targetName = suggestion.suggestedTargetName;
    if (suggestion.suggestedTargetObject === "companies") {
      targetName = canonicalCompanyName(suggestion.suggestedTargetName);
      const profileSignalForTarget = profileSignals.find((signal) =>
        normalizeAssociationName(canonicalCompanyName(signal.name)) === normalizeAssociationName(targetName),
      );

      if (profileSignalForTarget?.recordId) {
        status = "approved";
        targetRecordId = profileSignalForTarget.recordId;
        resolutionReason = `participant profile company hint match: ${profileSignalForTarget.name}`;
        if (targetName !== suggestion.suggestedTargetName) {
          resolutionReason = `alias ${suggestion.suggestedTargetName} -> ${targetName}; ${resolutionReason}`;
        }
        result.approved.push({
          chat: suggestion.telegramChatTitle,
          company: profileSignalForTarget.name,
          recordId: profileSignalForTarget.recordId,
          confidence: suggestion.confidence,
          reason: resolutionReason,
          profileSignals,
        });
      } else {
        const resolution = await attio.resolveCompanyByName(targetName, {
          knownCompanies: knownCompaniesWithRecordIds(knownCompanies),
        });
        resolutionReason = resolution.reason;
        if (targetName !== suggestion.suggestedTargetName) {
          resolutionReason = `alias ${suggestion.suggestedTargetName} -> ${targetName}; ${resolutionReason}`;
        }
        if (resolution.status === "resolved" && resolution.record) {
          status = "approved";
          targetRecordId = resolution.record.recordId;
          result.approved.push({
            chat: suggestion.telegramChatTitle,
            company: resolution.record.name,
            recordId: resolution.record.recordId,
            confidence: suggestion.confidence,
            reason: resolutionReason,
            profileSignals,
          });
        } else {
          result.needsReview.push({
            chat: suggestion.telegramChatTitle,
            suggestedTarget: targetName,
            confidence: suggestion.confidence,
            reason: resolution.reason,
            profileSignals,
            candidates: resolution.candidates.map((candidate) => ({
              name: candidate.name,
              recordId: candidate.recordId,
              domains: candidate.domains,
            })),
          });
        }
      }
    } else {
      resolutionReason = "person auto-resolution is not enabled yet";
      result.needsReview.push({
        chat: suggestion.telegramChatTitle,
        suggestedTarget: suggestion.suggestedTargetName,
        confidence: suggestion.confidence,
        reason: resolutionReason,
        profileSignals,
      });
    }

    const association: TelegramAssociation = {
      telegramChatId: suggestion.telegramChatId,
      telegramChatTitle: suggestion.telegramChatTitle,
      telegramChatType: suggestion.telegramChatType,
      targetObject: suggestion.suggestedTargetObject,
      targetName,
      targetRecordId,
      status,
      confidence: suggestion.confidence,
      reason: [...suggestion.reasons, resolutionReason].filter(Boolean).join("; "),
      syncMode: suggestion.syncMode,
      lastObservedAt: suggestion.lastMessageAt || new Date().toISOString(),
    };

    result.wouldUpsert.push(association);
    if (!isDryRun) await attio.upsertTelegramAssociation(objectSlug, association);
  }

  const counts = {
    approved: result.approved.length,
    needsReview: result.needsReview.length,
    skippedApproved: result.skippedApproved.length,
    ignored: result.ignored.length,
    wouldUpsert: result.wouldUpsert.length,
  };
  recordRunState("associationsReconcile", {
    status: isDryRun ? "dry_run" : "success",
    finishedAt: new Date().toISOString(),
    counts,
  });

  out({
    dryRun: isDryRun || undefined,
    counts: {
      approved: result.approved.length,
      needsReview: result.needsReview.length,
      skippedApproved: result.skippedApproved.length,
      ignored: result.ignored.length,
      wouldUpsert: result.wouldUpsert.length,
    },
    ...result,
  });
}

async function cmdAssociationsStatus(flags: Record<string, string>): Promise<void> {
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const limit = numFlag(flags, "limit", 500);
  const associations = await attio.listTelegramAssociations(objectSlug, limit);
  const counts = associations.reduce<Record<string, number>>((acc, association) => {
    acc[association.status] = (acc[association.status] || 0) + 1;
    return acc;
  }, {});

  out({
    counts,
    associations: associations
      .sort((a, b) => a.status.localeCompare(b.status) || a.telegramChatTitle.localeCompare(b.telegramChatTitle))
      .map((association) => ({
        recordId: association.recordId,
        chat: association.telegramChatTitle,
        chatId: association.telegramChatId,
        type: association.telegramChatType,
        status: association.status,
        targetObject: association.targetObject,
        targetName: association.targetName,
        targetRecordId: association.targetRecordId,
        confidence: association.confidence,
        reason: association.reason,
      })),
  });
}

// ── identities ──────────────────────────────────────────────────

async function collectIdentityInputs(flags: Record<string, string>): Promise<TelegramIdentityInput[]> {
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const limit = numFlag(flags, "limit", 100);
  const participantLimit = numFlag(flags, "participant-limit", 50);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const includeParticipants = flags["include-participants"] !== "false";
  const includeProfileDescriptions = flags["include-profile-descriptions"] !== "false";
  const companyLimit = numFlag(flags, "company-limit", 500);
  const banList = loadCliBanList();
  const dialogs = filterBannedDialogs(await client.getDialogs({ limit }), banList);
  const me = await client.getMe() as Api.User;
  const excludedUserIds = new Set([me.id.toString(), "777000"]);
  const excludedCompanyNames = loadOwnCompanyNames();
  const identities = new Map<string, TelegramIdentityInput>();
  const userBio = createBioFetcher(includeProfileDescriptions);

  function addIdentity(input: TelegramIdentityInput | null): void {
    if (!input) return;
    if (excludedUserIds.has(input.telegramUserId)) return;
    if (matchBannedTelegramUser(banList, {
      userIdStr: input.telegramUserId,
      username: input.username,
    })) return;
    const existing = identities.get(input.telegramUserId);
    if (!existing) {
      identities.set(input.telegramUserId, input);
      return;
    }

    const sources = new Set([...(existing.source || "").split("; "), input.source || ""].filter(Boolean));
    identities.set(input.telegramUserId, {
      ...existing,
      firstName: existing.firstName || input.firstName,
      lastName: existing.lastName || input.lastName,
      username: existing.username || input.username,
      phone: existing.phone || input.phone,
      displayName: existing.displayName || input.displayName,
      bio: existing.bio || input.bio,
      companyHints: uniqueStrings([
        ...(existing.companyHints || []),
        ...(input.companyHints || []),
      ]),
      source: Array.from(sources).join("; "),
      lastObservedAt: input.lastObservedAt || existing.lastObservedAt,
    });
  }

  const approvedAssociations = await attio.listApprovedTelegramAssociations(objectSlug);
  const knownCompanies = await loadKnownCompanies(approvedAssociations, companyLimit);

  const dialogByChatId = new Map<string, (typeof dialogs)[number]>();
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity || !("id" in entity)) continue;
    dialogByChatId.set(entity.id.toString(), dialog);

    if (entity instanceof Api.User && dialog.message && dialog.message.date >= sinceTs) {
      if (matchBannedEntity(banList, entity)) continue;
      const bio = await userBio(entity);
      addIdentity(telegramIdentityFromUser(
        entity,
        `DM: ${chatDisplayName(entity)}`,
        new Date(dialog.message.date * 1000).toISOString(),
        bio,
        inferCompanyHintsFromText(bio, knownCompanies, [entity.username || ""], excludedCompanyNames),
      ));
    }
  }

  if (includeParticipants) {
    for (const association of approvedAssociations) {
      const dialog = dialogByChatId.get(association.telegramChatId);
      if (!dialog?.entity || dialog.entity instanceof Api.User) continue;
      if (!dialog.message || dialog.message.date < sinceTs) continue;

      const lastObservedAt = dialog.message
        ? new Date(dialog.message.date * 1000).toISOString()
        : new Date().toISOString();
      const source = `Group: ${association.telegramChatTitle}`;
      let users = await recentGroupSenders(
        dialog.entity as Api.Chat | Api.Channel,
        sinceTs,
        Math.max(100, participantLimit * 5),
      );
      if (users.length === 0) {
        users = (await client.getParticipants(dialog.entity as never, {}))
          .filter((user): user is Api.User => user instanceof Api.User);
      }
      for (const user of users.slice(0, participantLimit)) {
        if (user instanceof Api.User) {
          if (matchBannedEntity(banList, user)) continue;
          const bio = await userBio(user);
          addIdentity(telegramIdentityFromUser(
            user,
            source,
            lastObservedAt,
            bio,
            uniqueStrings([
              association.targetObject === "companies" ? association.targetName : undefined,
              ...inferCompanyHintsFromText(bio, knownCompanies, [user.username || ""], excludedCompanyNames),
            ]),
          ));
        }
      }
    }
  }

  return Array.from(identities.values())
    .sort((a, b) => identityDisplayName(a).localeCompare(identityDisplayName(b)));
}

async function cmdIdentitiesReconcile(flags: Record<string, string>): Promise<void> {
  const identityObjectSlug = flags["identity-object"] || process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
  const inputs = await collectIdentityInputs(flags);
  const isDryRun = dryRun(flags);
  const result = {
    approved: [] as Array<Record<string, unknown>>,
    needsReview: [] as Array<Record<string, unknown>>,
  };

  for (const input of inputs) {
    const reconciliation = isDryRun
      ? await resolveIdentityDryRun(identityObjectSlug, input)
      : await attio.reconcileTelegramIdentity(identityObjectSlug, input);
    const row = {
      telegramUserId: input.telegramUserId,
      telegramUsername: identityUsername(input),
      telegramDisplayName: identityDisplayName(input),
      telegramBio: input.bio,
      companyHints: input.companyHints || [],
      identityRecordId: reconciliation.identityRecordId,
      status: reconciliation.identity.status,
      confidence: reconciliation.identity.confidence,
      reason: reconciliation.identity.reason,
      targetRecordId: reconciliation.identity.targetRecordId,
      targetName: reconciliation.identity.targetName,
      candidates: reconciliation.resolution.candidates.map(serializePersonCandidate),
    };

    if (reconciliation.identity.status === "approved") {
      result.approved.push(row);
    } else {
      result.needsReview.push(row);
    }
  }

  const counts = {
    approved: result.approved.length,
    needsReview: result.needsReview.length,
  };
  recordRunState("identitiesReconcile", {
    status: isDryRun ? "dry_run" : "success",
    finishedAt: new Date().toISOString(),
    counts,
  });

  out({
    dryRun: isDryRun || undefined,
    counts,
    ...result,
  });
}

async function resolveIdentityDryRun(
  identityObjectSlug: string,
  input: TelegramIdentityInput,
): Promise<{
  identityRecordId?: string;
  resolution: attio.PersonResolution;
  identity: {
    status: TelegramAssociation["status"];
    confidence: number;
    reason: string;
    targetRecordId: string;
    targetName?: string;
  };
}> {
  const resolution = await attio.resolvePersonIdentity(input, identityObjectSlug);
  const displayName = identityDisplayName(input);
  return {
    identityRecordId: undefined,
    resolution,
    identity: {
      status: resolution.status === "resolved" ? "approved" : "needs_review",
      confidence: resolution.confidence,
      reason: [input.source, resolution.reason].filter(Boolean).join("; "),
      targetRecordId: resolution.record?.recordId || "",
      targetName: resolution.record?.name || displayName,
    },
  };
}

async function cmdIdentitiesCandidates(flags: Record<string, string>): Promise<void> {
  const name = flags["name"];
  const username = flags["username"];
  const phone = flags["phone"];
  const telegramUserId = flags["telegram-user-id"];

  const candidates: attio.PersonSummary[] = [];
  if (telegramUserId) candidates.push(...await attio.findPersonCandidatesByTelegramUserId(telegramUserId));
  if (phone) candidates.push(...await attio.findPersonCandidatesByPhone(phone));
  if (username) candidates.push(...await attio.findPersonCandidatesByUsername(username));
  if (name) candidates.push(...await attio.findPersonCandidatesByName(name));

  const seen = new Set<string>();
  out(candidates
    .filter((candidate) => {
      if (seen.has(candidate.recordId)) return false;
      seen.add(candidate.recordId);
      return true;
    })
    .map(serializePersonCandidate));
}

async function cmdIdentitiesUpsert(flags: Record<string, string>): Promise<void> {
  const identityObjectSlug = flags["identity-object"] || process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
  const telegramUserId = flags["telegram-user-id"];
  const displayName = flags["display-name"];
  const targetRecordId = flags["target-record-id"];
  const status = flags["status"] || "approved";

  if (!telegramUserId || !displayName) {
    die("Required flags: --telegram-user-id and --display-name");
  }
  if (!["suggested", "approved", "ignored", "needs_review"].includes(status)) {
    die("--status must be suggested, approved, ignored, or needs_review");
  }
  if (status === "approved" && !targetRecordId) {
    die("--target-record-id is required when --status is approved");
  }

  const target = targetRecordId ? await attio.getPersonSummary(targetRecordId) : null;
  const identity = {
    telegramUserId,
    telegramUsername: flags["telegram-username"],
    telegramDisplayName: displayName,
    telegramBio: flags["telegram-bio"],
    companyHints: flags["company-hints"] ? csv(flags["company-hints"]) : [],
    phone: flags["phone"],
    targetRecordId: targetRecordId || "",
    targetName: target?.name || flags["target-name"] || displayName,
    status: status as TelegramAssociation["status"],
    confidence: flags["confidence"] ? Number.parseFloat(flags["confidence"]) : (status === "approved" ? 1 : 0.5),
    reason: flags["reason"] || "manual identity mapping",
    lastObservedAt: new Date().toISOString(),
  };

  if (dryRun(flags)) {
    out({
      dryRun: true,
      action: "identities.upsert",
      identityObject: identityObjectSlug,
      identity,
      target,
      wouldUpdatePerson: status === "approved" && Boolean(targetRecordId),
    });
    return;
  }

  const recordId = await attio.upsertTelegramIdentity(identityObjectSlug, identity);

  if (status === "approved" && targetRecordId) {
    await attio.updatePersonTelegramIdentity(targetRecordId, {
      telegramUserId,
      username: flags["telegram-username"],
      phone: flags["phone"],
      displayName,
    });
  }

  out({ recordId, identityObject: identityObjectSlug, target });
}

async function cmdIdentitiesStatus(flags: Record<string, string>): Promise<void> {
  const identityObjectSlug = flags["identity-object"] || process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
  const limit = numFlag(flags, "limit", 500);
  const identities = await attio.listTelegramIdentities(identityObjectSlug, limit);
  const counts = identities.reduce<Record<string, number>>((acc, identity) => {
    acc[identity.status] = (acc[identity.status] || 0) + 1;
    return acc;
  }, {});

  out({
    counts,
    identities: identities
      .sort((a, b) => a.status.localeCompare(b.status) || a.telegramDisplayName.localeCompare(b.telegramDisplayName))
      .map((identity) => ({
        recordId: identity.recordId,
        telegramUserId: identity.telegramUserId,
        telegramUsername: identity.telegramUsername,
        telegramDisplayName: identity.telegramDisplayName,
        telegramBio: identity.telegramBio,
        companyHints: identity.companyHints,
        status: identity.status,
        targetName: identity.targetName,
        targetRecordId: identity.targetRecordId,
        confidence: identity.confidence,
        reason: identity.reason,
      })),
  });
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

  if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);

  assertIdentifierAllowed(chatId, "send media to");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "send media to");
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

  assertIdentifierAllowed(chatId, "download media from");
  const entity = await resolveEntity(chatId);
  assertEntityAllowed(entity, "download media from");
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

// ── doctor ──────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  data?: Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function envPresence(): Record<string, boolean> {
  return {
    TELEGRAM_API_ID: Boolean(process.env["TELEGRAM_API_ID"]),
    TELEGRAM_API_HASH: Boolean(process.env["TELEGRAM_API_HASH"]),
    TELEGRAM_SESSION: Boolean(process.env["TELEGRAM_SESSION"]),
    ATTIO_API_KEY: Boolean(process.env["ATTIO_API_KEY"]),
    DATA_DIR: Boolean(process.env["DATA_DIR"]),
  };
}

function envCheck(): DoctorCheck {
  try {
    const config = loadConfig();
    return {
      name: "env",
      status: "pass",
      detail: "required environment is present",
      data: {
        syncSource: config.syncSource,
        folderName: config.folderName,
        banFolderName: config.banFolderName,
        associationObject: config.associationObjectSlug,
        identityObject: config.identityObjectSlug,
        folderFallbackEnabled: config.folderFallbackEnabled,
        autoCreatePeople: config.autoCreatePeople,
        syncIntervalSeconds: config.syncIntervalSeconds,
        discoveryDialogLimit: config.discoveryDialogLimit,
        dataDir: config.dataDir,
      },
    };
  } catch (err) {
    return {
      name: "env",
      status: "fail",
      detail: errorMessage(err),
      data: envPresence(),
    };
  }
}

async function telegramDoctorCheck(): Promise<DoctorCheck> {
  try {
    await connect();
    const me = await client.getMe() as Api.User;
    const filters = dialogFolders(await loadDialogFilters());
    return {
      name: "telegram",
      status: "pass",
      detail: "connected and fetched dialog filters",
      data: {
        id: me.id.toString(),
        username: me.username,
        displayName: chatDisplayName(me),
        folderCount: filters.length,
      },
    };
  } catch (err) {
    return {
      name: "telegram",
      status: "fail",
      detail: errorMessage(err),
    };
  } finally {
    await disconnect();
  }
}

async function attioDoctorCheck(limit: number): Promise<DoctorCheck> {
  try {
    attio.initAttio(requireEnv("ATTIO_API_KEY"));
    const associationObject = process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
    const identityObject = process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
    const associations = await attio.listTelegramAssociations(associationObject, limit);
    const identities = await attio.listTelegramIdentities(identityObject, limit);
    const associationCounts = associations.reduce<Record<string, number>>((acc, association) => {
      acc[association.status] = (acc[association.status] || 0) + 1;
      return acc;
    }, {});
    const identityCounts = identities.reduce<Record<string, number>>((acc, identity) => {
      acc[identity.status] = (acc[identity.status] || 0) + 1;
      return acc;
    }, {});

    return {
      name: "attio",
      status: "pass",
      detail: "queried association and identity objects",
      data: {
        associationObject,
        identityObject,
        associationCounts,
        identityCounts,
      },
    };
  } catch (err) {
    return {
      name: "attio",
      status: "fail",
      detail: errorMessage(err),
    };
  }
}

function findRailwayTellatio(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRailwayTellatio(item);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const text = [
    record.name,
    record.serviceName,
    record.service,
    record.id,
  ].filter((item): item is string => typeof item === "string").join(" ").toLowerCase();

  if (text.includes("tellatio")) return record;

  for (const child of Object.values(record)) {
    const found = findRailwayTellatio(child);
    if (found) return found;
  }

  return undefined;
}

async function railwayDoctorCheck(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("railway", ["service", "status", "--all", "--json"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        name: "railway",
        status: "warn",
        detail: "railway CLI returned non-JSON status output",
        data: { output: stdout.slice(0, 1000) },
      };
    }

    const tellatio = findRailwayTellatio(parsed);
    return {
      name: "railway",
      status: tellatio ? "pass" : "warn",
      detail: tellatio ? "found tellatio service in Railway status" : "railway status succeeded but no tellatio service was identified",
      data: tellatio ? { service: tellatio } : { status: parsed as Record<string, unknown> },
    };
  } catch (err) {
    return {
      name: "railway",
      status: "warn",
      detail: `railway service status unavailable: ${errorMessage(err)}`,
    };
  }
}

function stateDoctorCheck(): DoctorCheck {
  try {
    const { dataDir, state } = loadLocalState();
    const chatStates = Object.entries(state.chats || {});
    const latestChat = chatStates
      .map(([chatId, chat]) => ({ chatId, ...chat }))
      .sort((a, b) => b.lastSyncedDate.localeCompare(a.lastSyncedDate) || b.lastMessageId - a.lastMessageId)[0];

    return {
      name: "state",
      status: "pass",
      detail: "loaded local sync state",
      data: {
        dataDir,
        chatCount: chatStates.length,
        latestChat,
        runs: state.runs || {},
      },
    };
  } catch (err) {
    return {
      name: "state",
      status: "warn",
      detail: errorMessage(err),
    };
  }
}

async function cmdDoctor(flags: Record<string, string>): Promise<void> {
  const checks: DoctorCheck[] = [envCheck()];
  const limit = numFlag(flags, "limit", 100);

  if (!flagEnabled(flags, "skip-telegram")) {
    checks.push(await telegramDoctorCheck());
  } else {
    checks.push({ name: "telegram", status: "skip" });
  }

  if (!flagEnabled(flags, "skip-attio")) {
    checks.push(await attioDoctorCheck(limit));
  } else {
    checks.push({ name: "attio", status: "skip" });
  }

  if (!flagEnabled(flags, "skip-railway")) {
    checks.push(await railwayDoctorCheck());
  } else {
    checks.push({ name: "railway", status: "skip" });
  }

  checks.push(stateDoctorCheck());

  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  out({ overall, checks });
}

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
    run: (c) => runTelegram(() => cmdFoldersCreate([c.args.name], commandFlags(c.options))),
  })
  .command("rename", {
    description: "Rename a Telegram folder",
    args: z.object({
      from: z.string().describe("Current folder name"),
      to: z.string().describe("New folder name"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersRename([c.args.from, c.args.to, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("delete", {
    description: "Delete a Telegram folder",
    args: z.object({ name: z.string().describe("Folder name") }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersDelete([c.args.name, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("add", {
    description: "Add chats to a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersAdd([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("remove", {
    description: "Remove chats from a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersRemove([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("pin", {
    description: "Pin chats inside a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersPin([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("unpin", {
    description: "Unpin chats inside a Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersUnpin([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("exclude-add", {
    description: "Explicitly exclude chats from a source-based Telegram folder",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersExcludeAdd([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
  })
  .command("exclude-remove", {
    description: "Remove chats from a folder's explicit exclusions",
    args: z.object({
      folder: z.string().describe("Folder name"),
      chat: z.string().describe("Chat identifier, or comma-separated chat identifiers"),
    }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing Telegram") }),
    run: (c) => runTelegram(() => cmdFoldersExcludeRemove([c.args.folder, c.args.chat, c.options.dryRun ? "dry-run" : ""])),
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
    run: (c) => runTelegram(() => cmdFoldersSources([c.args.folder], commandFlags({
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
    run: (c) => runTelegram(() => cmdFoldersReorder([c.args.order], commandFlags({ "dry-run": c.options.dryRun }))),
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
    run: (c) => runTelegram(() => cmdBansAdd([c.args.user], commandFlags({
      reason: c.options.reason,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("remove", {
    description: "Remove a Telegram peer from the ban folder",
    args: z.object({ user: z.string().describe("Telegram username, @handle, t.me link, or numeric chat/user ID") }),
    options: z.object({ dryRun: z.boolean().default(false).describe("Preview without changing the Telegram ban folder") }),
    run: (c) => runTelegram(() => cmdBansRemove([c.args.user], commandFlags({ "dry-run": c.options.dryRun }))),
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

cli.serve();
