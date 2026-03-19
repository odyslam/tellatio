const BASE_URL = "https://api.attio.com/v2";

let apiKey: string;

export function initAttio(key: string): void {
  apiKey = key;
}

async function attioFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attio API ${res.status}: ${path} — ${body}`);
  }

  return res;
}

interface AttioRecord {
  id: { record_id: string };
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
 * Find a Person by phone first, then fall back to Telegram username.
 */
export async function findPerson(phone: string | undefined, username: string | undefined): Promise<string | null> {
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
  const existing = await findPerson(data.phone, data.username);
  if (existing) return existing;

  return createPerson(data);
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
async function findNoteByTitle(recordId: string, title: string): Promise<string | null> {
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await attioFetch(
      `/notes?parent_object=people&parent_record_id=${recordId}&limit=${limit}&offset=${offset}`,
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
  recordId: string,
  title: string,
  content: string,
  createdAt?: string,
): Promise<string> {
  const noteData: Record<string, unknown> = {
    parent_object: "people",
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
): Promise<string> {
  const existingId = await findNoteByTitle(recordId, title);
  if (existingId) {
    await deleteNote(existingId);
  }
  return createNote(recordId, title, content, createdAt);
}
