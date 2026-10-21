import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../src/sync";
import { openState } from "../src/state";
import type { Config } from "../src/config";
// Test doubles are confined to this process. No credentials/network are used.
const telegram = require("../src/telegram");
const attio = require("../src/attio");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tellatio-sync-security-"));
const config = { dataDir: root, syncSource: "associations", associationObjectSlug: "associations", banFolderName: "Banned", discoveryDialogLimit: 10, chatFetchTimeoutSeconds: 1 } as Config;
const yesterday = Math.floor(Date.now() / 1000) - 86400;
const association = { telegramChatId: "123", telegramChatTitle: "fixture", telegramChatType: "dm", targetObject: "companies", targetRecordId: "fixture-record", status: "approved", syncMode: "transcript" };
telegram.getBanFolderUsers = async () => [];
telegram.getMe = async () => ({ idStr: "999", firstName: "Owner" });
telegram.getRecentChats = async () => [{ peer: {}, chatInfo: { idStr: "123", title: "fixture", type: "dm", isGroup: false } }];
telegram.getMessages = async (_peer: unknown, minId: number) => minId < 1 ? [{ id: 1, date: yesterday, senderIdStr: "123", senderName: "Sender", text: "hello" }] : [];
attio.listApprovedTelegramAssociations = async () => [association];
let fail = true;
let writes = 0;
attio.upsertNote = async () => { writes++; if (fail) throw new Error("simulated remote failure"); return "note"; };

(async () => {
  await assert.rejects(runSync(config), /write.*failed/);
  let store = openState(root);
  assert.equal(store.getChatState("123").lastMessageId, 0);
  assert.equal(store.getAllRuns().sync.status, "failed");
  assert.equal(store.getTranscript("fixture-record", "123")?.messages.length, 1);
  store.close();
  fail = false;
  await runSync(config);
  store = openState(root);
  assert.equal(store.getChatState("123").lastMessageId, 1);
  assert.equal(store.getAllRuns().sync.status, "success");
  assert.equal(store.getTranscript("fixture-record", "123")?.messages.length, 1);
  assert.equal(fs.statSync(path.join(root, "sync-state.db")).mode & 0o777, 0o600);
  store.close();
  const before = writes;
  await runSync(config);
  assert.equal(writes, before);
  telegram.getMessages = async () => { throw new Error("simulated timeout"); };
  await assert.rejects(runSync(config), /fetch.*failed/);
  store = openState(root);
  assert.equal(store.getAllRuns().sync.status, "failed");
  store.close();
  const oneChat = { peer: {}, chatInfo: { idStr: "123", title: "fixture", type: "dm", isGroup: false } };
  telegram.getMessages = async () => [{ id: 2, date: yesterday, senderIdStr: "123", senderName: "Sender", text: "pending review" }];
  const beforeBoundary = writes;
  telegram.getRecentChats = async () => [{ ...oneChat, chatInfo: { ...oneChat.chatInfo, type: "group", isGroup: true } }];
  await runSync(config); // mismatch is quarantined, not process-fatal
  store = openState(root); assert.equal(store.getChatState("123").lastMessageId, 1); store.close();
  telegram.getRecentChats = async () => [oneChat, { ...oneChat, chatInfo: { ...oneChat.chatInfo, type: "group", isGroup: true } }];
  await runSync(config); // ambiguous legacy namespace also quarantined
  telegram.getRecentChats = async () => [oneChat];
  attio.listApprovedTelegramAssociations = async () => [{ ...association, telegramChatType: "unknown" }];
  await runSync(config); // unknown legacy type is quarantined
  assert.equal(writes, beforeBoundary);
  store = openState(root); assert.equal(store.getChatState("123").lastMessageId, 1); store.close();

  // Legacy folder mode must not consume messages awaiting identity approval.
  telegram.getFolderChatIds = async () => [{}];
  telegram.resolveChat = async () => oneChat.chatInfo;
  telegram.getUserInfo = async () => ({ userIdStr: "123", firstName: "Unverified" });
  attio.resolveOrCreatePerson = async () => null;
  const folderConfig = { ...config, syncSource: "folder", folderName: "Attio" } as Config;
  await assert.rejects(runSync(folderConfig), /identity requires review/);
  telegram.resolveChat = async () => ({ ...oneChat.chatInfo, type: "group", isGroup: true });
  telegram.getGroupParticipants = async () => [{ userIdStr: "123", firstName: "Unverified" }];
  await assert.rejects(runSync(folderConfig), /participant Telegram identity requires review/);
  assert.equal(writes, beforeBoundary);
  store = openState(root); assert.equal(store.getChatState("123").lastMessageId, 1); store.close();

  attio.listApprovedTelegramAssociations = async () => { throw new Error("simulated selection failure"); };
  await assert.rejects(runSync(config), /selection failure/);
  const linkDir = path.join(root, "link-state"); fs.mkdirSync(linkDir);
  fs.symlinkSync(path.join(root, "missing"), path.join(linkDir, "sync-state.db-wal"));
  assert.throws(() => openState(linkDir), /Unsafe/);
  console.log("sync-security-smoke: PASS (write failure retains cursor, retry dedupes, failed reads are not success, private state, symlink refusal, peer-type quarantine, identity-review cursor retention)");
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
