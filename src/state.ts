import * as fs from "node:fs";
import * as path from "node:path";
import { openDriver, type SqliteDriver } from "./db";

export interface ChatSyncState {
  lastMessageId: number;
  lastSyncedDate: string; // YYYY-MM-DD
}

export interface ChatStateRecord extends ChatSyncState {
  chatId: string;
}

export interface DayInteraction {
  date: string; // YYYY-MM-DD
  count: number; // message count
}

export interface StoredMessage {
  date: number; // unix timestamp
  sender: string; // display name
  text: string;
  id?: number; // Telegram message id, used for idempotent appends
}

export interface NoteTranscript {
  title: string;
  firstDate: string; // YYYY-MM-DD of earliest message
  messages: StoredMessage[];
}

export interface RunState {
  status: "success" | "failed" | "dry_run";
  finishedAt: string;
  counts?: Record<string, number>;
  error?: string;
}

export interface MigrationInfo {
  dbPath: string;
  schemaVersion: number;
  jsonMigrated: boolean;
  jsonMigratedAt?: string;
  /** True if a legacy sync-state.json reappeared with an mtime after migration. */
  legacyJsonReappeared: boolean;
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  last_message_id INTEGER NOT NULL,
  last_synced_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
  record_id TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (record_id, date)
);
CREATE TABLE IF NOT EXISTS transcripts (
  record_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  first_date TEXT NOT NULL,
  PRIMARY KEY (record_id, chat_id)
);
CREATE TABLE IF NOT EXISTS transcript_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  tg_message_id INTEGER,
  date INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tmsg_dedup
  ON transcript_messages(record_id, chat_id, tg_message_id)
  WHERE tg_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tmsg_order
  ON transcript_messages(record_id, chat_id, id);
CREATE TABLE IF NOT EXISTS runs (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  counts TEXT,
  error TEXT
);
`;

interface Migration {
  version: number;
  up(driver: SqliteDriver): void;
}

// Ordered list of schema migrations. To change the schema later, append a new
// entry with the next version number; never edit a released migration in place.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (driver) => driver.exec(SCHEMA_V1),
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getMeta(driver: SqliteDriver, key: string): string | undefined {
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(driver: SqliteDriver, key: string, value: string): void {
  driver
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

function runMigrations(driver: SqliteDriver): void {
  // meta must exist before we can read the current version.
  driver.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const current = Number.parseInt(getMeta(driver, "schema_version") || "0", 10) || 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    driver.transaction(() => {
      migration.up(driver);
      setMeta(driver, "schema_version", String(migration.version));
    });
  }
}

// ---------------------------------------------------------------------------
// One-time legacy JSON import
// ---------------------------------------------------------------------------

// Shape of the pre-SQLite sync-state.json.
interface LegacyState {
  chats?: Record<string, { lastMessageId: number; lastSyncedDate: string }>;
  interactions?: Record<string, { days?: Array<{ date: string; count: number }> }>;
  transcripts?: Record<
    string,
    {
      title: string;
      firstDate: string;
      messages?: Array<{ date: number; sender: string; text: string }>;
    }
  >;
  runs?: Record<string, RunState>;
}

function legacyJsonPath(dataDir: string): string {
  return path.join(dataDir, "sync-state.json");
}

function importLegacyJson(driver: SqliteDriver, dataDir: string): void {
  if (getMeta(driver, "json_migrated") === "1") return;

  const jsonPath = legacyJsonPath(dataDir);
  if (!fs.existsSync(jsonPath)) {
    setMeta(driver, "json_migrated", "1");
    return;
  }

  let legacy: LegacyState;
  try {
    legacy = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as LegacyState;
  } catch (err) {
    throw new Error(`Failed to parse legacy ${jsonPath}: ${(err as Error).message}`);
  }

  driver.transaction(() => {
    const chatStmt = driver.prepare(
      `INSERT INTO chats (chat_id, last_message_id, last_synced_date) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         last_message_id = MAX(last_message_id, excluded.last_message_id),
         last_synced_date = excluded.last_synced_date`,
    );
    for (const [chatId, chat] of Object.entries(legacy.chats || {})) {
      chatStmt.run(chatId, chat.lastMessageId, chat.lastSyncedDate);
    }

    const interactionStmt = driver.prepare(
      `INSERT INTO interactions (record_id, date, count) VALUES (?, ?, ?)
       ON CONFLICT(record_id, date) DO UPDATE SET count = MAX(count, excluded.count)`,
    );
    for (const [recordId, person] of Object.entries(legacy.interactions || {})) {
      for (const day of person.days || []) {
        interactionStmt.run(recordId, day.date, day.count);
      }
    }

    const transcriptStmt = driver.prepare(
      "INSERT OR IGNORE INTO transcripts (record_id, chat_id, title, first_date) VALUES (?, ?, ?, ?)",
    );
    const messageStmt = driver.prepare(
      `INSERT INTO transcript_messages (record_id, chat_id, tg_message_id, date, sender, text)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    );
    for (const [key, transcript] of Object.entries(legacy.transcripts || {})) {
      const sep = key.lastIndexOf(":");
      if (sep === -1) continue;
      const recordId = key.slice(0, sep);
      const chatId = key.slice(sep + 1);
      transcriptStmt.run(recordId, chatId, transcript.title, transcript.firstDate);
      for (const msg of transcript.messages || []) {
        messageStmt.run(recordId, chatId, msg.date, msg.sender, msg.text);
      }
    }

    const runStmt = driver.prepare(
      `INSERT INTO runs (name, status, finished_at, counts, error) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         status = excluded.status, finished_at = excluded.finished_at,
         counts = excluded.counts, error = excluded.error`,
    );
    for (const [name, run] of Object.entries(legacy.runs || {})) {
      runStmt.run(
        name,
        run.status,
        run.finishedAt,
        run.counts ? JSON.stringify(run.counts) : null,
        run.error ?? null,
      );
    }
  });

  // Back up the imported file rather than deleting it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${jsonPath}.imported-${stamp}`;
  try {
    fs.renameSync(jsonPath, backupPath);
  } catch (err) {
    console.warn(`[state] Imported legacy state but failed to rename ${jsonPath}:`, err);
  }

  setMeta(driver, "json_migrated", "1");
  setMeta(driver, "json_migrated_at", new Date().toISOString());
  console.log(
    `[state] Imported legacy ${jsonPath} into SQLite (backup: ${path.basename(backupPath)})`,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function dbPathFor(dataDir: string): string {
  return path.join(dataDir, "sync-state.db");
}

function dateOfUnix(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().slice(0, 10);
}

export class StateStore {
  private readonly driver: SqliteDriver;
  readonly dataDir: string;

  constructor(driver: SqliteDriver, dataDir: string) {
    this.driver = driver;
    this.dataDir = dataDir;
  }

  // --- chat sync state ---

  getChatState(chatId: string): ChatSyncState {
    const row = this.driver
      .prepare("SELECT last_message_id, last_synced_date FROM chats WHERE chat_id = ?")
      .get(chatId) as { last_message_id: number; last_synced_date: string } | undefined;
    if (!row) return { lastMessageId: 0, lastSyncedDate: "1970-01-01" };
    return { lastMessageId: row.last_message_id, lastSyncedDate: row.last_synced_date };
  }

  setChatState(chatId: string, update: ChatSyncState): void {
    this.driver
      .prepare(
        `INSERT INTO chats (chat_id, last_message_id, last_synced_date) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           last_message_id = excluded.last_message_id,
           last_synced_date = excluded.last_synced_date`,
      )
      .run(chatId, update.lastMessageId, update.lastSyncedDate);
  }

  getAllChatStates(): ChatStateRecord[] {
    const rows = this.driver
      .prepare("SELECT chat_id, last_message_id, last_synced_date FROM chats")
      .all() as Array<{ chat_id: string; last_message_id: number; last_synced_date: string }>;
    return rows.map((row) => ({
      chatId: row.chat_id,
      lastMessageId: row.last_message_id,
      lastSyncedDate: row.last_synced_date,
    }));
  }

  // --- interactions ---

  /**
   * Record message interactions for a person on a given day. Idempotent: takes the
   * max of any existing count, matching the prior in-memory behavior.
   */
  addInteractions(recordId: string, date: string, count: number): void {
    this.driver
      .prepare(
        `INSERT INTO interactions (record_id, date, count) VALUES (?, ?, ?)
         ON CONFLICT(record_id, date) DO UPDATE SET count = MAX(count, excluded.count)`,
      )
      .run(recordId, date, count);
  }

  getInteractions(recordId: string): DayInteraction[] {
    const rows = this.driver
      .prepare("SELECT date, count FROM interactions WHERE record_id = ? ORDER BY date")
      .all(recordId) as Array<{ date: string; count: number }>;
    return rows.map((row) => ({ date: row.date, count: row.count }));
  }

  // --- transcripts ---

  /**
   * Append messages to a record's transcript for a chat. The transcript row (title +
   * first_date) is created once. Messages are deduped by Telegram message id, so
   * re-fetching after a crash never produces duplicates.
   */
  appendToTranscript(
    recordId: string,
    chatId: string,
    title: string,
    messages: StoredMessage[],
  ): void {
    this.driver.transaction(() => {
      const firstDate =
        messages.length > 0
          ? dateOfUnix(messages[0].date)
          : new Date().toISOString().slice(0, 10);
      this.driver
        .prepare(
          "INSERT OR IGNORE INTO transcripts (record_id, chat_id, title, first_date) VALUES (?, ?, ?, ?)",
        )
        .run(recordId, chatId, title, firstDate);

      const withId = this.driver.prepare(
        `INSERT OR IGNORE INTO transcript_messages
           (record_id, chat_id, tg_message_id, date, sender, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const withoutId = this.driver.prepare(
        `INSERT INTO transcript_messages
           (record_id, chat_id, tg_message_id, date, sender, text)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      );
      for (const msg of messages) {
        if (typeof msg.id === "number") {
          withId.run(recordId, chatId, msg.id, msg.date, msg.sender, msg.text);
        } else {
          withoutId.run(recordId, chatId, msg.date, msg.sender, msg.text);
        }
      }
    });
  }

  getTranscript(recordId: string, chatId: string): NoteTranscript | null {
    const head = this.driver
      .prepare("SELECT title, first_date FROM transcripts WHERE record_id = ? AND chat_id = ?")
      .get(recordId, chatId) as { title: string; first_date: string } | undefined;
    if (!head) return null;

    const rows = this.driver
      .prepare(
        `SELECT tg_message_id, date, sender, text FROM transcript_messages
         WHERE record_id = ? AND chat_id = ? ORDER BY id`,
      )
      .all(recordId, chatId) as Array<{
      tg_message_id: number | null;
      date: number;
      sender: string;
      text: string;
    }>;

    return {
      title: head.title,
      firstDate: head.first_date,
      messages: rows.map((row) => ({
        date: row.date,
        sender: row.sender,
        text: row.text,
        ...(row.tg_message_id != null ? { id: row.tg_message_id } : {}),
      })),
    };
  }

  // --- run state ---

  setRunState(name: string, run: RunState): void {
    this.driver
      .prepare(
        `INSERT INTO runs (name, status, finished_at, counts, error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           status = excluded.status, finished_at = excluded.finished_at,
           counts = excluded.counts, error = excluded.error`,
      )
      .run(
        name,
        run.status,
        run.finishedAt,
        run.counts ? JSON.stringify(run.counts) : null,
        run.error ?? null,
      );
  }

  getAllRuns(): Record<string, RunState> {
    const rows = this.driver
      .prepare("SELECT name, status, finished_at, counts, error FROM runs")
      .all() as Array<{
      name: string;
      status: RunState["status"];
      finished_at: string;
      counts: string | null;
      error: string | null;
    }>;

    const result: Record<string, RunState> = {};
    for (const row of rows) {
      result[row.name] = {
        status: row.status,
        finishedAt: row.finished_at,
        counts: row.counts ? (JSON.parse(row.counts) as Record<string, number>) : undefined,
        error: row.error ?? undefined,
      };
    }
    return result;
  }

  // --- diagnostics ---

  getMigrationInfo(): MigrationInfo {
    const schemaVersion =
      Number.parseInt(getMeta(this.driver, "schema_version") || "0", 10) || 0;
    const jsonMigrated = getMeta(this.driver, "json_migrated") === "1";
    const jsonMigratedAt = getMeta(this.driver, "json_migrated_at");

    let legacyJsonReappeared = false;
    const jsonPath = legacyJsonPath(this.dataDir);
    if (jsonMigrated && jsonMigratedAt && fs.existsSync(jsonPath)) {
      try {
        const mtime = fs.statSync(jsonPath).mtime.toISOString();
        legacyJsonReappeared = mtime > jsonMigratedAt;
      } catch {
        // ignore
      }
    }

    return {
      dbPath: dbPathFor(this.dataDir),
      schemaVersion,
      jsonMigrated,
      jsonMigratedAt,
      legacyJsonReappeared,
    };
  }

  close(): void {
    this.driver.close();
  }
}

/**
 * Open (creating if needed) the SQLite-backed sync state at <dataDir>/sync-state.db,
 * run schema migrations, and perform the one-time import of any legacy sync-state.json.
 */
export function openState(dataDir: string): StateStore {
  fs.mkdirSync(dataDir, { recursive: true });
  const driver = openDriver(dbPathFor(dataDir));
  runMigrations(driver);
  importLegacyJson(driver, dataDir);
  return new StateStore(driver, dataDir);
}

export { LATEST_SCHEMA_VERSION };
