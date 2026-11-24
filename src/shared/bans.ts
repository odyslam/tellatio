export interface BannedTelegramUser {
  chatId?: string;
  chatType?: "dm" | "group" | "supergroup" | "channel" | "unknown";
  userId?: string;
  username?: string;
  displayName?: string;
  reason?: string;
  createdAt?: string;
  source?: "env" | "folder";
}

export interface BanList {
  users: BannedTelegramUser[];
  chatIds: Set<string>;
  userIds: Set<string>;
  usernames: Set<string>;
}

const ENV_NAME = "TELLATIO_BANNED_USERS";

export function normalizeTelegramUsername(value: string | undefined): string | undefined {
  if (!value) return undefined;

  let normalized = value.trim();
  if (!normalized) return undefined;

  normalized = normalized
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^tg:\/\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/, 1)[0]
    .trim()
    .toLowerCase();

  return normalized || undefined;
}

export function normalizeTelegramUserId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return /^-?\d+$/.test(normalized) ? normalized : undefined;
}

export function bannedUserEntryFromIdentifier(
  identifier: string,
  fields: Partial<BannedTelegramUser> = {},
): BannedTelegramUser {
  const userId = normalizeTelegramUserId(identifier);
  const username = userId ? undefined : normalizeTelegramUsername(identifier);

  return cleanBannedUser({
    ...fields,
    userId: fields.userId || userId,
    username: fields.username || username,
    createdAt: fields.createdAt || new Date().toISOString(),
  });
}

export function cleanBannedUser(entry: BannedTelegramUser): BannedTelegramUser {
  return {
    chatId: normalizeTelegramUserId(entry.chatId),
    chatType: entry.chatType,
    userId: normalizeTelegramUserId(entry.userId),
    username: normalizeTelegramUsername(entry.username),
    displayName: entry.displayName?.trim() || undefined,
    reason: entry.reason?.trim() || undefined,
    createdAt: entry.createdAt,
    source: entry.source,
  };
}

export function parseEnvBannedUsers(raw = process.env[ENV_NAME]): BannedTelegramUser[] {
  if (!raw) return [];

  return raw
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => bannedUserEntryFromIdentifier(item, {
      source: "env",
      reason: `${ENV_NAME}`,
    }))
    .filter((entry) => entry.userId || entry.username);
}

export function compileBanList(users: BannedTelegramUser[]): BanList {
  const deduped = dedupeBannedUsers(users);
  return {
    users: deduped,
    chatIds: new Set(deduped.map((entry) => entry.chatId).filter((value): value is string => Boolean(value))),
    userIds: new Set(deduped.map((entry) => entry.userId).filter((value): value is string => Boolean(value))),
    usernames: new Set(deduped.map((entry) => entry.username).filter((value): value is string => Boolean(value))),
  };
}

export function dedupeBannedUsers(users: BannedTelegramUser[]): BannedTelegramUser[] {
  const byKey = new Map<string, BannedTelegramUser>();

  for (const raw of users) {
    const entry = cleanBannedUser(raw);
    const key = bannedUserKey(entry);
    if (!key) continue;

    const existing = byKey.get(key);
    byKey.set(key, {
      ...existing,
      ...entry,
      chatId: existing?.chatId || entry.chatId,
      chatType: existing?.chatType || entry.chatType,
      userId: existing?.userId || entry.userId,
      username: existing?.username || entry.username,
      displayName: existing?.displayName || entry.displayName,
      reason: existing?.reason || entry.reason,
      createdAt: existing?.createdAt || entry.createdAt,
      source: mergeSource(existing?.source, entry.source),
    });
  }

  return Array.from(byKey.values())
    .sort((a, b) => describeBannedUser(a).localeCompare(describeBannedUser(b)));
}

export interface TelegramUserRef {
  userIdStr?: string;
  username?: string;
  chatId?: string;
}

export function matchBannedTelegramUser(
  banList: BanList,
  user: TelegramUserRef,
): BannedTelegramUser | undefined {
  const chatId = normalizeTelegramUserId(user.chatId);
  if (chatId) {
    const match = banList.users.find((entry) => entry.chatId === chatId && (!entry.chatType || entry.chatType === "dm"));
    if (match) return match;
  }

  const userId = normalizeTelegramUserId(user.userIdStr);
  if (userId) {
    const match = banList.users.find((entry) => entry.userId === userId);
    if (match) return match;
  }

  const username = normalizeTelegramUsername(user.username);
  if (username) {
    return banList.users.find((entry) => entry.username === username);
  }

  return undefined;
}

export function matchBannedIdentifier(
  banList: BanList,
  identifier: string,
): BannedTelegramUser | undefined {
  return matchBannedTelegramUser(banList, {
    userIdStr: normalizeTelegramUserId(identifier),
    username: normalizeTelegramUsername(identifier),
  });
}

export function matchBannedTelegramChat(
  banList: BanList,
  chat: { chatId?: string; chatType?: BannedTelegramUser["chatType"]; userIdStr?: string; username?: string },
): BannedTelegramUser | undefined {
  if (chat.chatType === "dm") {
    const userMatch = matchBannedTelegramUser(banList, {
      chatId: chat.chatId,
      userIdStr: chat.userIdStr || chat.chatId,
      username: chat.username,
    });
    if (userMatch) return userMatch;
  }

  const chatId = normalizeTelegramUserId(chat.chatId);
  if (!chatId) return undefined;
  return banList.users.find((entry) => entry.chatId === chatId);
}

export function describeBannedUser(entry: BannedTelegramUser): string {
  if (entry.username) return `@${entry.username}`;
  if (entry.userId) return entry.userId;
  if (entry.chatId) return entry.chatId;
  return entry.displayName || "unknown";
}

function bannedUserKey(entry: BannedTelegramUser): string | undefined {
  if (entry.chatId) return `chat:${entry.chatType || "unknown"}:${entry.chatId}`;
  if (entry.userId) return `id:${entry.userId}`;
  if (entry.username) return `username:${entry.username}`;
  return undefined;
}

function mergeSource(
  existing: BannedTelegramUser["source"] | undefined,
  next: BannedTelegramUser["source"] | undefined,
): BannedTelegramUser["source"] | undefined {
  if (existing === "folder" || next === "folder") return "folder";
  if (existing === "env" || next === "env") return "env";
  return next || existing;
}
