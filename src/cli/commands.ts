import { Api } from "telegram";
import * as fs from "node:fs";
import { loadConfig } from "../config";
import { sanitizeUntrusted, UNTRUSTED_ADVISORY } from "../guard";
import { canonicalCompanyName, normalizeAssociationName, suggestAssociation, type AssociationSuggestion, type TelegramAssociation } from "../association";
import * as attio from "../attio";
import { identityDisplayName, identityUsername, type TelegramIdentityInput } from "../identity";
import { describeBannedUser, matchBannedIdentifier, matchBannedTelegramUser, type BanList } from "../bans";
import type { StateStore } from "../state";
import {
  activeBanFolderSummary,
  activeBanList,
  associationChatType,
  assertEntityAllowed,
  assertIdentifierAllowed,
  assertNotBanFolderName,
  banEntryFromEntity,
  banFolderNameFromEnv,
  chatDisplayName,
  client,
  cloneDialogFolder,
  compactText,
  connect,
  csv,
  dataDirFromEnv,
  die,
  dialogCanonicalId,
  dialogFolderTitle,
  dialogFolders,
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
  saveDialogFolder,
  serializeBan,
  serializeChat,
  serializeFolder,
  serializeInputPeer,
  serializeUser,
  sourceFlagOverrides,
  uniqueStrings,
  validateDialogFolderName
} from "./runtime";

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
        || (normalizedAlias.length >= 5 && normalizedRaw.includes(normalizedAlias))
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
  return csv(process.env["TELLATIO_OWN_COMPANY_NAMES"] || "");
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
  let store: StateStore | undefined;
  try {
    const local = openLocalState();
    store = local.store;
    const chatStates = store.getAllChatStates();
    const latestChat = [...chatStates].sort(
      (a, b) => b.lastSyncedDate.localeCompare(a.lastSyncedDate) || b.lastMessageId - a.lastMessageId,
    )[0];
    const migration = store.getMigrationInfo();

    return {
      name: "state",
      status: migration.legacyJsonReappeared ? "warn" : "pass",
      detail: migration.legacyJsonReappeared
        ? "sync-state.json reappeared after migration — did the old build run? Its writes are ignored."
        : "loaded local sync state",
      data: {
        dataDir: local.dataDir,
        dbPath: migration.dbPath,
        schemaVersion: migration.schemaVersion,
        jsonMigrated: migration.jsonMigrated,
        chatCount: chatStates.length,
        latestChat,
        runs: store.getAllRuns(),
      },
    };
  } catch (err) {
    return {
      name: "state",
      status: "warn",
      detail: errorMessage(err),
    };
  } finally {
    store?.close();
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


export {
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
};
