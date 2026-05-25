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

const BASE_URL = "https://api.attio.com/v2";

let apiKey: string;

export function initAttio(key: string): void {
  apiKey = key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AttioApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Attio API ${status}: ${path} — ${body}`);
  }
}

async function attioFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const maxAttempts = 5;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (res.ok) return res;

      const body = await res.text();
      const shouldRetry = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!shouldRetry || attempt >= maxAttempts) {
        throw new AttioApiError(res.status, path, body);
      }

      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number.parseFloat(retryAfter) * 1000 : Number.NaN;
      const backoffMs = Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : Math.min(30_000, 750 * (2 ** (attempt - 1)));
      await sleep(backoffMs);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) throw err;
      await sleep(Math.min(30_000, 750 * (2 ** (attempt - 1))));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Attio request failed");
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

  const res = await attioFetch(`/objects/${objectSlug}/records/query`, {
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
    await attioFetch(`/objects/${objectSlug}/records/${existing.recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    });
    return existing.recordId;
  }

  const res = await attioFetch(`/objects/${objectSlug}/records`, {
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

function candidateMatchesCompanyHint(candidate: PersonSummary, hint: string): boolean {
  const normalizedHint = normalizeAssociationName(hint);
  if (!normalizedHint) return false;

  if (normalizeIdentityName(candidate.name).includes(normalizedHint)) return true;

  return candidate.emails.some((email) => {
    const domain = email.split("@")[1] || "";
    const domainRoot = domain.split(".")[0] || "";
    return normalizeAssociationName(domain).includes(normalizedHint)
      || normalizeAssociationName(domainRoot) === normalizedHint;
  });
}

function findCompanyHintCandidate(
  candidates: PersonSummary[],
  companyHints: string[] | undefined,
): { candidate: PersonSummary; hint: string } | null {
  const unique = uniquePeople(candidates);
  const hints = uniqueStrings(companyHints || []);

  for (const hint of hints) {
    const matches = unique.filter((candidate) => candidateMatchesCompanyHint(candidate, hint));
    if (matches.length === 1) return { candidate: matches[0], hint };
  }

  return null;
}

export async function getPersonSummary(recordId: string): Promise<PersonSummary | null> {
  const res = await attioFetch(`/objects/people/records/${recordId}`, { method: "GET" });
  const data = (await res.json()) as { data: AttioRecord };
  return summarizePerson(data.data);
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
  }, 1);

  if (records.length === 0) return null;
  return identityFromRecord(records[0], false);
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
    await attioFetch(`/objects/${objectSlug}/records/${existing.recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    });
    return existing.recordId;
  }

  const res = await attioFetch(`/objects/${objectSlug}/records`, {
    method: "POST",
    body: JSON.stringify({
      data: { values },
    }),
  });

  const data = (await res.json()) as { data: AttioRecord };
  return data.data.id.record_id;
}

export interface PersonResolution {
  status: "resolved" | "ambiguous" | "missing";
  record?: PersonSummary;
  candidates: PersonSummary[];
  confidence: number;
  reason: string;
}

export async function resolvePersonIdentity(
  input: TelegramIdentityInput,
  identityObjectSlug = "telegram_identities",
): Promise<PersonResolution> {
  const existingIdentity = await findTelegramIdentity(identityObjectSlug, input.telegramUserId);
  if (existingIdentity?.status === "approved" && existingIdentity.targetRecordId) {
    const record = await getPersonSummary(existingIdentity.targetRecordId);
    if (record) {
      return {
        status: "resolved",
        record,
        candidates: [record],
        confidence: 1,
        reason: `approved Telegram identity mapping: ${existingIdentity.recordId}`,
      };
    }
  }

  const candidates: PersonSummary[] = [];

  const byUserId = await findPersonCandidatesByTelegramUserId(input.telegramUserId);
  candidates.push(...byUserId);
  if (byUserId.length === 1) {
    return {
      status: "resolved",
      record: byUserId[0],
      candidates: uniquePeople(candidates),
      confidence: 0.99,
      reason: "exact Telegram user ID match",
    };
  }

  if (input.phone) {
    const byPhone = await findPersonCandidatesByPhone(input.phone);
    candidates.push(...byPhone);
    if (byPhone.length === 1) {
      return {
        status: "resolved",
        record: byPhone[0],
        candidates: uniquePeople(candidates),
        confidence: 0.95,
        reason: "phone number match",
      };
    }
  }

  const username = identityUsername(input);
  if (username) {
    const byUsername = await findPersonCandidatesByUsername(username);
    candidates.push(...byUsername);
    if (byUsername.length === 1) {
      return {
        status: "resolved",
        record: byUsername[0],
        candidates: uniquePeople(candidates),
        confidence: 0.93,
        reason: `Telegram username match: ${username}`,
      };
    }
  }

  const displayName = identityDisplayName(input);
  if (hasFullIdentityName(input)) {
    const byFullName = await findPersonCandidatesByName(displayName);
    candidates.push(...byFullName);

    const target = normalizeIdentityName(displayName);
    const exact = byFullName.filter((candidate) => normalizeIdentityName(candidate.name) === target);
    if (exact.length === 1) {
      return {
        status: "resolved",
        record: exact[0],
        candidates: uniquePeople(candidates),
        confidence: 0.87,
        reason: `exact full-name match: ${exact[0].name}`,
      };
    }
  } else if (displayName && displayName !== input.telegramUserId) {
    candidates.push(...await findPersonCandidatesByName(displayName));
  }

  const unique = uniquePeople(candidates);
  const companyHintMatch = findCompanyHintCandidate(unique, input.companyHints);
  if (companyHintMatch) {
    return {
      status: "resolved",
      record: companyHintMatch.candidate,
      candidates: unique,
      confidence: 0.82,
      reason: `company hint match: ${companyHintMatch.hint} -> ${companyHintMatch.candidate.name}`,
    };
  }

  if (unique.length > 0) {
    return {
      status: "ambiguous",
      candidates: unique,
      confidence: 0.5,
      reason: `found ${unique.length} possible person record(s), but no safe identity match`,
    };
  }

  return {
    status: "missing",
    candidates: [],
    confidence: 0,
    reason: `no person matched ${displayName}`,
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

  await attioFetch(`/objects/people/records/${recordId}`, {
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
  return matches[0]?.recordId || null;
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
 * Find a Person by stable Telegram user ID, phone, then Telegram username.
 */
export async function findPerson(
  phone: string | undefined,
  username: string | undefined,
  telegramUserId?: string,
): Promise<string | null> {
  if (telegramUserId) {
    const byTelegramUserId = await findPersonByTelegramUserId(telegramUserId);
    if (byTelegramUserId) return byTelegramUserId;
  }

  if (phone) {
    const byPhone = await findPersonByPhone(phone);
    if (byPhone) return byPhone;
  }

  if (username) {
    const byUsername = await findPersonByTelegramUsername(username);
    if (byUsername) return byUsername;
  }

  return null;
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
 * Find a Person by phone/username, or create one if not found.
 */
export async function findOrCreatePerson(data: NewPersonData): Promise<string> {
  const existing = await findPerson(data.phone, data.username, data.telegramUserId);
  if (existing) return existing;

  return createPerson(data);
}

export async function resolveOrCreatePerson(
  data: NewPersonData,
  options: {
    identityObjectSlug?: string;
    autoCreate: boolean;
    source?: string;
  },
): Promise<PersonSyncResolution | null> {
  if (!data.telegramUserId) {
    if (!options.autoCreate) return null;
    return {
      recordId: await findOrCreatePerson(data),
      status: "created",
      reason: "created because Telegram user ID was unavailable",
    };
  }

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

  if (!options.autoCreate) return null;

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
  await attioFetch(`/objects/people/records/${recordId}`, {
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
      `/notes?parent_object=${parentObject}&parent_record_id=${recordId}&limit=${limit}&offset=${offset}`,
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
  await attioFetch(`/notes/${noteId}`, { method: "DELETE" });
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
  const existingId = await findNoteByTitle(parentObject, recordId, title);
  if (existingId) {
    await deleteNote(existingId);
  }
  return createNote(parentObject, recordId, title, content, createdAt);
}
