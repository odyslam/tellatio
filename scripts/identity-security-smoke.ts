import assert from "node:assert/strict";
import * as attio from "../src/attio";

const originalFetch = globalThis.fetch;
const originalBase = process.env.ATTIO_API_BASE_URL;
let identities: any[] = [];
let stable: any[] = [];
let hints: any[] = [];
let target: any = null;
let mutations: string[] = [];
let queried: string[] = [];
const person = (id: string, name = "Trusted Person") => ({ id: { record_id: id }, values: { name: [{ full_name: name }] } });
const identity = (status: string, recordId = "trusted") => ({
  id: { record_id: "mapping" }, values: {
    telegram_user_id: [{ value: "123" }], telegram_display_name: [{ value: "Profile" }],
    status: [{ value: status }], crm_record_id: [{ value: recordId }],
  },
});
function reset() { identities = []; stable = []; hints = []; target = null; mutations = []; queried = []; }
function json(data: any, status = 200) { return new Response(JSON.stringify({ data }), { status }); }

globalThis.fetch = (async (url: any, options: RequestInit) => {
  const path = new URL(String(url)).pathname;
  const body = options.body ? JSON.parse(String(options.body)) : {};
  const method = options.method || "GET";
  if (method === "POST" && path.endsWith("/records/query")) {
    queried.push(path + ":" + JSON.stringify(body.filter));
    if (path.includes("/telegram_identities/")) {
      assert.equal(body.limit, 2); return json(identities);
    }
    return json(body.filter?.telegram_user_id ? stable : hints);
  }
  if (method === "GET") return target ? json(target) : json({}, 404);
  mutations.push(method + " " + path);
  return json({ id: { record_id: "new-record" } });
}) as typeof fetch;

(async () => {
  delete process.env.ATTIO_API_BASE_URL;
  attio.initAttio("fixture-key");
  const input = { telegramUserId: "123", firstName: "Trusted", lastName: "Person", username: "recycled", phone: "+123", companyHints: ["Trusted"] };
  // Self-selected names, a recycled username/phone, or a profile company claim
  // cannot overwrite an existing person's stable Telegram ID.
  for (const field of ["name", "telegram", "phone_numbers"]) {
    reset(); hints = [person("victim")];
    const result = await attio.resolvePersonIdentity(input);
    assert.equal(result.status, "ambiguous"); assert.equal(result.record, undefined);
    assert.ok(queried.some(q => q.includes(field))); assert.equal(mutations.length, 0);
    const reconciled = await attio.reconcileTelegramIdentity("telegram_identities", input);
    assert.equal(reconciled.identity.status, "needs_review");
    assert.equal(reconciled.identity.targetRecordId, "");
    assert.ok(!mutations.some(m => m.includes("/people/")));
    mutations = [];
    assert.equal(await attio.resolveOrCreatePerson(input, { autoCreate: true }), null);
    assert.ok(!mutations.some(m => m.includes("/people/")));
  }
  reset(); stable = [person("stable-match")];
  assert.equal((await attio.resolvePersonIdentity(input)).record?.recordId, "stable-match");
  reset(); stable = [person("one"), person("two")]; hints = [person("one")];
  assert.equal((await attio.resolvePersonIdentity(input)).status, "ambiguous");
  assert.equal(await attio.findPerson(undefined, undefined, "123"), null);
  assert.equal(await attio.resolveOrCreatePerson(input, { autoCreate: true }), null);
  assert.ok(!mutations.some(m => m.includes("/people/")));

  reset(); identities = [identity("approved")]; target = person("trusted");
  assert.equal((await attio.resolvePersonIdentity(input)).record?.recordId, "trusted");
  reset(); identities = [identity("ignored")]; stable = [person("fallback")];
  const ignored = await attio.reconcileTelegramIdentity("telegram_identities", input);
  assert.equal(ignored.resolution.status, "blocked"); assert.equal(ignored.identity.status, "ignored");
  assert.equal(await attio.resolveOrCreatePerson(input, { autoCreate: true }), null);
  assert.equal(mutations.length, 0);
  await assert.rejects(attio.findOrCreatePerson(input), /review/);
  assert.equal(mutations.length, 0);
  reset(); identities = [identity("approved")]; stable = [person("fallback")];
  const broken = await attio.reconcileTelegramIdentity("telegram_identities", input);
  assert.equal(broken.resolution.status, "blocked"); assert.equal(broken.identity.status, "needs_review");
  assert.equal(await attio.resolveOrCreatePerson(input, { autoCreate: true }), null);
  assert.equal(mutations.length, 0);
  reset(); identities = [identity("approved"), identity("ignored")];
  await assert.rejects(attio.resolvePersonIdentity(input), /Duplicate/);
  reset(); identities = [identity("typo")];
  await assert.rejects(attio.resolvePersonIdentity(input), /Malformed/);
  reset(); identities = [identity("approved")]; identities[0].values.telegram_user_id = [{ value: "456" }];
  await assert.rejects(attio.resolvePersonIdentity(input), /ID mismatch/);
  reset();
  assert.equal(await attio.resolveOrCreatePerson({ firstName: "Spoofed" }, { autoCreate: true }), null);
  assert.equal(queried.length, 0); assert.equal(mutations.length, 0);
  assert.equal(await attio.findPerson("+123", "recycled"), null);
  await assert.rejects(attio.findOrCreatePerson({ username: "recycled" }), /stable/);
  await assert.rejects(attio.resolvePersonIdentity({ telegramUserId: "../victim" }), /stable/);
  reset();
  assert.equal((await attio.resolveOrCreatePerson({ telegramUserId: "123" }, { autoCreate: true }))?.status, "created");
  assert.equal(mutations.filter(m => m === "POST /v2/objects/people/records").length, 1);
  console.log("identity-security-smoke: PASS (mutable profiles never auto-link, stable ID ambiguity, ignored/missing approval preservation, no ID fallback, bounded auto-create)");
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.ATTIO_API_BASE_URL;
  else process.env.ATTIO_API_BASE_URL = originalBase;
});
