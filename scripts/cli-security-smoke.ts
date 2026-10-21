import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const runtime = require("../src/cli/runtime");
const commands = require("../src/cli/commands");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tellatio-cli-security-"));
let networkCalls = 0;
let sent = false;
(async () => {
  process.env.DATA_DIR = root;
  delete process.env.TELLATIO_WRITE_GUARD;
  delete process.env.TELLATIO_ALLOW_WRITES;
  runtime.resolveEntity = async () => { networkCalls++; return {}; };
  runtime.client = {
    getMessages: async () => [{ media: {} }],
    downloadMedia: async (_msg: unknown, options: any) => {
      options.outputFile.write(Buffer.from("safe download"));
      options.outputFile.close();
    },
    sendFile: async (_entity: unknown, options: any) => {
      assert.equal(options.file.path, "");
      assert.equal(options.file.buffer.toString(), "shareable fixture");
      sent = true;
      return { id: 1, date: 1, message: "fixture" };
    },
  };
  await assert.rejects(commands.cmdMediaDownload(["fixture", "1", "ok.txt"]), /Refusing/);
  await assert.rejects(commands.cmdMediaSend(["fixture", "ok.txt"], {}), /Refusing/);
  for (const name of ["cmdFoldersSyncAttio", "cmdAssociationsUpsert", "cmdAssociationsReconcile", "cmdIdentitiesUpsert", "cmdIdentitiesReconcile"]) {
    await assert.rejects(commands[name]({}), /Refusing/);
  }
  assert.equal(networkCalls, 0);
  process.env.TELLATIO_ALLOW_WRITES = "1";
  await assert.rejects(commands.cmdMediaDownload(["fixture", "1", "../outside"]), /not a path/);
  await commands.cmdMediaDownload(["fixture", "1", "ok.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "downloads", "ok.txt"), "utf8"), "safe download");
  await assert.rejects(commands.cmdMediaDownload(["fixture", "1", "ok.txt"]), /EEXIST/);
  fs.mkdirSync(path.join(root, "uploads"));
  fs.writeFileSync(path.join(root, "uploads", "ok.txt"), "shareable fixture");
  await commands.cmdMediaSend(["fixture", "ok.txt"], {});
  assert.equal(sent, true);
  runtime.client.downloadMedia = async (_msg: unknown, options: any) => {
    options.outputFile.write(Buffer.from("partial")); throw new Error("download failed");
  };
  await assert.rejects(commands.cmdMediaDownload(["fixture", "1", "partial.txt"]), /download failed/);
  assert.equal(fs.existsSync(path.join(root, "downloads", "partial.txt")), false);
  console.log("cli-security-smoke: PASS (guarded media/CRM, confined transfers, no overwrite, cleanup, buffered upload)");
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
