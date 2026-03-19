import { Api } from "telegram";
import * as telegram from "./telegram";
import * as attio from "./attio";
import { normalizePhone } from "./phone";
import {
  loadState, saveState, getChatState, setChatState,
  addInteractions, getInteractions,
  appendToTranscript, getTranscript,
  type SyncState, type StoredMessage,
} from "./state";
import { computeStrength } from "./strength";
import type { Config } from "./config";
import type { TelegramMessage } from "./telegram";

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
  messages: TelegramMessage[];
  stored: StoredMessage[];
  participants?: telegram.Participant[];
  userInfo?: { firstName?: string; lastName?: string; phone?: string; username?: string };
}

/**
 * Run one sync cycle. Two phases:
 * 1. Batch-fetch all messages from Telegram (rate-limited by GramJS)
 * 2. Write to Attio in parallel per person
 */
export async function runSync(config: Config): Promise<void> {
  const state = loadState(config.dataDir);
  const me = await telegram.getMe();

  console.log(`[sync] Starting sync cycle. Folder: "${config.folderName}"`);

  const peers = await telegram.getFolderChatIds(config.folderName);
  if (peers.length === 0) {
    console.log("[sync] No chats in folder. Nothing to do.");
    return;
  }

  console.log(`[sync] Found ${peers.length} chats in folder`);

  // Phase 1: Batch-fetch from Telegram
  const fetched: ChatFetchResult[] = [];
  for (const peer of peers) {
    try {
      const result = await fetchChat(state, peer, me);
      if (result) fetched.push(result);
    } catch (err) {
      console.error("[sync] Error fetching chat:", err);
    }
  }

  if (fetched.length === 0) {
    console.log("[sync] No new messages across any chats.");
    saveState(config.dataDir, state);
    return;
  }

  console.log(`[sync] ${fetched.length} chats with new messages. Writing to Attio...`);

  // Phase 2: Process all Attio writes
  // Collect all (recordId → work) so we can parallelize per-person
  const personWork = new Map<string, Array<() => Promise<void>>>();

  for (const chat of fetched) {
    if (chat.chatInfo.isGroup) {
      await queueGroupWork(chat, me, state, personWork);
    } else {
      await queueDMWork(chat, state, personWork);
    }

    // Update chat sync state
    const maxId = Math.max(...chat.messages.map((m) => m.id));
    const lastDate = dateOfMessage(chat.messages[chat.messages.length - 1].date);
    setChatState(state, chat.chatInfo.idStr, { lastMessageId: maxId, lastSyncedDate: lastDate });
  }

  // Execute Attio writes — parallel across persons, sequential within each person
  const CONCURRENCY = 5;
  const entries = Array.from(personWork.entries());
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ([recordId, tasks]) => {
        for (const task of tasks) {
          try {
            await task();
          } catch (err) {
            console.error(`[sync] Attio write failed for ${recordId}:`, err);
          }
        }
      }),
    );
  }

  saveState(config.dataDir, state);
  console.log("[sync] Cycle complete");
}

async function fetchChat(
  state: SyncState,
  peer: Api.TypeInputPeer,
  me: { idStr: string; firstName: string },
): Promise<ChatFetchResult | null> {
  const chatInfo = await telegram.resolveChat(peer);
  if (!chatInfo) return null;

  const chatState = getChatState(state, chatInfo.idStr);
  const allMessages = await telegram.getMessages(peer, chatState.lastMessageId);
  if (allMessages.length === 0) return null;

  const messages = completedDayMessages(allMessages);
  if (messages.length === 0) return null;

  console.log(`[sync] Fetched ${messages.length} msgs from ${chatInfo.title}`);

  const stored = toStoredMessages(messages, me.idStr, me.firstName);

  // Pre-fetch Telegram metadata needed for Attio writes
  if (chatInfo.isGroup) {
    const participants = await telegram.getGroupParticipants(peer);
    return { peer, chatInfo, messages, stored, participants };
  } else {
    const userInfo = await telegram.getUserInfo(peer);
    return { peer, chatInfo, messages, stored, userInfo };
  }
}

async function queueDMWork(
  chat: ChatFetchResult,
  state: SyncState,
  personWork: Map<string, Array<() => Promise<void>>>,
): Promise<void> {
  const normalized = normalizePhone(chat.userInfo?.phone) ?? undefined;

  const recordId = await attio.findOrCreatePerson({
    firstName: chat.userInfo?.firstName,
    lastName: chat.userInfo?.lastName,
    phone: normalized,
    username: chat.userInfo?.username,
  });

  const noteTitle = `Telegram · ${chat.chatInfo.title}`;

  appendToTranscript(state, recordId, chat.chatInfo.idStr, noteTitle, chat.stored);
  trackInteractions(state, recordId, chat.stored);

  if (!personWork.has(recordId)) personWork.set(recordId, []);
  personWork.get(recordId)!.push(
    () => upsertChatNote(state, recordId, chat.chatInfo.idStr),
    () => updatePersonStats(state, recordId),
  );
}

async function queueGroupWork(
  chat: ChatFetchResult,
  me: { idStr: string; firstName: string },
  state: SyncState,
  personWork: Map<string, Array<() => Promise<void>>>,
): Promise<void> {
  const participants = chat.participants || [];
  const seenRecords = new Set<string>();

  for (const p of participants) {
    if (p.userIdStr === me.idStr) continue;

    const normalized = normalizePhone(p.phone) ?? undefined;
    const recordId = await attio.findOrCreatePerson({
      firstName: p.firstName,
      lastName: p.lastName,
      phone: normalized,
      username: p.username,
    });

    if (seenRecords.has(recordId)) continue;
    seenRecords.add(recordId);

    const noteTitle = `Telegram · [${chat.chatInfo.title}]`;

    appendToTranscript(state, recordId, chat.chatInfo.idStr, noteTitle, chat.stored);
    trackInteractions(state, recordId, chat.stored);

    if (!personWork.has(recordId)) personWork.set(recordId, []);
    personWork.get(recordId)!.push(
      () => upsertChatNote(state, recordId, chat.chatInfo.idStr),
      () => updatePersonStats(state, recordId),
    );
  }

  if (seenRecords.size > 0) {
    console.log(`[sync] Group "${chat.chatInfo.title}": ${seenRecords.size} participants queued`);
  }
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

async function upsertChatNote(state: SyncState, recordId: string, chatId: string): Promise<void> {
  const transcript = getTranscript(state, recordId, chatId);
  if (!transcript || transcript.messages.length === 0) return;

  const content = formatTranscript(transcript.messages);
  const createdAt = `${transcript.firstDate}T00:00:00.000000000Z`;

  await attio.upsertNote(recordId, transcript.title, content, createdAt);
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
