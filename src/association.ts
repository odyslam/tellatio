export type AssociationStatus = "suggested" | "approved" | "ignored" | "needs_review";

export type AssociationTargetObject = "people" | "companies" | "deals" | "users" | "workspaces" | string;

export type AssociationSyncMode = "transcript" | "summary" | "stats";

export interface TelegramAssociation {
  recordId?: string;
  telegramChatId: string;
  telegramChatTitle: string;
  telegramChatType: "dm" | "group" | "supergroup" | "channel" | "unknown";
  targetObject: AssociationTargetObject;
  targetName?: string;
  targetRecordId: string;
  status: AssociationStatus;
  confidence: number;
  reason: string;
  syncMode: AssociationSyncMode;
  lastObservedAt?: string;
}

export function normalizeAssociationName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

const COMPANY_ALIASES: Record<string, string> = {
  titan: "Gattaca",
};

export function canonicalCompanyName(name: string): string {
  return COMPANY_ALIASES[normalizeAssociationName(name)] || name;
}

export interface AssociationSuggestion {
  telegramChatId: string;
  telegramChatTitle: string;
  telegramChatType: TelegramAssociation["telegramChatType"];
  lastMessageAt?: string;
  lastMessageExcerpt?: string;
  suggestedTargetObject: "people" | "companies" | null;
  suggestedTargetName: string | null;
  confidence: number;
  proposedStatus: AssociationStatus;
  syncMode: AssociationSyncMode;
  reasons: string[];
}

const WORK_TERMS = [
  "phylax",
  "assertion",
  "assertions",
  "liveness",
  "protocol",
  "network",
  "networks",
  "contract",
  "contracts",
  "integration",
  "launch",
  "sales",
  "intro",
  "intros",
  "meeting",
  "call",
  "zoom",
  "one-pager",
  "roadmap",
  "base",
  "linea",
  "ethereum",
  "defi",
  "exploit",
  "insurance",
  "policy",
  "policies",
  "dapp",
  "rollup",
  "partner",
  "commercial",
  "commitment",
  "fundraise",
  "investor",
  "legal",
];

const IGNORE_TERMS = [
  "flats",
  "announcements",
  "liquidations",
  "trading",
  "dance",
  "shop",
  "sauna",
  "nomads",
  "berlin",
];

function includesAny(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

function clampConfidence(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function inferPhylaxCounterparty(title: string): string | null {
  const match = title.match(/^\s*(.+?)\s*<>\s*(.+?)\s*$/i);
  if (!match) return null;

  const left = match[1].trim();
  const right = match[2].trim();
  if (/^phylax(?: systems)?$/i.test(left)) return right;
  if (/^phylax(?: systems)?$/i.test(right)) return left;
  return null;
}

export function suggestAssociation(input: {
  chatId: string;
  title: string;
  type: TelegramAssociation["telegramChatType"];
  lastMessageText?: string;
  lastMessageAt?: string;
}): AssociationSuggestion {
  const reasons: string[] = [];
  const text = `${input.title}\n${input.lastMessageText || ""}`;
  const matchedWorkTerms = includesAny(text, WORK_TERMS);
  const matchedIgnoreTerms = includesAny(input.title, IGNORE_TERMS);
  const counterparty = inferPhylaxCounterparty(input.title);

  let score = 0;
  let targetObject: "people" | "companies" | null = null;
  let targetName: string | null = null;

  if (counterparty) {
    score += 0.65;
    targetObject = "companies";
    targetName = counterparty;
    reasons.push(`title matches Phylax <> ${counterparty}`);
  }

  if (input.type === "dm") {
    score += 0.15;
    targetObject ||= "people";
    targetName ||= input.title;
    reasons.push("direct message");
  }

  if (matchedWorkTerms.length > 0) {
    score += Math.min(0.25, matchedWorkTerms.length * 0.04);
    reasons.push(`work terms: ${matchedWorkTerms.slice(0, 5).join(", ")}`);
  }

  if (matchedIgnoreTerms.length > 0) {
    score -= 0.5;
    reasons.push(`ignored-title terms: ${matchedIgnoreTerms.join(", ")}`);
  }

  if (input.type === "channel") {
    score -= 0.15;
    reasons.push("broadcast channel");
  }

  const confidence = clampConfidence(score);
  const proposedStatus: AssociationStatus =
    confidence >= 0.85 ? "approved" : confidence >= 0.45 ? "suggested" : "ignored";

  return {
    telegramChatId: input.chatId,
    telegramChatTitle: input.title,
    telegramChatType: input.type,
    lastMessageAt: input.lastMessageAt,
    lastMessageExcerpt: input.lastMessageText?.slice(0, 240),
    suggestedTargetObject: targetObject,
    suggestedTargetName: targetName,
    confidence,
    proposedStatus,
    syncMode: "transcript",
    reasons,
  };
}
