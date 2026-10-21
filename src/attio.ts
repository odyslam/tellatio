import type {
  AssociationStatus,
  AssociationSyncMode,
  TelegramAssociation,
} from "./association";
import { normalizeAssociationName } from "./association";
import {
  hasFullIdentityName,
  identityDisplayName,
  identityUsername,
  normalizeIdentityName,
  type TelegramIdentity,
  type TelegramIdentityInput,
} from "./identity";

let apiKey: string;

export function initAttio(key: string): void {
  apiKey = key;
}

export { AttioApiError } from "./attio-http";
import { attioRequest, attioSegment, MAX_ATTIO_BYTES } from "./attio-http";

function attioFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return attioRequest(apiKey, path, options);
}

interface AttioRecord {
  id: { record_id: string };
  values?: Record<string, unknown>;
  created_at?: string;
}

interface AttioRecordList {
  data: AttioRecord[];
}

export interface AttioRecordSummary {
  recordId: string;
  name: string;
  domains: string[];
}

function firstValue(values: Record<string, unknown> | undefined, slug: string): unknown {
  const raw = values?.[slug];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function stringValue(values: Record<string, unknown> | undefined, slug: string): string | undefined {
  const raw = firstValue(values, slug);
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return undefined;

  const value = raw as Record<string, unknown>;
  if (typeof value.value === "string") return value.value;
  if (typeof value.title === "string") return value.title;
  if (typeof value.full_name === "string") return value.full_name;
  if (typeof value.email_address === "string") return value.email_address;
  if (typeof value.original_email_address === "string") return value.original_email_address;
  if (typeof value.phone_number === "string") return value.phone_number;
  if (typeof value.domain === "string") return value.domain;

  const option = value.option;
  if (option && typeof option === "object" && typeof (option as Record<string, unknown>).title === "string") {
    return (option as Record<string, string>).title;
  }

  const status = value.status;
  if (status && typeof status === "object" && typeof (status as Record<string, unknown>).title === "string") {
    return (status as Record<string, string>).title;
  }

  return undefined;
}

function numberValue(values: Record<string, unknown> | undefined, slug: string): number | undefined {
  const raw = firstValue(values, slug);
  if (typeof raw === "number") return raw;
  if (!raw || typeof raw !== "object") return undefined;

  const value = (raw as Record<string, unknown>).value;
  return typeof value === "number" ? value : undefined;
}

function associationFromRecord(record: AttioRecord, requireTargetRecord: boolean): TelegramAssociation | null {
  const values = record.values;
  const telegramChatId = stringValue(values, "telegram_chat_id");
  const telegramChatTitle = stringValue(values, "telegram_chat_title");
  const telegramChatType = stringValue(values, "telegram_chat_type") || "unknown";
  const targetObject = stringValue(values, "crm_object_slug");
  const targetName = stringValue(values, "crm_target_name");
  const targetRecordId = stringValue(values, "crm_record_id");
  const status = stringValue(values, "status") as AssociationStatus | undefined;
  const syncMode = stringValue(values, "sync_mode") as AssociationSyncMode | undefined;

  if (!telegramChatId || !telegramChatTitle || !targetObject || !status) {
    return null;
  }

  if (requireTargetRecord && !targetRecordId) {
    return null;
  }

  return {
    recordId: record.id.record_id,
    telegramChatId,
    telegramChatTitle,
    telegramChatType: ["dm", "group", "supergroup", "channel"].includes(telegramChatType)
      ? telegramChatType as TelegramAssociation["telegramChatType"]
      : "unknown",
    targetObject,
    targetName,
    targetRecordId: targetRecordId || "",
    status,
    confidence: numberValue(values, "confidence") ?? 0,
    reason: stringValue(values, "reason") || "",
    syncMode: syncMode || "transcript",
    lastObservedAt: stringValue(values, "last_observed_at"),
  };
}

function associationValues(association: TelegramAssociation): Record<string, unknown> {
  const values: Record<string, unknown> = {
    telegram_chat_id: association.telegramChatId,
    telegram_chat_title: association.telegramChatTitle,
    telegram_chat_type: association.telegramChatType,
    status: association.status,
    confidence: association.confidence,
    reason: association.reason,
    sync_mode: association.syncMode,
    last_observed_at: association.lastObservedAt || new Date().toISOString(),
  };

  if (association.targetObject) values.crm_object_slug = association.targetObject;
  if (association.targetName) values.crm_target_name = association.targetName;
  if (association.targetRecordId) values.crm_record_id = association.targetRecordId;

  return values;
}

async function queryRecords(objectSlug: string, filter: Record<string, unknown> | undefined, limit = 500): Promise<AttioRecord[]> {
  const body: Record<string, unknown> = { limit };
  if (filter) body.filter = filter;

  const res = await attioFetch(`/objects/${attioSegment(objectSlug)}/records/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as AttioRecordList;
  return data.data;
}

export async function listApprovedTelegramAssociations(objectSlug: string): Promise<TelegramAssociation[]> {
  const records = await queryRecords(objectSlug, {
    status: { $eq: "approved" },
  });

  return records
    .map((record) => associationFromRecord(record, true))
    .filter((association): association is TelegramAssociation => Boolean(association))
    .filter((association) => association.status === "approved");
}

export async function listTelegramAssociations(objectSlug: string, limit = 500): Promise<TelegramAssociation[]> {
  const records = await queryRecords(objectSlug, undefined, limit);

  return records
    .map((record) => associationFromRecord(record, false))
    .filter((association): association is TelegramAssociation => Boolean(association));
}

export async function findTelegramAssociation(
  objectSlug: string,
  telegramChatId: string,
): Promise<TelegramAssociation | null> {
  const records = await queryRecords(objectSlug, {
    telegram_chat_id: { $eq: telegramChatId },
  }, 1);

  if (records.length === 0) return null;
  return associationFromRecord(records[0], false);
}

export async function upsertTelegramAssociation(
  objectSlug: string,
  association: TelegramAssociation,
): Promise<string> {
  const existing = await findTelegramAssociation(objectSlug, association.telegramChatId);
  const values = associationValues(association);

  if (existing?.recordId) {
    await attioFetch(`/objects/${attioSegment(objectSlug)}/records/${attioSegment(existing.recordId)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    });
    return existing.recordId;
  }

  const res = await attioFetch(`/objects/${attioSegment(objectSlug)}/records`, {
    method: "POST",
    body: JSON.stringify({
      data: { values },
    }),
  });

  const data = (await res.json()) as { data: AttioRecord };
  return data.data.id.record_id;
}

function allValues(values: Record<string, unknown> | undefined, slug: string): unknown[] {
  const raw = values?.[slug];
  if (Array.isArray(raw)) return raw;
  return raw === undefined || raw === null ? [] : [raw];
}

function domainValues(values: Record<string, unknown> | undefined): string[] {
  return allValues(values, "domains")
    .map((raw) => {
      if (!raw || typeof raw !== "object") return "";
      const value = raw as Record<string, unknown>;
      return typeof value.domain === "string" ? value.domain : "";
    })
    .filter(Boolean);
}

function stringValues(values: Record<string, unknown> | undefined, slug: string): string[] {
  return allValues(values, slug)
    .map((raw) => {
      if (typeof raw === "string") return raw;
      if (!raw || typeof raw !== "object") return "";

      const value = raw as Record<string, unknown>;
      if (typeof value.value === "string") return value.value;
      if (typeof value.title === "string") return value.title;
      if (typeof value.full_name === "string") return value.full_name;
      if (typeof value.email_address === "string") return value.email_address;
      if (typeof value.original_email_address === "string") return value.original_email_address;
      if (typeof value.phone_number === "string") return value.phone_number;
      if (typeof value.domain === "string") return value.domain;
      return "";
    })
    .filter(Boolean);
}

function summarizeCompany(record: AttioRecord): AttioRecordSummary | null {
  const name = stringValue(record.values, "name");
  if (!name) return null;
  return {
    recordId: record.id.record_id,
    name,
    domains: domainValues(record.values),
  };
}

export async function findCompanyCandidates(name: string): Promise<AttioRecordSummary[]> {
  const records = await queryRecords("companies", {
    name: { $contains: name },
  }, 10);

  return records
    .map(summarizeCompany)
    .filter((record): record is AttioRecordSummary => Boolean(record));
}

export async function listCompanySummaries(limit = 500): Promise<AttioRecordSummary[]> {
  const records = await queryRecords("companies", undefined, limit);

  return records
    .map(summarizeCompany)
    .filter((record): record is AttioRecordSummary => Boolean(record));
}

export interface CompanyResolution {
  status: "resolved" | "ambiguous" | "missing";
  record?: AttioRecordSummary;
  candidates: AttioRecordSummary[];
  reason: string;
}

function resolveCompanyByNameFromCandidates(name: string, candidates: AttioRecordSummary[]): CompanyResolution {
  if (candidates.length === 0) {
    return { status: "missing", candidates, reason: `no company matched ${name}` };
  }

  const target = normalizeAssociationName(name);
  const exact = candidates.filter((candidate) => normalizeAssociationName(candidate.name) === target);
  if (exact.length === 1) {
    return { status: "resolved", record: exact[0], candidates, reason: `exact company name match: ${exact[0].name}` };
  }

  const domain = candidates.filter((candidate) =>
    candidate.domains.some((candidateDomain) => normalizeAssociationName(candidateDomain.split(".")[0]) === target),
  );
  if (domain.length === 1) {
    return { status: "resolved", record: domain[0], candidates, reason: `company domain match: ${domain[0].domains[0]}` };
  }

  const labsSuffix = candidates.filter((candidate) => normalizeAssociationName(candidate.name) === `${target}labs`);
  if (labsSuffix.length === 1) {
    return { status: "resolved", record: labsSuffix[0], candidates, reason: `accepted Labs suffix match: ${labsSuffix[0].name}` };
  }

  return {
    status: "ambiguous",
    candidates,
    reason: `matched ${candidates.length} companies but none was exact enough for ${name}`,
  };
}

export function resolveCompanyByNameLocal(name: string, companies: AttioRecordSummary[]): CompanyResolution {
  const target = normalizeAssociationName(name);
  const candidates = companies.filter((company) => {
    if (normalizeAssociationName(company.name).includes(target)) return true;
    return company.domains.some((domain) => normalizeAssociationName(domain.split(".")[0]).includes(target));
  });
  return resolveCompanyByNameFromCandidates(name, candidates.slice(0, 10));
}

export async function resolveCompanyByName(
  name: string,
  options?: { knownCompanies?: AttioRecordSummary[] },
): Promise<CompanyResolution> {
  const knownCompanies = options?.knownCompanies || [];
  if (knownCompanies.length > 0) {
    const local = resolveCompanyByNameLocal(name, knownCompanies);
    if (local.status === "resolved") return local;
  }

  const remoteCandidates = await findCompanyCandidates(name);
  return resolveCompanyByNameFromCandidates(name, remoteCandidates);
}

export interface PersonSummary {
  recordId: string;
  name: string;
  emails: string[];
  phones: string[];
  telegramUsernames: string[];
  telegramUserIds: string[];
  createdAt?: string;
}

function summarizePerson(record: AttioRecord): PersonSummary | null {
  const name = stringValue(record.values, "name");
  if (!name) return null;

  return {
    recordId: record.id.record_id,
    name,
    emails: stringValues(record.values, "email_addresses"),
    phones: stringValues(record.values, "phone_numbers"),
    telegramUsernames: stringValues(record.values, "telegram").map((username) =>
      username.replace(/^@/, "").toLowerCase(),
    ),
    telegramUserIds: stringValues(record.values, "telegram_user_id"),
    createdAt: record.created_at,
  };
}

function uniquePeople(records: PersonSummary[]): PersonSummary[] {
  const seen = new Set<string>();
  const result: PersonSummary[] = [];

  for (const record of records) {
    if (seen.has(record.recordId)) continue;
    seen.add(record.recordId);
    result.push(record);
  }

  return result;
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

export async function getPersonSummary(recordId: string): Promise<PersonSummary | null> {
  try {
    const res = await attioFetch(`/objects/people/records/${attioSegment(recordId)}`, { method: "GET" });
    const data = (await res.json()) as { data: AttioRecord };
    return summarizePerson(data.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Attio API 404")) return null;
    throw err;
  }
}

export async function findPersonCandidatesByTelegramUserId(telegramUserId: string): Promise<PersonSummary[]> {
  const records = await queryRecords("people", {
    telegram_user_id: { $eq: telegramUserId },
  }, 10);

  return records
    .map(summarizePerson)
    .filter((record): record is PersonSummary => Boolean(record));
}

export async function findPersonCandidatesByUsername(username: string): Promise<PersonSummary[]> {
  const normalized = username.replace(/^@/, "").toLowerCase();
  const records = await queryRecords("people", {
    telegram: { $eq: normalized },
  }, 10);

  return records
    .map(summarizePerson)
    .filter((record): record is PersonSummary => Boolean(record));
}

export async function findPersonCandidatesByPhone(phone: string): Promise<PersonSummary[]> {
  const records = await queryRecords("people", {
    phone_numbers: { $contains: phone },
  }, 10);

  return records
    .map(summarizePerson)
    .filter((record): record is PersonSummary => Boolean(record));
}

export async function findPersonCandidatesByName(name: string): Promise<PersonSummary[]> {
  const records = await queryRecords("people", {
    name: { $contains: name },
  }, 20);

  return records
    .map(summarizePerson)
    .filter((record): record is PersonSummary => Boolean(record));
}

function identityFromRecord(record: AttioRecord, requireTargetRecord: boolean): TelegramIdentity | null {
  const values = record.values;
  const telegramUserId = stringValue(values, "telegram_user_id");
  const telegramDisplayName = stringValue(values, "telegram_display_name");
  const status = stringValue(values, "status") as AssociationStatus | undefined;
  const targetRecordId = stringValue(values, "crm_record_id");

  if (!telegramUserId || !telegramDisplayName || !status) return null;
  if (requireTargetRecord && !targetRecordId) return null;

  return {
    recordId: record.id.record_id,
    telegramUserId,
    telegramUsername: stringValue(values, "telegram_username"),
    telegramDisplayName,
    telegramBio: stringValue(values, "telegram_bio"),
    companyHints: (stringValue(values, "company_hints") || "")
      .split(",")
      .map((hint) => hint.trim())
      .filter(Boolean),
    phone: stringValue(values, "phone"),
    targetRecordId: targetRecordId || "",
    targetName: stringValue(values, "crm_target_name"),
    status,
    confidence: numberValue(values, "confidence") ?? 0,
    reason: stringValue(values, "reason") || "",
    lastObservedAt: stringValue(values, "last_observed_at"),
  };
}

function identityValues(identity: TelegramIdentity): Record<string, unknown> {
  const values: Record<string, unknown> = {
    telegram_user_id: identity.telegramUserId,
    telegram_display_name: identity.telegramDisplayName,
    company_hints: identity.companyHints.join(", "),
    status: identity.status,
    confidence: identity.confidence,
    reason: identity.reason,
    last_observed_at: identity.lastObservedAt || new Date().toISOString(),
  };

  if (identity.telegramUsername) values.telegram_username = identity.telegramUsername;
  if (identity.telegramBio) values.telegram_bio = identity.telegramBio.slice(0, 1000);
  if (identity.phone) values.phone = identity.phone;
  if (identity.targetRecordId) values.crm_record_id = identity.targetRecordId;
  if (identity.targetName) values.crm_target_name = identity.targetName;

  return values;
}

export async function findTelegramIdentity(
  objectSlug: string,
  telegramUserId: string,
): Promise<TelegramIdentity | null> {
  const records = await queryRecords(objectSlug, {
    telegram_user_id: { $eq: telegramUserId },
  }, 2);
  if (records.length > 1) throw new Error("Duplicate Telegram identity mappings; review required");
  if (records.length === 0) return null;
  const identity = identityFromRecord(records[0], false);
  if (!identity || !["approved", "suggested", "ignored", "needs_review"].includes(identity.status)) {
    throw new Error("Malformed Telegram identity mapping; review required");
  }
  if (identity.telegramUserId !== telegramUserId) throw new Error("Telegram identity ID mismatch");
  return identity;
}

export async function listTelegramIdentities(objectSlug: string, limit = 500): Promise<TelegramIdentity[]> {
  const records = await queryRecords(objectSlug, undefined, limit);

  return records
    .map((record) => identityFromRecord(record, false))
    .filter((identity): identity is TelegramIdentity => Boolean(identity));
}

export async function upsertTelegramIdentity(
  objectSlug: string,
  identity: TelegramIdentity,
): Promise<string> {
  const existing = await findTelegramIdentity(objectSlug, identity.telegramUserId);
  const values = identityValues(identity);

  if (existing?.recordId) {
    await attioFetch(`/objects/${attioSegment(objectSlug)}/records/${attioSegment(existing.recordId)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    });
    return existing.recordId;
  }

  const res = await attioFetch(`/objects/${attioSegment(objectSlug)}/records`, {
    method: "POST",
    body: JSON.stringify({
      data: { values },
    }),
  });

  const data = (await res.json()) as { data: AttioRecord };
  return data.data.id.record_id;
}

export interface PersonResolution {
  status: "resolved" | "ambiguous" | "missing" | "blocked";
  preservedIdentity?: TelegramIdentity;
  record?: PersonSummary;
  candidates: PersonSummary[];
  confidence: number;
  reason: string;
}

export async function resolvePersonIdentity(
  input: TelegramIdentityInput,
  identityObjectSlug = "telegram_identities",
): Promise<PersonResolution> {
  if (!/^[1-9][0-9]{0,19}$/.test(input.telegramUserId)) {
    throw new Error("A positive stable Telegram user ID is required");
  }
  const existingIdentity = await findTelegramIdentity(identityObjectSlug, input.telegramUserId);
  if (existingIdentity?.status === "ignored") {
    return { status: "blocked", candidates: [], confidence: 0,
      preservedIdentity: existingIdentity, reason: "Telegram identity is explicitly ignored" };
  }
  if (existingIdentity?.status === "approved") {
    const record = existingIdentity.targetRecordId ? await getPersonSummary(existingIdentity.targetRecordId) : null;
    if (record) {
      return { status: "resolved", record, candidates: [record], confidence: 1,
        reason: `approved Telegram identity mapping: ${existingIdentity.recordId}` };
    }
    // Do not silently redirect an approved mapping if its target disappears.
    return { status: "blocked", candidates: [], confidence: 0,
      preservedIdentity: existingIdentity, reason: "Approved Telegram identity target is missing; review required" };
  }

  const byUserId = await findPersonCandidatesByTelegramUserId(input.telegramUserId);
  if (byUserId.length === 1) {
    return { status: "resolved", record: byUserId[0], candidates: byUserId,
      confidence: 0.99, reason: "exact Telegram user ID match" };
  }
  // Conflicting stable IDs cannot be disambiguated using mutable profile fields.
  if (byUserId.length > 1) {
    return { status: "ambiguous", candidates: uniquePeople(byUserId), confidence: 0,
      reason: "Multiple people share the Telegram user ID; review required" };
  }

  const candidates: PersonSummary[] = [];
  if (input.phone) candidates.push(...await findPersonCandidatesByPhone(input.phone));
  const username = identityUsername(input);
  if (username) candidates.push(...await findPersonCandidatesByUsername(username));
  const displayName = identityDisplayName(input);
  if (displayName && displayName !== input.telegramUserId) {
    candidates.push(...await findPersonCandidatesByName(displayName));
  }
  const unique = uniquePeople(candidates);
  return {
    status: unique.length ? "ambiguous" : "missing", candidates: unique, confidence: 0,
    reason: unique.length
      ? "Mutable Telegram profile matches are suggestions only; explicit identity approval required"
      : `no person matched ${displayName}`,
  };
}

export async function updatePersonTelegramIdentity(recordId: string, input: TelegramIdentityInput): Promise<void> {
  const values: Record<string, unknown> = {
    telegram_user_id: input.telegramUserId,
  };

  const username = identityUsername(input);
  if (username) values.telegram = username;

  if (hasFullIdentityName(input)) {
    const current = await getPersonSummary(recordId);
    const displayName = identityDisplayName(input);
    const currentTokenCount = current?.name.split(/\s+/).filter(Boolean).length ?? 0;
    if (!current || currentTokenCount < 2 || normalizeIdentityName(current.name) === normalizeIdentityName(input.firstName || "")) {
      values.name = {
        full_name: displayName,
        first_name: input.firstName || "",
        last_name: input.lastName || "",
      };
    }
  }

  await attioFetch(`/objects/people/records/${attioSegment(recordId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values } }),
  });
}

export async function updatePersonName(
  recordId: string,
  name: { full: string; first?: string; last?: string },
): Promise<void> {
  const values: Record<string, unknown> = {
    name: {
      full_name: name.full,
      first_name: name.first || "",
      last_name: name.last || "",
    },
  };

  await attioFetch(`/objects/people/records/${attioSegment(recordId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values } }),
  });
}

export interface PersonSyncResolution {
  recordId: string;
  status: "resolved" | "created";
  reason: string;
}

export async function reconcileTelegramIdentity(
  objectSlug: string,
  input: TelegramIdentityInput,
): Promise<{
  identityRecordId: string;
  resolution: PersonResolution;
  identity: TelegramIdentity;
}> {
  const resolution = await resolvePersonIdentity(input, objectSlug);
  if (resolution.status === "blocked" && resolution.preservedIdentity) {
    return { identityRecordId: resolution.preservedIdentity.recordId || "",
      resolution, identity: resolution.preservedIdentity.status === "ignored"
        ? resolution.preservedIdentity
        : { ...resolution.preservedIdentity, status: "needs_review", reason: resolution.reason } };
  }
  const displayName = identityDisplayName(input);
  const username = identityUsername(input);

  const identity: TelegramIdentity = {
    telegramUserId: input.telegramUserId,
    telegramUsername: username,
    telegramDisplayName: displayName,
    telegramBio: input.bio,
    companyHints: uniqueStrings(input.companyHints || []),
    phone: input.phone,
    targetRecordId: resolution.record?.recordId || "",
    targetName: resolution.record?.name || displayName,
    status: resolution.status === "resolved" ? "approved" : "needs_review",
    confidence: resolution.confidence,
    reason: [input.source, resolution.reason].filter(Boolean).join("; "),
    lastObservedAt: input.lastObservedAt || new Date().toISOString(),
  };

  const identityRecordId = await upsertTelegramIdentity(objectSlug, identity);
  if (resolution.status === "resolved" && resolution.record) {
    await updatePersonTelegramIdentity(resolution.record.recordId, input);
  }

  return { identityRecordId, resolution, identity };
}

/**
 * Find a Person record by phone number.
 * Returns the record ID or null if not found.
 */
export async function findPersonByPhone(phone: string): Promise<string | null> {
  const res = await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({
      filter: {
        phone_numbers: { $contains: phone },
      },
    }),
  });

  const data = (await res.json()) as { data: AttioRecord[] };
  if (data.data.length === 0) return null;
  return data.data[0].id.record_id;
}

export async function findPersonByTelegramUserId(telegramUserId: string): Promise<string | null> {
  const matches = await findPersonCandidatesByTelegramUserId(telegramUserId);
  return matches.length === 1 ? matches[0].recordId : null;
}

/**
 * Find a Person record by Telegram username (custom "telegram_username" attribute).
 * Returns the record ID or null if not found.
 */
export async function findPersonByTelegramUsername(username: string): Promise<string | null> {
  const res = await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({
      filter: {
        telegram: { $eq: username.toLowerCase() },
      },
    }),
  });

  const data = (await res.json()) as { data: AttioRecord[] };
  if (data.data.length === 0) return null;
  return data.data[0].id.record_id;
}

/**
 * Find a Person only by an unambiguous stable Telegram user ID.
 */
export async function findPerson(
  phone: string | undefined,
  username: string | undefined,
  telegramUserId?: string,
): Promise<string | null> {
  // Profile fields are discovery hints, not proof of account ownership.
  void phone; void username;
  if (!telegramUserId) return null;
  return findPersonByTelegramUserId(telegramUserId);
}

export interface NewPersonData {
  telegramUserId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  username?: string;
}

/**
 * Create a new Person record in Attio with available Telegram data.
 * Returns the new record ID.
 */
export async function createPerson(data: NewPersonData): Promise<string> {
  const values: Record<string, unknown> = {};

  const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.username || "Unknown";
  values.name = {
    full_name: fullName,
    first_name: data.firstName || "",
    last_name: data.lastName || "",
  };
  if (data.phone) {
    values.phone_numbers = [data.phone];
  }
  if (data.username) {
    values.telegram = data.username.toLowerCase();
  }
  if (data.telegramUserId) {
    values.telegram_user_id = data.telegramUserId;
  }

  const res = await attioFetch("/objects/people/records", {
    method: "POST",
    body: JSON.stringify({
      data: { values },
    }),
  });

  const result = (await res.json()) as { data: AttioRecord };
  const name = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.username || "Unknown";
  console.log(`[attio] Created Person: ${name} (${result.data.id.record_id})`);
  return result.data.id.record_id;
}

/**
 * Find a Person by stable Telegram ID, or create one if not found.
 */
export async function findOrCreatePerson(data: NewPersonData): Promise<string> {
  // Retain the legacy helper without retaining an alternate approval bypass.
  const person = await resolveOrCreatePerson(data, { autoCreate: true });
  if (!person) throw new Error("Telegram identity requires review or a stable user ID");
  return person.recordId;
}

export async function resolveOrCreatePerson(
  data: NewPersonData,
  options: {
    identityObjectSlug?: string;
    autoCreate: boolean;
    source?: string;
  },
): Promise<PersonSyncResolution | null> {
  // Without a stable ID, never fall back to a name/phone/username merge.
  if (!data.telegramUserId) return null;

  const identityInput: TelegramIdentityInput = {
    telegramUserId: data.telegramUserId,
    firstName: data.firstName,
    lastName: data.lastName,
    username: data.username,
    phone: data.phone,
    source: options.source,
  };
  const reconciliation = await reconcileTelegramIdentity(
    options.identityObjectSlug || "telegram_identities",
    identityInput,
  );

  if (reconciliation.resolution.status === "resolved" && reconciliation.resolution.record) {
    return {
      recordId: reconciliation.resolution.record.recordId,
      status: "resolved",
      reason: reconciliation.resolution.reason,
    };
  }

  if (!options.autoCreate || reconciliation.resolution.status !== "missing") return null;

  const recordId = await createPerson(data);
  await upsertTelegramIdentity(options.identityObjectSlug || "telegram_identities", {
    telegramUserId: data.telegramUserId,
    telegramUsername: identityUsername(identityInput),
    telegramDisplayName: identityDisplayName(identityInput),
    phone: data.phone,
    targetRecordId: recordId,
    targetName: identityDisplayName(identityInput),
    status: "approved",
    confidence: 0.7,
    companyHints: uniqueStrings(identityInput.companyHints || []),
    telegramBio: identityInput.bio,
    reason: [options.source, "created new person after no safe match"].filter(Boolean).join("; "),
    lastObservedAt: new Date().toISOString(),
  });

  return {
    recordId,
    status: "created",
    reason: "created new person after no safe match",
  };
}

export interface TelegramStats {
  connectionStrength: string;
  firstInteraction: string; // ISO date
  lastInteraction: string;  // ISO date
  messageCount: number;
}

/**
 * Update all Telegram-related fields on a Person record in a single PATCH.
 */
export async function updateTelegramStats(recordId: string, stats: TelegramStats): Promise<void> {
  await attioFetch(`/objects/people/records/${attioSegment(recordId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        values: {
          telegram_connection: stats.connectionStrength,
          telegram_first_interaction: stats.firstInteraction,
          telegram_last_interaction: stats.lastInteraction,
          telegram_message_count: stats.messageCount,
        },
      },
    }),
  });
}

interface AttioNote {
  id: { note_id: string };
  title: string;
}

/**
 * Find a note by title on a person record. Returns the note ID or null.
 */
async function findNoteByTitle(parentObject: string, recordId: string, title: string): Promise<string | null> {
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await attioFetch(
      `/notes?parent_object=${encodeURIComponent(parentObject)}&parent_record_id=${encodeURIComponent(recordId)}&limit=${limit}&offset=${offset}`,
      { method: "GET" },
    );

    const data = (await res.json()) as { data: AttioNote[] };
    const match = data.data.find((n) => n.title === title);
    if (match) return match.id.note_id;
    if (data.data.length < limit) return null;
    offset += limit;
  }
}

async function deleteNote(noteId: string): Promise<void> {
  await attioFetch(`/notes/${attioSegment(noteId)}`, { method: "DELETE" });
}

async function createNote(
  parentObject: string,
  recordId: string,
  title: string,
  content: string,
  createdAt?: string,
): Promise<string> {
  const noteData: Record<string, unknown> = {
    parent_object: parentObject,
    parent_record_id: recordId,
    title,
    format: "markdown",
    content,
  };
  if (createdAt) {
    noteData.created_at = createdAt;
  }

  const res = await attioFetch("/notes", {
    method: "POST",
    body: JSON.stringify({ data: noteData }),
  });

  const data = (await res.json()) as { data: { id: { note_id: string } } };
  return data.data.id.note_id;
}

/**
 * Create or replace a note on a person record.
 * If a note with the same title exists, delete it and recreate with new content.
 * Preserves the original creation date.
 */
export async function upsertNote(
  recordId: string,
  title: string,
  content: string,
  createdAt?: string,
  parentObject = "people",
): Promise<string> {
  attioSegment(parentObject);
  attioSegment(recordId);
  // Fail before deleting the existing note if the replacement cannot be sent.
  if (Buffer.byteLength(JSON.stringify({ data: {
    parent_object: parentObject, parent_record_id: recordId, title,
    format: "markdown", content, ...(createdAt ? { created_at: createdAt } : {}),
  } })) > MAX_ATTIO_BYTES) throw new Error("Attio note exceeds size limit");
  const existingId = await findNoteByTitle(parentObject, recordId, title);
  if (existingId) {
    await deleteNote(existingId);
  }
  return createNote(parentObject, recordId, title, content, createdAt);
}
