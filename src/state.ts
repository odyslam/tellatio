import * as fs from "node:fs";
import * as path from "node:path";

export interface ChatSyncState {
  lastMessageId: number;
  lastSyncedDate: string; // YYYY-MM-DD
}

export interface DayInteraction {
  date: string; // YYYY-MM-DD
  count: number; // message count
}

export interface PersonInteractions {
  days: DayInteraction[];
}

export interface StoredMessage {
  date: number;   // unix timestamp
  sender: string;  // display name
  text: string;
}

// Key: "recordId:chatId"
export interface NoteTranscript {
  title: string;
  firstDate: string; // YYYY-MM-DD of earliest message
  messages: StoredMessage[];
}

export interface SyncState {
  chats: Record<string, ChatSyncState>;
  // recordId → interaction history
  interactions: Record<string, PersonInteractions>;
  // "recordId:chatId" → full transcript for the note
  transcripts: Record<string, NoteTranscript>;
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "sync-state.json");
}

export function loadState(dataDir: string): SyncState {
  const p = statePath(dataDir);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as SyncState;
  } catch {
    return { chats: {}, interactions: {}, transcripts: {} };
  }
}

export function saveState(dataDir: string, state: SyncState): void {
  const p = statePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function getChatState(state: SyncState, chatId: string): ChatSyncState {
  return state.chats[chatId] || { lastMessageId: 0, lastSyncedDate: "1970-01-01" };
}

export function setChatState(state: SyncState, chatId: string, update: ChatSyncState): void {
  state.chats[chatId] = update;
}

/**
 * Record message interactions for a person on a given day.
 * Merges with existing data (won't double-count).
 */
export function addInteractions(state: SyncState, recordId: string, date: string, count: number): void {
  if (!state.interactions) state.interactions = {};
  if (!state.interactions[recordId]) {
    state.interactions[recordId] = { days: [] };
  }

  const person = state.interactions[recordId];
  const existing = person.days.find((d) => d.date === date);
  if (existing) {
    existing.count = Math.max(existing.count, count); // idempotent
  } else {
    person.days.push({ date, count });
  }
}

export function getInteractions(state: SyncState, recordId: string): DayInteraction[] {
  return state.interactions?.[recordId]?.days || [];
}

function transcriptKey(recordId: string, chatId: string): string {
  return `${recordId}:${chatId}`;
}

export function appendToTranscript(
  state: SyncState,
  recordId: string,
  chatId: string,
  title: string,
  messages: StoredMessage[],
): void {
  if (!state.transcripts) state.transcripts = {};
  const key = transcriptKey(recordId, chatId);

  if (!state.transcripts[key]) {
    const firstDate = messages.length > 0
      ? new Date(messages[0].date * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    state.transcripts[key] = { title, firstDate, messages: [] };
  }

  state.transcripts[key].messages.push(...messages);
}

export function getTranscript(state: SyncState, recordId: string, chatId: string): NoteTranscript | null {
  return state.transcripts?.[transcriptKey(recordId, chatId)] || null;
}
