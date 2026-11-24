/** Offline folder-management regression tests. No credentials or live writes. */
import assert from "node:assert/strict";
import { Api, TelegramClient } from "telegram";

const runtime = require("../../src/cli/runtime");
const implementations: typeof import("../../src/cli/commands") = require("../../src/cli/commands");
const commands = new Proxy(implementations, {
  get: (target, key: keyof typeof implementations) => async (...args: unknown[]) => {
    output = await runtime.runLocal(() => (target[key] as Function)(...args));
  },
});
const peer = (id: number) => new Api.InputPeerUser({ userId: BigInt(id) as any, accessHash: BigInt(999) as any });
const keys = (peers: Api.TypeInputPeer[]) => peers.map(runtime.inputPeerKey);
const folder = (id: number, name: string, overrides = {}) => new Api.DialogFilter({
  id, title: runtime.folderTitle(name), pinnedPeers: [], includePeers: [peer(1)], excludePeers: [], ...overrides,
});
let filters: Api.TypeDialogFilter[] = [];
let requests: any[] = [];
let output: any;
let resolutions = 0;
const savedEnv = { ...process.env };

const savedMethods = {
  connect: TelegramClient.prototype.connect,
  disconnect: TelegramClient.prototype.disconnect,
  getEntity: TelegramClient.prototype.getEntity,
  getInputEntity: TelegramClient.prototype.getInputEntity,
  getDialogs: TelegramClient.prototype.getDialogs,
  invoke: TelegramClient.prototype.invoke,
};
TelegramClient.prototype.connect = async () => true;
TelegramClient.prototype.disconnect = async () => {};
TelegramClient.prototype.getDialogs = async () => [] as any;
TelegramClient.prototype.getEntity = (async (identifier: any) => {
  resolutions++;
  if (String(identifier).includes("missing")) throw new Error("Unknown chat");
  const id = identifier instanceof Api.InputPeerUser ? Number(identifier.userId) : identifier === "@alice" ? 1 : Number(identifier);
  return new Api.User({ id: BigInt(id) as any, firstName: `User ${id}` });
}) as typeof TelegramClient.prototype.getEntity;
TelegramClient.prototype.getInputEntity = async (entity: any) => peer(Number(entity.id));
TelegramClient.prototype.invoke = (async (request: any) => {
  requests.push(request);
  if (request instanceof Api.messages.GetDialogFilters) return { filters };
  if (request instanceof Api.messages.UpdateDialogFilter) {
    filters = filters.filter((item) => !("id" in item) || item.id !== request.id);
    if (request.filter) filters.push(request.filter);
    return true;
  }
  if (request instanceof Api.messages.UpdateDialogFiltersOrder) return true;
  throw new Error(`Unexpected RPC: ${request.className}`);
}) as typeof TelegramClient.prototype.invoke;

function reset(next: Api.TypeDialogFilter[]): void {
  filters = next;
  requests = [];
  resolutions = 0;
  output = undefined;
}
function writes(): any[] {
  return requests.filter((request) => !(request instanceof Api.messages.GetDialogFilters));
}
function current(id = 2): Api.DialogFilter {
  return filters.find((item) => item instanceof Api.DialogFilter && item.id === id) as Api.DialogFilter;
}

async function main(): Promise<void> {
  process.env.TELLATIO_WRITE_GUARD = "enforce";
  process.env.TELLATIO_ALLOW_WRITES = "0";
  process.env.TELLATIO_BAN_FOLDER_NAME = "Banned";
  process.env.TELEGRAM_API_ID = "1";
  process.env.TELEGRAM_API_HASH = "offline-fixture";
  // Synthetic session with a loopback DC and no auth key; connect/invoke are stubbed above.
  process.env.TELEGRAM_SESSION = "1AQAJMTI3LjAuMC4xAbs=";
  for (const key of ["TELEGRAM_API_ID_FILE", "TELEGRAM_API_HASH_FILE", "TELEGRAM_SESSION_FILE"]) delete process.env[key];
  await runtime.connect();

  // Every mutation fails before making any Telegram call, even if called without the registry.
  const mutations = [
    () => commands.cmdFoldersCreate(["New"], { groups: "true" }),
    () => commands.cmdFoldersUpdate(["Work"], { name: "New" }),
    () => commands.cmdFoldersRename(["Work", "New"]),
    () => commands.cmdFoldersDelete(["Work"]),
    () => commands.cmdFoldersAdd(["Work", "2"]),
    () => commands.cmdFoldersRemove(["Work", "1"]),
    () => commands.cmdFoldersPin(["Work", "2"]),
    () => commands.cmdFoldersUnpin(["Work", "1"]),
    () => commands.cmdFoldersExcludeAdd(["Work", "2"]),
    () => commands.cmdFoldersExcludeRemove(["Work", "2"]),
    () => commands.cmdFoldersSources(["Work"], { groups: "true" }),
    () => commands.cmdFoldersReorder(["Work"], {}),
  ];
  for (const mutate of mutations) await assert.rejects(mutate, /Refusing/);
  assert.equal(requests.length, 0);
  assert.equal(resolutions, 0);

  // All previews work with writes disabled and leave input objects untouched.
  const previews = [
    () => commands.cmdFoldersCreate(["New"], { groups: "true", dryRun: "true" }),
    () => commands.cmdFoldersUpdate(["#2"], { name: "New", dryRun: "true" }),
    () => commands.cmdFoldersRename(["#2", "New", "dry-run"]),
    () => commands.cmdFoldersDelete(["#2", "dry-run"]),
    () => commands.cmdFoldersAdd(["#2", "2,2", "dry-run"]),
    () => commands.cmdFoldersRemove(["#2", "1,1", "dry-run"]),
    () => commands.cmdFoldersPin(["#2", "2", "dry-run"]),
    () => commands.cmdFoldersUnpin(["#2", "1", "dry-run"]),
    () => commands.cmdFoldersExcludeAdd(["#2", "1", "dry-run"]),
    () => commands.cmdFoldersExcludeRemove(["#2", "2", "dry-run"]),
    () => commands.cmdFoldersSources(["#2"], { groups: "false", dryRun: "true" }),
    () => commands.cmdFoldersReorder(["#2"], { dryRun: "true" }),
  ];
  for (const preview of previews) {
    const original = folder(2, "Work", { groups: true, pinnedPeers: [peer(1)], excludePeers: [peer(2)] });
    reset([original]);
    await preview();
    assert.equal(output.dryRun, true);
    assert.equal(writes().length, 0);
    assert.equal(filters[0], original);
    assert.equal(original.title.text, "Work");
    assert.equal(original.groups, true);
    assert.deepEqual(keys(original.includePeers), ["user:1"]);
    assert.deepEqual(keys(original.pinnedPeers), ["user:1"]);
    assert.deepEqual(keys(original.excludePeers), ["user:2"]);
  }

  const shared = new Api.DialogFilterChatlist({
    id: 7, title: runtime.folderTitle("Shared"), includePeers: [peer(8)], pinnedPeers: [],
  });
  reset([new Api.DialogFilterDefault(), folder(2, "Work"), shared]);
  await commands.cmdFoldersList();
  assert.deepEqual(output.map((item: any) => [item.id, item.shared]), [[2, false], [7, true]]);
  await commands.cmdFoldersInfo(["#7"]);
  assert.equal(output.shared, true);
  assert.deepEqual(output.includePeers, ["user:8"]);
  assert.ok(!JSON.stringify(output).includes("accessHash"));

  // Duplicate names never silently select a folder; explicit IDs disambiguate.
  reset([folder(2, "Work"), folder(3, "Work")]);
  await assert.rejects(() => commands.cmdFoldersInfo(["Work"]), /ambiguous.*#2.*#3/);
  await commands.cmdFoldersInfo(["#3"]);
  assert.equal(output.id, 3);
  await assert.rejects(() => commands.cmdFoldersInfo(["Missing"]), /not found.*Work \(#2\)/);

  process.env.TELLATIO_ALLOW_WRITES = "1";
  reset([folder(2, "Work"), shared]);
  await commands.cmdFoldersCreate(["New"], { chats: "1,@alice,2,2", color: "0", nonContacts: "true", excludeRead: "true" });
  assert.equal(output.created, true);
  assert.equal(output.folder.id, 3);
  assert.equal(output.folder.color, 0);
  assert.equal(output.folder.nonContacts, true);
  assert.equal(output.folder.excludeRead, true);
  assert.deepEqual(keys(current(3).includePeers), ["user:1", "user:2"]);
  await assert.rejects(() => commands.cmdFoldersCreate(["Shared"], { groups: "true" }), /already exists/);
  for (const name of ["", "   ", "1234567890123"]) {
    await assert.rejects(() => commands.cmdFoldersCreate([name], { groups: "true" }), /Usage|blank|12 characters/);
  }
  await assert.rejects(() => commands.cmdFoldersCreate(["Empty"], {}), /at least one chat/);
  for (const color of ["", "no", "1.5", "7", "-2", "1junk"]) {
    await assert.rejects(() => commands.cmdFoldersCreate(["Invalid"], { groups: "true", color }), /color must/);
  }

  // Updating a few settings preserves all other flags, title entities and peer arrays.
  const original = folder(2, "Work", {
    groups: true, nonContacts: true, excludeArchived: true, titleNoanimate: true,
    emoticon: "💼", color: 4, pinnedPeers: [peer(1)], excludePeers: [peer(3)],
  });
  reset([original, shared]);
  await commands.cmdFoldersUpdate(["#2"], { groups: "false", excludeRead: "true", color: "0" });
  assert.equal(current().groups, false);
  assert.equal(current().excludeRead, true);
  assert.equal(current().excludeArchived, true);
  assert.equal(current().nonContacts, true);
  assert.equal(current().titleNoanimate, true);
  assert.equal(current().emoticon, "💼");
  assert.equal(current().color, 0);
  assert.equal(current().title, original.title);
  assert.equal(current().includePeers, original.includePeers);
  assert.equal(current().pinnedPeers, original.pinnedPeers);
  assert.equal(current().excludePeers, original.excludePeers);
  await commands.cmdFoldersUpdate(["#2"], { name: "Active", clearEmoticon: "true", clearColor: "true" });
  assert.equal(current().title.text, "Active");
  assert.equal(current().emoticon, undefined);
  assert.equal(current().color, undefined);
  await commands.cmdFoldersUpdate(["Active"], { emoticon: "⭐", color: "-1", "non-contacts": "false" });
  assert.equal(current().emoticon, "⭐");
  assert.equal(current().color, -1);
  assert.equal(current().nonContacts, false);
  const invalidUpdates: Record<string, string>[] = [{}, { color: "2", clearColor: "true" }, { emoticon: "⭐", clearEmoticon: "true" }, { groups: "maybe" }];
  for (const options of invalidUpdates) {
    await assert.rejects(() => commands.cmdFoldersUpdate(["#2"], options));
  }
  await assert.rejects(() => commands.cmdFoldersUpdate(["#2"], { name: "Shared" }), /already exists/);
  await assert.rejects(() => commands.cmdFoldersRename(["#2", "Shared"]), /already exists/);
  await commands.cmdFoldersRename(["#2", "Renamed"]);
  assert.equal(current().title.text, "Renamed");

  // Add/remove/pin reconcile explicit exclusions and are idempotent across aliases.
  reset([folder(2, "Work", { groups: true, pinnedPeers: [peer(1)], excludePeers: [peer(2)] })]);
  await commands.cmdFoldersAdd(["#2", "2,2"]);
  assert.deepEqual(keys(current().includePeers), ["user:1", "user:2"]);
  assert.deepEqual(keys(current().excludePeers), []);
  assert.deepEqual(output.removedExclusions, ["user:2"]);
  let count = writes().length;
  await commands.cmdFoldersAdd(["Work", "2"]);
  assert.equal(writes().length, count);
  await commands.cmdFoldersRemove(["#2", "1,@alice,3,3"]);
  assert.deepEqual(keys(current().includePeers), ["user:2"]);
  assert.deepEqual(keys(current().pinnedPeers), []);
  assert.deepEqual(keys(current().excludePeers), ["user:1", "user:3"]);
  assert.equal(output.removed.length, 1);
  assert.equal(output.excluded.length, 2);
  count = writes().length;
  await commands.cmdFoldersRemove(["Work", "1,3"]);
  assert.equal(writes().length, count);
  await commands.cmdFoldersPin(["#2", "3,3"]);
  assert.deepEqual(keys(current().includePeers), ["user:2", "user:3"]);
  assert.deepEqual(keys(current().pinnedPeers), ["user:3"]);
  assert.deepEqual(keys(current().excludePeers), ["user:1"]);
  count = writes().length;
  await commands.cmdFoldersPin(["#2", "3"]);
  assert.equal(writes().length, count);
  await commands.cmdFoldersUnpin(["#2", "3"]);
  assert.deepEqual(keys(current().pinnedPeers), []);
  assert.deepEqual(keys(current().includePeers), ["user:2", "user:3"]);
  await commands.cmdFoldersExcludeAdd(["#2", "3"]);
  assert.deepEqual(keys(current().includePeers), ["user:2"]);
  assert.deepEqual(keys(current().excludePeers), ["user:1", "user:3"]);
  await commands.cmdFoldersExcludeRemove(["#2", "3"]);
  assert.deepEqual(keys(current().excludePeers), ["user:1"]);
  count = writes().length;
  await assert.rejects(() => commands.cmdFoldersAdd(["Work", "4,missing"]), /Cannot resolve/);
  assert.equal(writes().length, count, "resolve the whole batch before writing");

  reset([folder(2, "Manual", { includePeers: [peer(1), peer(2)], pinnedPeers: [peer(2)] })]);
  await commands.cmdFoldersRemove(["Manual", "2,3"]);
  assert.deepEqual(keys(current().includePeers), ["user:1"]);
  assert.deepEqual(keys(current().pinnedPeers), []);
  assert.deepEqual(keys(current().excludePeers), []);
  assert.equal(output.notPresent.length, 1);
  await assert.rejects(() => commands.cmdFoldersRemove(["Manual", "1"]), /leave the folder/);
  reset([folder(2, "Pinned", { includePeers: [], pinnedPeers: [peer(1), peer(2)] })]);
  await commands.cmdFoldersRemove(["Pinned", "1"]);
  assert.deepEqual(keys(current().pinnedPeers), ["user:2"]);
  await commands.cmdFoldersUnpin(["Pinned", "2"]);
  assert.deepEqual(keys(current().includePeers), ["user:2"], "unpinning must not remove a pinned-only chat from the folder");
  assert.deepEqual(keys(current().pinnedPeers), []);
  reset([folder(2, "Sources", { includePeers: [], groups: true })]);
  await assert.rejects(() => commands.cmdFoldersUpdate(["Sources"], { groups: "false" }), /at least one/);
  await assert.rejects(() => commands.cmdFoldersSources(["Sources"], { groups: "false" }), /at least one/);
  assert.equal(writes().length, 0);
  await commands.cmdFoldersSources(["#2"], { "non-contacts": "true", "exclude-muted": "true" });
  assert.equal(current().nonContacts, true);
  assert.equal(current().excludeMuted, true);

  // Shared folders are inspectable/reorderable but cannot accidentally be converted or deleted.
  reset([folder(2, "Work"), shared]);
  for (const mutate of [
    () => commands.cmdFoldersUpdate(["#7"], { name: "Other" }),
    () => commands.cmdFoldersDelete(["Shared"]),
    () => commands.cmdFoldersAdd(["#7", "1"]),
  ]) await assert.rejects(mutate, /shared/);
  assert.equal(writes().length, 0);

  // ID selectors must not bypass the Banned folder protection (even in previews).
  reset([folder(2, "Work"), folder(9, "Banned")]);
  for (const mutate of [
    () => commands.cmdFoldersInfo(["#9"]),
    () => commands.cmdFoldersDelete(["#9"]),
    () => commands.cmdFoldersUpdate(["#9"], { name: "Other", dryRun: "true" }),
    () => commands.cmdFoldersAdd(["#9", "1"]),
    () => commands.cmdFoldersRemove(["#9", "1"]),
    () => commands.cmdFoldersRename(["#9", "Other"]),
    () => commands.cmdFoldersRename(["#2", "Banned"]),
    () => commands.cmdFoldersUpdate(["#2"], { name: "Banned" }),
  ]) await assert.rejects(mutate, /tellatio bans/);
  assert.equal(writes().length, 0);

  reset([folder(2, "Work"), new Api.DialogFilterDefault(), shared, folder(3, "Other")]);
  await commands.cmdFoldersReorder(["Other,#7"], { dryRun: "true" });
  assert.deepEqual(output.order, [3, 0, 7, 2]);
  assert.equal(writes().length, 0);
  await commands.cmdFoldersReorder(["#3,Shared"], {});
  assert.deepEqual(writes()[0].order, [3, 0, 7, 2]);
  await assert.rejects(() => commands.cmdFoldersReorder(["Work,#2"], {}), /Duplicate folder/);
  await assert.rejects(() => commands.cmdFoldersReorder(["Missing"], {}), /not found/);
  reset([folder(2, "Delete me"), shared]);
  await commands.cmdFoldersDelete(["#2"]);
  assert.equal(output.deleted, true);
  assert.equal(writes().length, 1);
  assert.ok(writes()[0] instanceof Api.messages.UpdateDialogFilter);
  assert.equal(writes()[0].filter, undefined);
  assert.deepEqual(filters, [shared]);

  console.log("folders-smoke: PASS (CRUD, ID selection, settings, membership, shared folders, dry runs, guards)");
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  Object.assign(TelegramClient.prototype, savedMethods);
  process.env = savedEnv;
});
