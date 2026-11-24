import { Api } from "telegram";
import {
  assertWritesAllowed,
  associationChatType,
  chatDisplayName,
  client,
  csv,
  dialogCanonicalId,
  die,
  dryRun,
  filterBannedDialogs,
  loadCliBanList,
  matchBannedEntity,
  numFlag,
  out
} from "../../cli/runtime";
import { matchBannedTelegramUser, type BanList } from "../../shared/bans";
import { canonicalCompanyName, normalizeAssociationName, suggestAssociation, type AssociationSuggestion, type TelegramAssociation } from "./association";
import * as attio from "./client";
import { identityDisplayName, identityUsername, type TelegramIdentity, type TelegramIdentityInput } from "./identity";
import { cmdFoldersAdd } from "../../cli/commands";
import { parseTimeFilter } from "../../cli/time";
import { compactText, recordRunState, uniqueStrings } from "./runtime";

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
  source?: string;
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

function associationTitleCompanyHints(
  chatId: string,
  title: string,
  type: TelegramAssociation["telegramChatType"],
): string[] {
  const suggestion = suggestAssociation({ chatId, title, type });
  if (suggestion.suggestedTargetObject !== "companies" || !suggestion.suggestedTargetName) return [];
  return [canonicalCompanyName(suggestion.suggestedTargetName)];
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
          source: "profile",
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
      `participant ${top.source || "company"} signals mention ${top.name}: ${top.people.slice(0, 4).join(", ")}`,
    ],
  };
}

async function groupIdentityUsers(
  entity: Api.Chat | Api.Channel,
  sinceTs: number,
  participantLimit: number,
): Promise<Api.User[]> {
  let users = await recentGroupSenders(
    entity,
    sinceTs,
    Math.max(100, participantLimit * 5),
  );
  if (users.length === 0) {
    users = (await client.getParticipants(entity as never, {}))
      .filter((user): user is Api.User => user instanceof Api.User);
  }
  return users.slice(0, participantLimit);
}

function companyHintsFromPerson(
  identity: TelegramIdentity,
  person: attio.PersonSummary,
  knownCompanies: KnownCompany[],
  excludedCompanyNames: string[],
): KnownCompany[] {
  const rawHints = uniqueStrings([
    ...identity.companyHints,
    ...person.emails.map((email) => email.split("@")[1] || ""),
    ...person.emails.map((email) => (email.split("@")[1] || "").split(".")[0] || ""),
  ]);

  const matches: KnownCompany[] = [];
  const seen = new Set<string>();
  for (const hint of rawHints) {
    const company = knownCompanyMatch(hint, knownCompanies);
    if (!company || isExcludedCompany(company.name, excludedCompanyNames)) continue;
    const key = normalizeAssociationName(company.name);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(company);
  }
  return matches;
}

async function collectIdentityCompanySignals(
  entity: unknown,
  identityObjectSlug: string,
  knownCompanies: KnownCompany[],
  sinceTs: number,
  participantLimit: number,
  excludedCompanyNames: string[],
  banList: BanList = loadCliBanList(),
): Promise<CompanyProfileSignal[]> {
  if (!knownCompanies.length) return [];
  if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) return [];

  const byCompany = new Map<string, CompanyProfileSignal>();
  const users = await groupIdentityUsers(entity, sinceTs, participantLimit);

  for (const user of users) {
    if (!(user instanceof Api.User) || user.bot) continue;
    if (matchBannedEntity(banList, user)) continue;

    const identity = await attio.findTelegramIdentity(identityObjectSlug, user.id.toString());
    if (identity?.status !== "approved" || !identity.targetRecordId) continue;

    const person = await attio.getPersonSummary(identity.targetRecordId);
    if (!person) continue;

    for (const company of companyHintsFromPerson(identity, person, knownCompanies, excludedCompanyNames)) {
      const key = normalizeAssociationName(company.name);
      const existing = byCompany.get(key);
      byCompany.set(key, {
        recordId: existing?.recordId || company.recordId,
        name: existing?.name || company.name,
        count: (existing?.count || 0) + 1,
        people: uniqueStrings([...(existing?.people || []), person.name]),
        source: "approved identity",
      });
    }
  }

  return Array.from(byCompany.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function mergeCompanySignals(signals: CompanyProfileSignal[]): CompanyProfileSignal[] {
  const byCompany = new Map<string, CompanyProfileSignal>();
  for (const signal of signals) {
    const key = normalizeAssociationName(signal.name);
    if (!key) continue;
    const existing = byCompany.get(key);
    byCompany.set(key, {
      recordId: existing?.recordId || signal.recordId,
      name: existing?.name || signal.name,
      count: (existing?.count || 0) + signal.count,
      people: uniqueStrings([...(existing?.people || []), ...signal.people]),
      source: uniqueStrings([existing?.source, signal.source]).join("+") || undefined,
    });
  }
  return Array.from(byCompany.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

async function cmdFoldersSyncAttio(flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("cmdFoldersSyncAttio");
  const folderName = flags["folder"] || process.env["TELEGRAM_FOLDER_NAME"] || "Attio";
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const includePeople = flags["include-people"] !== "false";
  const isDryRun = dryRun(flags);

  const approved = await attio.listApprovedTelegramAssociations(objectSlug);
  const chatIds = approved
    .filter((association) => includePeople || association.targetObject !== "people")
    .map((association) => association.telegramChatId)
    .filter(Boolean);

  if (chatIds.length === 0) {
    out({
      folder: folderName,
      object: objectSlug,
      approvedCount: approved.length,
      addCount: 0,
      added: [],
    });
    return;
  }

  await cmdFoldersAdd([folderName, chatIds.join(","), isDryRun ? "dry-run" : ""]);
}

// ── discover ────────────────────────────────────────────────────

async function cmdDiscoverAssociations(flags: Record<string, string>): Promise<void> {
  const limit = numFlag(flags, "limit", 100);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const includeIgnored = flags["include-ignored"] === "true";
  const onlyChats = flags["only-chats"]
    ? new Set(flags["only-chats"].split(",").map((v) => v.trim()).filter(Boolean))
    : undefined;
  let suggestions = await discoverAssociationSuggestions(limit, sinceTs, includeIgnored, loadCliBanList());
  if (onlyChats && onlyChats.size > 0) {
    suggestions = suggestions.filter((s) => onlyChats.has(s.telegramChatId));
  }
  out(suggestions);
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
  if (!dryRun(flags)) assertWritesAllowed("cmdAssociationsUpsert");
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
  if (!dryRun(flags)) assertWritesAllowed("cmdAssociationsReconcile");
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const identityObjectSlug = flags["identity-object"] || process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
  const limit = numFlag(flags, "limit", 100);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const minConfidence = flags["min-confidence"] ? Number.parseFloat(flags["min-confidence"]) : 0.45;
  const includeIdentityEvidence = flags["include-identity-evidence"] !== "false";
  const includeProfileDescriptions = flags["include-profile-descriptions"] !== "false";
  const identityParticipantLimit = numFlag(flags, "identity-participant-limit", 30);
  const profileParticipantLimit = numFlag(flags, "profile-participant-limit", 30);
  const companyLimit = numFlag(flags, "company-limit", 500);
  const onlyChats = flags["only-chats"]
    ? new Set(flags["only-chats"].split(",").map((v) => v.trim()).filter(Boolean))
    : undefined;
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
  const knownCompanies = includeProfileDescriptions || includeIdentityEvidence
    ? await loadKnownCompanies(approvedAssociations, companyLimit)
    : [];
  const fetchBio = createBioFetcher(includeProfileDescriptions);
  const excludedCompanyNames = loadOwnCompanyNames();
  const suggestions = await discoverAssociationSuggestions(limit, sinceTs, false, banList);
  const scopedSuggestions = onlyChats && onlyChats.size > 0
    ? suggestions.filter((s) => onlyChats.has(s.telegramChatId))
    : suggestions;
  const result = {
    approved: [] as Array<Record<string, unknown>>,
    needsReview: [] as Array<Record<string, unknown>>,
    skippedApproved: [] as Array<Record<string, unknown>>,
    ignored: [] as Array<Record<string, unknown>>,
    wouldUpsert: [] as Array<TelegramAssociation>,
  };

  for (const originalSuggestion of scopedSuggestions) {
    const dialog = dialogByChatId.get(originalSuggestion.telegramChatId);
    const identitySignals = includeIdentityEvidence && dialog?.entity
      ? await collectIdentityCompanySignals(
        dialog.entity,
        identityObjectSlug,
        knownCompanies,
        sinceTs,
        identityParticipantLimit,
        excludedCompanyNames,
        banList,
      )
      : [];
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
    const companySignals = mergeCompanySignals([...identitySignals, ...profileSignals]);
    const suggestion = withCompanyProfileSignals(originalSuggestion, companySignals);

    if (!suggestion.suggestedTargetObject || !suggestion.suggestedTargetName || suggestion.confidence < minConfidence) {
      result.ignored.push({
        chat: suggestion.telegramChatTitle,
        confidence: suggestion.confidence,
        reason: "below confidence threshold or no inferred target",
        profileSignals,
        identitySignals,
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

    if (existing?.status === "ignored") {
      result.ignored.push({ chat: suggestion.telegramChatTitle, reason: "explicitly ignored association preserved" });
      continue;
    }

    const status: TelegramAssociation["status"] = "needs_review";
    let targetRecordId = "";
    let resolutionReason = "";

    let targetName = suggestion.suggestedTargetName;
    if (suggestion.suggestedTargetObject === "companies") {
      targetName = canonicalCompanyName(suggestion.suggestedTargetName);
      const topCompanySignal = companySignals[0];
      const conflictingCompanySignal = topCompanySignal
        && normalizeAssociationName(canonicalCompanyName(topCompanySignal.name)) !== normalizeAssociationName(targetName)
        ? topCompanySignal
        : undefined;
      const companySignalForTarget = companySignals.find((signal) =>
        normalizeAssociationName(canonicalCompanyName(signal.name)) === normalizeAssociationName(targetName),
      );

      if (conflictingCompanySignal) {
        resolutionReason = `participant ${conflictingCompanySignal.source || "company"} evidence points to ${conflictingCompanySignal.name}, while chat inference points to ${targetName}`;
        result.needsReview.push({
          chat: suggestion.telegramChatTitle,
          suggestedTarget: targetName,
          confidence: suggestion.confidence,
          reason: resolutionReason,
          profileSignals,
          identitySignals,
        });
      } else if (companySignalForTarget?.recordId) {
        targetRecordId = companySignalForTarget.recordId;
        resolutionReason = `participant ${companySignalForTarget.source || "company"} signal match: ${companySignalForTarget.name}`;
        if (targetName !== suggestion.suggestedTargetName) {
          resolutionReason = `alias ${suggestion.suggestedTargetName} -> ${targetName}; ${resolutionReason}`;
        }
        result.needsReview.push({
          chat: suggestion.telegramChatTitle,
          company: companySignalForTarget.name,
          recordId: companySignalForTarget.recordId,
          confidence: suggestion.confidence,
          reason: resolutionReason,
          profileSignals,
          identitySignals,
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
          targetRecordId = resolution.record.recordId;
          result.needsReview.push({
            chat: suggestion.telegramChatTitle,
            company: resolution.record.name,
            recordId: resolution.record.recordId,
            confidence: suggestion.confidence,
            reason: resolutionReason,
            profileSignals,
            identitySignals,
          });
        } else {
          result.needsReview.push({
            chat: suggestion.telegramChatTitle,
            suggestedTarget: targetName,
            confidence: suggestion.confidence,
            reason: resolution.reason,
            profileSignals,
            identitySignals,
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
        identitySignals,
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
      reason: [...suggestion.reasons, resolutionReason, "Heuristic candidate only; explicit destination approval required"].filter(Boolean).join("; "),
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

async function cmdAssociationsCompanyCandidates(flags: Record<string, string>): Promise<void> {
  const name = flags["name"];
  if (!name) die("Required flag: --name");
  out(await attio.findCompanyCandidates(name));
}

// ── identities ──────────────────────────────────────────────────

async function collectIdentityInputs(flags: Record<string, string>): Promise<TelegramIdentityInput[]> {
  const objectSlug = flags["object"] || process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
  const limit = numFlag(flags, "limit", 100);
  const participantLimit = numFlag(flags, "participant-limit", 50);
  const sinceTs = flags["since"] ? parseTimeFilter(flags["since"]) : parseTimeFilter("3d");
  const includeParticipants = flags["include-participants"] !== "false";
  const includeProfileDescriptions = flags["include-profile-descriptions"] !== "false";
  const includeExplicitGroups = flags["include-explicit-groups"] === "true";
  const useGroupTitleCompanyHints = flags["group-title-company-hints"] !== "false";
  const companyLimit = numFlag(flags, "company-limit", 500);
  const onlyChats = flags["only-chats"]
    ? new Set(flags["only-chats"].split(",").map((v) => v.trim()).filter(Boolean))
    : undefined;
  const banList = loadCliBanList();

  if (includeExplicitGroups && (!onlyChats || onlyChats.size === 0)) {
    die("--include-explicit-groups requires --only-chats so unassociated group participant scans stay explicitly scoped");
  }

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
  const approvedAssociationIds = new Set(approvedAssociations.map((association) => association.telegramChatId));

  const dialogByChatId = new Map<string, (typeof dialogs)[number]>();
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity || !("id" in entity)) continue;
    dialogByChatId.set(entity.id.toString(), dialog);

    if (entity instanceof Api.User && dialog.message && dialog.message.date >= sinceTs) {
      if (onlyChats && onlyChats.size > 0 && !onlyChats.has(entity.id.toString())) continue;
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

  async function addGroupParticipantIdentities(
    dialog: (typeof dialogs)[number] | undefined,
    source: string,
    baseCompanyHints: string[] = [],
  ): Promise<void> {
    if (!dialog?.entity || dialog.entity instanceof Api.User) return;
    if (!(dialog.entity instanceof Api.Chat || dialog.entity instanceof Api.Channel)) return;
    if (!dialog.message || dialog.message.date < sinceTs) return;

    const lastObservedAt = new Date(dialog.message.date * 1000).toISOString();
    const users = await groupIdentityUsers(dialog.entity, sinceTs, participantLimit);
    for (const user of users) {
      if (user instanceof Api.User) {
        if (matchBannedEntity(banList, user)) continue;
        const bio = await userBio(user);
        addIdentity(telegramIdentityFromUser(
          user,
          source,
          lastObservedAt,
          bio,
          uniqueStrings([
            ...baseCompanyHints,
            ...inferCompanyHintsFromText(bio, knownCompanies, [user.username || ""], excludedCompanyNames),
          ]),
        ));
      }
    }
  }

  if (includeParticipants) {
    const scopedApprovedAssociations = onlyChats && onlyChats.size > 0
      ? approvedAssociations.filter((a) => onlyChats.has(a.telegramChatId))
      : approvedAssociations;
    for (const association of scopedApprovedAssociations) {
      const dialog = dialogByChatId.get(association.telegramChatId);
      await addGroupParticipantIdentities(
        dialog,
        `Group: ${association.telegramChatTitle}`,
        association.targetObject === "companies" ? [association.targetName || ""] : [],
      );
    }

    if (includeExplicitGroups && onlyChats) {
      for (const chatId of onlyChats) {
        if (approvedAssociationIds.has(chatId)) continue;
        const dialog = dialogByChatId.get(chatId);
        if (!dialog?.entity || dialog.entity instanceof Api.User) continue;
        if (!(dialog.entity instanceof Api.Chat || dialog.entity instanceof Api.Channel)) continue;
        const title = chatDisplayName(dialog.entity, dialog.name || dialog.title || "Unknown");
        const type = associationChatType(dialog.entity);
        await addGroupParticipantIdentities(
          dialog,
          `Group: ${title} (explicit scope)`,
          useGroupTitleCompanyHints
            ? associationTitleCompanyHints(chatId, title, type)
            : [],
        );
      }
    }
  }

  return Array.from(identities.values())
    .sort((a, b) => identityDisplayName(a).localeCompare(identityDisplayName(b)));
}

async function cmdIdentitiesReconcile(flags: Record<string, string>): Promise<void> {
  if (!dryRun(flags)) assertWritesAllowed("cmdIdentitiesReconcile");
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
      status: resolution.preservedIdentity?.status === "ignored" ? "ignored" : resolution.status === "resolved" ? "approved" : "needs_review",
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
  if (!dryRun(flags)) assertWritesAllowed("cmdIdentitiesUpsert");
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


export { cmdAssociationsCompanyCandidates,cmdAssociationsReconcile,cmdAssociationsStatus,cmdAssociationsUpsert,cmdDiscoverAssociations,cmdFoldersSyncAttio,cmdIdentitiesCandidates,cmdIdentitiesReconcile,cmdIdentitiesStatus,cmdIdentitiesUpsert };
