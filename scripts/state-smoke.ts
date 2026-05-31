/**
 * Runtime-agnostic verification for the SQLite state store and the one-time
 * legacy-JSON migration. Exercises the real code path with no Telegram/Attio access.
 *
 * Run under Node (better-sqlite3):  npx ts-node scripts/state-smoke.ts
 * Run under Bun  (bun:sqlite):      bun scripts/state-smoke.ts
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openState } from "../src/state";

const runtime =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun (bun:sqlite)" : "node (better-sqlite3)";

let tmpRoot = "";
function freshDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tellatio-smoke-${label}-`));
  if (!tmpRoot) tmpRoot = path.dirname(dir);
  return dir;
}

function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
}

console.log(`\n[state-smoke] runtime: ${runtime}`);

// --- 1. fresh dir, no legacy json ---
test("fresh dir initializes schema v1 and marks json migrated", () => {
  const dir = freshDir("fresh");
  const store = openState(dir);
  const info = store.getMigrationInfo();
  assert.equal(info.schemaVersion, 1, "schema version should be 1");
  assert.equal(info.jsonMigrated, true, "json_migrated flag should be set");
  assert.equal(store.getAllChatStates().length, 0);
  store.close();
  assert.ok(fs.existsSync(path.join(dir, "sync-state.db")), "db file should exist");
});

// --- 2. legacy JSON migration ---
const fixture = {
  chats: {
    "111": { lastMessageId: 42, lastSyncedDate: "2026-05-01" },
    "222": { lastMessageId: 7, lastSyncedDate: "2026-05-02" },
  },
  interactions: {
    "rec-A": { days: [{ date: "2026-05-01", count: 3 }, { date: "2026-05-02", count: 5 }] },
  },
  transcripts: {
    "rec-A:111": {
      title: "Telegram · Alice",
      firstDate: "2026-05-01",
      messages: [
        { date: 1746090000, sender: "Alice", text: "hello" },
        { date: 1746093600, sender: "Me", text: "hi back" },
      ],
    },
  },
  runs: {
    sync: { status: "success", finishedAt: "2026-05-02T10:00:00.000Z", counts: { selectedChats: 2 } },
  },
};

test("imports legacy sync-state.json and backs it up", () => {
  const dir = freshDir("migrate");
  const jsonPath = path.join(dir, "sync-state.json");
  fs.writeFileSync(jsonPath, JSON.stringify(fixture), "utf-8");

  const store = openState(dir);

  assert.deepEqual(store.getChatState("111"), { lastMessageId: 42, lastSyncedDate: "2026-05-01" });
  assert.deepEqual(store.getChatState("222"), { lastMessageId: 7, lastSyncedDate: "2026-05-02" });
  assert.equal(store.getAllChatStates().length, 2);

  assert.deepEqual(store.getInteractions("rec-A"), [
    { date: "2026-05-01", count: 3 },
    { date: "2026-05-02", count: 5 },
  ]);

  const t = store.getTranscript("rec-A", "111");
  assert.ok(t, "transcript should exist");
  assert.equal(t.title, "Telegram · Alice");
  assert.equal(t.firstDate, "2026-05-01");
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].text, "hello"); // insertion order preserved
  assert.equal(t.messages[1].text, "hi back");

  const runs = store.getAllRuns();
  assert.equal(runs.sync.status, "success");
  assert.deepEqual(runs.sync.counts, { selectedChats: 2 });

  const info = store.getMigrationInfo();
  assert.equal(info.jsonMigrated, true);
  assert.equal(info.legacyJsonReappeared, false);

  store.close();

  assert.ok(!fs.existsSync(jsonPath), "original json should be renamed away");
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith("sync-state.json.imported-"));
  assert.equal(backups.length, 1, "exactly one backup should exist");
});

test("migration is idempotent on reopen (no double import)", () => {
  const dir = freshDir("idem-migrate");
  fs.writeFileSync(path.join(dir, "sync-state.json"), JSON.stringify(fixture), "utf-8");

  const a = openState(dir);
  const countA = a.getTranscript("rec-A", "111")!.messages.length;
  a.close();

  const b = openState(dir); // reopen: must not re-import
  const countB = b.getTranscript("rec-A", "111")!.messages.length;
  b.close();

  assert.equal(countA, 2);
  assert.equal(countB, 2, "reopen must not duplicate transcript rows");
});

// --- 3. idempotent append by Telegram message id ---
test("appendToTranscript dedupes by Telegram message id", () => {
  const dir = freshDir("dedup");
  const store = openState(dir);
  const msgs = [
    { id: 1001, date: 1746090000, sender: "Bob", text: "one" },
    { id: 1002, date: 1746093600, sender: "Bob", text: "two" },
  ];
  store.appendToTranscript("rec-B", "333", "Telegram · Bob", msgs);
  store.appendToTranscript("rec-B", "333", "Telegram · Bob", msgs); // replay
  const t = store.getTranscript("rec-B", "333")!;
  assert.equal(t.messages.length, 2, "replayed messages must not duplicate");

  // a new message with a fresh id still appends
  store.appendToTranscript("rec-B", "333", "Telegram · Bob", [
    { id: 1003, date: 1746097200, sender: "Bob", text: "three" },
  ]);
  assert.equal(store.getTranscript("rec-B", "333")!.messages.length, 3);
  store.close();
});

// --- 4. interactions take the max ---
test("addInteractions keeps the max count per day", () => {
  const dir = freshDir("interactions");
  const store = openState(dir);
  store.addInteractions("rec-C", "2026-05-10", 3);
  store.addInteractions("rec-C", "2026-05-10", 1); // lower, ignored
  store.addInteractions("rec-C", "2026-05-10", 5); // higher, wins
  store.addInteractions("rec-C", "2026-05-11", 2);
  assert.deepEqual(store.getInteractions("rec-C"), [
    { date: "2026-05-10", count: 5 },
    { date: "2026-05-11", count: 2 },
  ]);
  store.close();
});

// --- 5. run state round-trip ---
test("setRunState / getAllRuns round-trip with counts and error", () => {
  const dir = freshDir("runs");
  const store = openState(dir);
  store.setRunState("sync", { status: "success", finishedAt: "2026-05-30T00:00:00.000Z", counts: { a: 1, b: 2 } });
  store.setRunState("discover", { status: "failed", finishedAt: "2026-05-30T01:00:00.000Z", error: "boom" });
  const runs = store.getAllRuns();
  assert.deepEqual(runs.sync.counts, { a: 1, b: 2 });
  assert.equal(runs.sync.error, undefined);
  assert.equal(runs.discover.status, "failed");
  assert.equal(runs.discover.error, "boom");
  store.close();
});

console.log(`[state-smoke] all checks passed under ${runtime}\n`);

// best-effort cleanup
try {
  for (const entry of fs.readdirSync(tmpRoot)) {
    if (entry.startsWith("tellatio-smoke-")) {
      fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
    }
  }
} catch {
  // ignore
}
