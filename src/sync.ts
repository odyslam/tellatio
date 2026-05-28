import { Api } from "telegram";
import * as telegram from "./telegram";
import * as attio from "./attio";
import { normalizePhone } from "./phone";
import {
  loadState, saveState, getChatState, setChatState,
  addInteractions, getInteractions,
  setRunState,
  appendToTranscript, getTranscript,
  type SyncState, type StoredMessage,
} from "./state";
import { computeStrength } from "./strength";
import type { Config } from "./config";
import type { TelegramMessage } from "./telegram";
import type { TelegramAssociation } from "./association";
import {
  compileBanList,
  describeBannedUser,
  matchBannedTelegramChat,
  matchBannedTelegramUser,
  parseEnvBannedUsers,
  type BanList,
} from "./bans";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateOfMessage(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().slice(0, 10);
}

function completedDayMessages(messages: TelegramMessage[]): TelegramMessage[] {
  const today = todayUTC();
  return messages.filter((msg) => dateOfMessage(msg.date) < today);
}

function formatTranscript(messages: StoredMessage[]): string {
  if (messages.length === 0) return "";

  const byDay = new Map<string, StoredMessage[]>();
  for (const msg of messages) {
    const date = dateOfMessage(msg.date);
    const existing = byDay.get(date);
    if (existing) {
      existing.push(msg);
    } else {
      byDay.set(date, [msg]);
    }
  }

  const sections: string[] = [];
  const sortedDays = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [date, dayMsgs] of sortedDays) {
    const lines = dayMsgs.map((msg) => {
      const time = new Date(msg.date * 1000).toISOString().slice(11, 16);
      return `**${time}** _${msg.sender}:_ ${msg.text}`;
    });
    sections.push(`### ${date}\n\n${lines.join("\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

function toStoredMessages(
  messages: TelegramMessage[],
  myIdStr: string,
  myName: string,
): StoredMessage[] {
  return messages.map((msg) => ({
    date: msg.date,
    sender: msg.senderIdStr === myIdStr ? myName : msg.senderName,
    text: msg.text,
  }));
}

// Collected data from the Telegram fetch phase
interface ChatFetchResult {
  peer: Api.TypeInputPeer;
  chatInfo: telegram.ChatInfo;
  association?: TelegramAssociation;
  messages: TelegramMessage[];
  stored: StoredMessage[];
  participants?: telegram.Participant[];
  userInfo?: { userIdStr?: string; firstName?: string; lastName?: string; phone?: string; username?: string };
}

interface SyncChat {
  peer: Api.TypeInputPeer;
  chatInfo: telegram.ChatInfo;
  association?: TelegramAssociation;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one sync cycle. Two phases:
 * 1. Batch-fetch all messages from Telegram (rate-limited by GramJS)
 * 2. Write to Attio in parallel per person
 */
export async function runSync(config: Config): Promise<void> {
  const state = loadState(config.dataDir);
  const banList = compileBanList([
    ...parseEnvBannedUsers(),
    ...await telegram.getBanFolderUsers(config.banFolderName),
  ]);
  const me = await telegram.getMe();

  console.log(`[sync] Starting sync cycle. Source: ${config.syncSource}`);
  if (banList.users.length > 0) {
    console.log(`[sync] Ban list active for ${banList.users.length} Telegram peer(s)`);
  }

  const syncChats = await getSyncChats(config, banList);
  if (syncChats.length === 0) {
    console.log("[sync] No chats selected for sync.");
    setRunState(state, "sync", {
      status: "success",
      finishedAt: new Date().toISOString(),
      counts: { selectedChats: 0, fetchedChats: 0, recordWork: 0 },
    });
    saveState(config.dataDir, state);
    return;
  }

  console.log(`[sync] Found ${syncChats.length} selected chats`);

  // Phase 1: Batch-fetch from Telegram
  const fetched: ChatFetchResult[] = [];
  for (const [index, syncChat] of syncChats.entries()) {
    console.log(`[sync] Checking chat ${index + 1}/${syncChats.length}: ${syncChat.chatInfo.title} (${syncChat.chatInfo.idStr})`);
    try {
      const result = await fetchChat(state, syncChat, me, config, banList);
      if (result) fetched.push(result);
    } catch (err) {
      console.error(`[sync] Error fetching chat ${syncChat.chatInfo.title} (${syncChat.chatInfo.idStr}):`, err);
    }
  }

  if (fetched.length === 0) {
    console.log("[sync] No new messages across any chats.");
    setRunState(state, "sync", {
      status: "success",
      finishedAt: new Date().toISOString(),
      counts: { selectedChats: syncChats.length, fetchedChats: 0, recordWork: 0 },
    });
    saveState(config.dataDir, state);
    return;
  }

  console.log(`[sync] ${fetched.length} chats with new messages. Writing to Attio...`);

  // Phase 2: Process all Attio writes
  // Collect all (recordId → work) so we can parallelize per-person
  const recordWork = new Map<string, Array<() => Promise<void>>>();

  for (const chat of fetched) {
    if (chat.association) {
      queueAssociatedWork(chat, state, recordWork);
    } else if (chat.chatInfo.isGroup) {
      await queueGroupWork(chat, me, state, recordWork, config);
    } else {
      await queueDMWork(chat, state, recordWork, config);
    }

    // Update chat sync state
    const maxId = Math.max(...chat.messages.map((m) => m.id));
    const lastDate = dateOfMessage(chat.messages[chat.messages.length - 1].date);
    setChatState(state, chat.chatInfo.idStr, { lastMessageId: maxId, lastSyncedDate: lastDate });
  }

  // Execute Attio writes — parallel across persons, sequential within each person
  const CONCURRENCY = 5;
  const entries = Array.from(recordWork.entries());
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ([recordKey, tasks]) => {
        for (const task of tasks) {
          try {
            await task();
          } catch (err) {
            console.error(`[sync] Attio write failed for ${recordKey}:`, err);
          }
        }
      }),
    );
  }

  setRunState(state, "sync", {
    status: "success",
    finishedAt: new Date().toISOString(),
    counts: { selectedChats: syncChats.length, fetchedChats: fetched.length, recordWork: entries.length },
  });
  saveState(config.dataDir, state);
  console.log("[sync] Cycle complete");
}

async function getSyncChats(config: Config, banList: BanList): Promise<SyncChat[]> {
  if (config.syncSource === "folder") {
    return getFolderSyncChats(config.folderName, banList);
  }

  try {
    const associations = await attio.listApprovedTelegramAssociations(config.associationObjectSlug);
    if (associations.length === 0) {
      console.log(`[sync] No approved associations found in ${config.associationObjectSlug}`);
      return config.folderFallbackEnabled ? getFolderSyncChats(config.folderName, banList) : [];
    }

    const recentChats = await telegram.getRecentChats(config.discoveryDialogLimit);
    const recentById = new Map(recentChats.map((chat) => [chat.chatInfo.idStr, chat]));
    const selected: SyncChat[] = [];

    for (const association of associations) {
      const recent = recentById.get(association.telegramChatId);
      if (!recent) {
        console.warn(`[sync] Approved chat not found in recent dialogs: ${association.telegramChatTitle} (${association.telegramChatId})`);
        continue;
      }
      const banned = matchBannedChat(recent.chatInfo, banList);
      if (banned) {
        console.warn(`[sync] Skipping banned chat ${recent.chatInfo.title} (${recent.chatInfo.idStr}) matched ${describeBannedUser(banned)}`);
        continue;
      }

      selected.push({
        peer: recent.peer,
        chatInfo: recent.chatInfo,
        association,
      });
    }

    return selected;
  } catch (err) {
    console.error(`[sync] Failed to load approved associations from ${config.associationObjectSlug}:`, err);
    return config.folderFallbackEnabled ? getFolderSyncChats(config.folderName, banList) : [];
  }
}

async function getFolderSyncChats(folderName: string, banList: BanList): Promise<SyncChat[]> {
  console.log(`[sync] Loading legacy Telegram folder: "${folderName}"`);
  const peers = await telegram.getFolderChatIds(folderName);
  const chats: SyncChat[] = [];

  for (const peer of peers) {
    const chatInfo = await telegram.resolveChat(peer);
    if (!chatInfo) continue;
    const banned = matchBannedChat(chatInfo, banList);
    if (banned) {
      console.warn(`[sync] Skipping banned folder chat ${chatInfo.title} (${chatInfo.idStr}) matched ${describeBannedUser(banned)}`);
      continue;
    }
    chats.push({ peer, chatInfo });
  }

  return chats;
}

async function fetchChat(
  state: SyncState,
  syncChat: SyncChat,
  me: { idStr: string; firstName: string },
  config: Config,
  banList: BanList,
): Promise<ChatFetchResult | null> {
  const { peer, chatInfo, association } = syncChat;
  const banned = matchBannedChat(chatInfo, banList);
  if (banned) {
    console.warn(`[sync] Refusing to fetch banned chat ${chatInfo.title} (${chatInfo.idStr}) matched ${describeBannedUser(banned)}`);
    return null;
  }

  const chatState = getChatState(state, chatInfo.idStr);
  const allMessages = await withTimeout(
    telegram.getMessages(peer, chatState.lastMessageId),
    config.chatFetchTimeoutSeconds * 1000,
    `fetching Telegram messages for ${chatInfo.title} (${chatInfo.idStr})`,
  );
  if (allMessages.length === 0) return null;

  const completedMessages = completedDayMessages(allMessages);
  const messages = completedMessages.filter((msg) => !matchBannedTelegramUser(banList, {
    userIdStr: msg.senderIdStr,
    username: msg.senderUsername,
  }));
  const skippedBannedMessages = completedMessages.length - messages.length;
  if (skippedBannedMessages > 0) {
    console.warn(`[sync] Skipped ${skippedBannedMessages} banned sender message(s) in ${chatInfo.title}`);
  }
  if (messages.length === 0) return null;

  console.log(`[sync] Fetched ${messages.length} msgs from ${chatInfo.title}`);

  const stored = toStoredMessages(messages, me.idStr, me.firstName);

  // Pre-fetch Telegram metadata needed for Attio writes
  if (association) {
    return { peer, chatInfo, association, messages, stored };
  }

  if (chatInfo.isGroup) {
    const participants = (await telegram.getGroupParticipants(peer)).filter((participant) => {
      const participantMatch = matchBannedTelegramUser(banList, {
        userIdStr: participant.userIdStr,
        username: participant.username,
      });
      if (participantMatch) {
        console.warn(`[sync] Skipping banned group participant ${participant.username ? `@${participant.username}` : participant.userIdStr} matched ${describeBannedUser(participantMatch)}`);
        return false;
      }
      return true;
    });
    return { peer, chatInfo, association, messages, stored, participants };
  } else {
    const userInfo = await telegram.getUserInfo(peer);
    const userMatch = matchBannedTelegramUser(banList, {
      userIdStr: userInfo.userIdStr || chatInfo.idStr,
      username: userInfo.username || chatInfo.username,
    });
    if (userMatch) {
      console.warn(`[sync] Refusing to queue banned DM ${chatInfo.title} (${chatInfo.idStr}) matched ${describeBannedUser(userMatch)}`);
      return null;
    }
    return { peer, chatInfo, association, messages, stored, userInfo };
  }
}

function matchBannedChat(chatInfo: telegram.ChatInfo, banList: BanList) {
  return matchBannedTelegramChat(banList, {
    chatId: chatInfo.idStr,
    chatType: chatInfo.type,
    userIdStr: chatInfo.type === "dm" ? chatInfo.idStr : undefined,
    username: chatInfo.username,
  });
}

async function queueDMWork(
  chat: ChatFetchResult,
  state: SyncState,
  recordWork: Map<string, Array<() => Promise<void>>>,
  config: Config,
): Promise<void> {
  const normalized = normalizePhone(chat.userInfo?.phone) ?? undefined;

  const person = await attio.resolveOrCreatePerson({
    telegramUserId: chat.userInfo?.userIdStr,
    firstName: chat.userInfo?.firstName,
    lastName: chat.userInfo?.lastName,
    phone: normalized,
    username: chat.userInfo?.username,
  }, {
    identityObjectSlug: config.identityObjectSlug,
    autoCreate: config.autoCreatePeople,
    source: `DM: ${chat.chatInfo.title}`,
  });

  if (!person) {
    console.warn(`[sync] Skipping DM "${chat.chatInfo.title}" until Telegram identity is reviewed`);
    return;
  }

  const recordId = person.recordId;
  const noteTitle = `Telegram · ${chat.chatInfo.title}`;

  appendToTranscript(state, recordId, chat.chatInfo.idStr, noteTitle, chat.stored);
  trackInteractions(state, recordId, chat.stored);

  const key = recordKey("people", recordId);
  if (!recordWork.has(key)) recordWork.set(key, []);
  recordWork.get(key)!.push(
    () => upsertChatNote(state, "people", recordId, chat.chatInfo.idStr),
    () => updatePersonStats(state, recordId),
  );
}

function queueAssociatedWork(
  chat: ChatFetchResult,
  state: SyncState,
  recordWork: Map<string, Array<() => Promise<void>>>,
): void {
  if (!chat.association) return;

  const { targetObject, targetRecordId, syncMode } = chat.association;
  const noteTitle = `Telegram · ${chat.chatInfo.title}`;

  appendToTranscript(state, targetRecordId, chat.chatInfo.idStr, noteTitle, chat.stored);

  if (targetObject === "people") {
    trackInteractions(state, targetRecordId, chat.stored);
  }

  const key = recordKey(targetObject, targetRecordId);
  if (!recordWork.has(key)) recordWork.set(key, []);

  if (syncMode !== "stats") {
    recordWork.get(key)!.push(
      () => upsertChatNote(state, targetObject, targetRecordId, chat.chatInfo.idStr),
    );
  }

  if (targetObject === "people") {
    recordWork.get(key)!.push(() => updatePersonStats(state, targetRecordId));
  }
}

async function queueGroupWork(
  chat: ChatFetchResult,
  me: { idStr: string; firstName: string },
  state: SyncState,
  recordWork: Map<string, Array<() => Promise<void>>>,
  config: Config,
): Promise<void> {
  const participants = chat.participants || [];
  const seenRecords = new Set<string>();
  const autoCreateGroupPeople = config.autoCreatePeople && config.autoCreateGroupPeople;

  for (const p of participants) {
    if (p.userIdStr === me.idStr) continue;

    const normalized = normalizePhone(p.phone) ?? undefined;
    const person = await attio.resolveOrCreatePerson({
      telegramUserId: p.userIdStr,
      firstName: p.firstName,
      lastName: p.lastName,
      phone: normalized,
      username: p.username,
    }, {
      identityObjectSlug: config.identityObjectSlug,
      autoCreate: autoCreateGroupPeople,
      source: `Group: ${chat.chatInfo.title}`,
    });

    if (!person) {
      console.warn(`[sync] Skipping participant "${[p.firstName, p.lastName].filter(Boolean).join(" ") || p.username || p.userIdStr}" until Telegram identity is reviewed`);
      continue;
    }

    const recordId = person.recordId;
    if (seenRecords.has(recordId)) continue;
    seenRecords.add(recordId);

    const noteTitle = `Telegram · [${chat.chatInfo.title}]`;

    appendToTranscript(state, recordId, chat.chatInfo.idStr, noteTitle, chat.stored);
    trackInteractions(state, recordId, chat.stored);

    const key = recordKey("people", recordId);
    if (!recordWork.has(key)) recordWork.set(key, []);
    recordWork.get(key)!.push(
      () => upsertChatNote(state, "people", recordId, chat.chatInfo.idStr),
      () => updatePersonStats(state, recordId),
    );
  }

  if (seenRecords.size > 0) {
    console.log(`[sync] Group "${chat.chatInfo.title}": ${seenRecords.size} participants queued`);
  }
}

function recordKey(parentObject: string, recordId: string): string {
  return `${parentObject}:${recordId}`;
}

function trackInteractions(state: SyncState, recordId: string, messages: StoredMessage[]): void {
  const byDay = new Map<string, number>();
  for (const msg of messages) {
    const date = dateOfMessage(msg.date);
    byDay.set(date, (byDay.get(date) || 0) + 1);
  }
  for (const [date, count] of byDay) {
    addInteractions(state, recordId, date, count);
  }
}

async function upsertChatNote(
  state: SyncState,
  parentObject: string,
  recordId: string,
  chatId: string,
): Promise<void> {
  const transcript = getTranscript(state, recordId, chatId);
  if (!transcript || transcript.messages.length === 0) return;

  const content = formatTranscript(transcript.messages);
  const createdAt = `${transcript.firstDate}T00:00:00.000000000Z`;

  await attio.upsertNote(recordId, transcript.title, content, createdAt, parentObject);
}

async function updatePersonStats(state: SyncState, recordId: string): Promise<void> {
  const interactions = getInteractions(state, recordId);
  if (interactions.length === 0) return;

  const sorted = [...interactions].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = sorted[0].date;
  const lastDate = sorted[sorted.length - 1].date;
  const totalMessages = interactions.reduce((sum, d) => sum + d.count, 0);
  const level = computeStrength(interactions);

  try {
    await attio.updateTelegramStats(recordId, {
      connectionStrength: level,
      firstInteraction: firstDate,
      lastInteraction: lastDate,
      messageCount: totalMessages,
    });
    console.log(`[sync] Stats for ${recordId}: ${level}, ${totalMessages} msgs`);
  } catch (err) {
    console.error(`[sync] Failed to update stats for ${recordId}:`, err);
  }
}
