import type { AssociationStatus } from "./association";

export interface TelegramIdentityInput {
  telegramUserId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  displayName?: string;
  bio?: string;
  companyHints?: string[];
  source?: string;
  lastObservedAt?: string;
}

export interface TelegramIdentity {
  recordId?: string;
  telegramUserId: string;
  telegramUsername?: string;
  telegramDisplayName: string;
  telegramBio?: string;
  companyHints: string[];
  phone?: string;
  targetRecordId: string;
  targetName?: string;
  status: AssociationStatus;
  confidence: number;
  reason: string;
  lastObservedAt?: string;
}

export function normalizeIdentityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function identityDisplayName(input: TelegramIdentityInput): string {
  return input.displayName
    || [input.firstName, input.lastName].filter(Boolean).join(" ")
    || input.username
    || input.telegramUserId;
}

export function hasFullIdentityName(input: TelegramIdentityInput): boolean {
  return Boolean(input.firstName?.trim() && input.lastName?.trim());
}

export function identityUsername(input: TelegramIdentityInput): string | undefined {
  const username = input.username?.trim().replace(/^@/, "").toLowerCase();
  return username || undefined;
}
