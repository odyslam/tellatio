import assert from "node:assert/strict";
import { Api } from "telegram";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const runtime = require("../src/cli/runtime");
const commands = require("../src/cli/commands");
const attio = require("../src/attio");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tellatio-association-security-"));
const oldDir = process.env.DATA_DIR;
const oldWrites = process.env.TELLATIO_ALLOW_WRITES;
const oldOwn = process.env.TELLATIO_OWN_COMPANY_NAMES;
let stored: any[] = [];
let existing: any = null;
(async () => {
  process.env.DATA_DIR = root;
  process.env.TELLATIO_ALLOW_WRITES = "1";
  process.env.TELLATIO_OWN_COMPANY_NAMES = "Phylax";
  const entity = new Api.Chat({ id: BigInt(123) as any, title: "Phylax <> Victim Company", photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 1, version: 1 });
  runtime.client = { getDialogs: async () => [{ entity, id: BigInt(-123), name: entity.title, message: { date: Math.floor(Date.now() / 1000), message: "security integration" } }] };
  attio.listApprovedTelegramAssociations = async () => [];
  attio.findTelegramAssociation = async () => existing;
  attio.resolveCompanyByName = async () => ({ status: "resolved", record: { recordId: "victim-company", name: "Victim Company" }, candidates: [], reason: "exact title name" });
  attio.upsertTelegramAssociation = async (_obj: string, association: any) => { stored.push(association); return "mapping"; };
  const flags = { "include-profile-descriptions": "false", "include-identity-evidence": "false" };
  await commands.cmdAssociationsReconcile(flags);
  assert.equal(stored.length, 1); assert.equal(stored[0].status, "needs_review");
  assert.equal(stored[0].targetRecordId, "victim-company");
  assert.match(stored[0].reason, /explicit destination approval/);
  stored = [];
  for (const status of ["ignored", "approved"]) {
    existing = { status, targetRecordId: "reviewed-target" };
    await commands.cmdAssociationsReconcile(flags);
    assert.equal(stored.length, 0);
  }
  // The explicit approval command remains available behind the write guard.
  existing = null;
  await commands.cmdAssociationsUpsert({ "chat-id": "123", title: entity.title, type: "group", "target-object": "companies", "target-record-id": "reviewed-target", status: "approved" });
  assert.equal(stored.length, 1); assert.equal(stored[0].status, "approved");
  console.log("association-security-smoke: PASS (spoofed title never approves destination, ignored/approved preservation, explicit guarded approval retained)");
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of [["DATA_DIR", oldDir], ["TELLATIO_ALLOW_WRITES", oldWrites], ["TELLATIO_OWN_COMPANY_NAMES", oldOwn]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
