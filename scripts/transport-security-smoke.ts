import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { attioRequest, attioSegment, MAX_ATTIO_BYTES, ATTIO_TIMEOUT_MS } from "../src/attio-http";
import { serialCommands } from "../src/cli/serial";
import { runLocal, out } from "../src/cli/runtime";
import * as attio from "../src/attio";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalBase = process.env.ATTIO_API_BASE_URL;
let calls = 0;
function fakeFetch(fn: (url: string, options: RequestInit) => Response | Promise<Response>): void {
  calls = 0;
  globalThis.fetch = (async (url: any, options: RequestInit) => {
    calls++;
    assert.ok(String(url).startsWith("https://api.attio.com/v2/"));
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fixture-token");
    assert.ok(options.signal);
    return fn(String(url), options);
  }) as typeof fetch;
}

(async () => {
  delete process.env.ATTIO_API_BASE_URL;
  fakeFetch(() => new Response('{"data":[]}'));
  const res = await attioRequest("fixture-token", "/objects/people/records/query", { method: "POST", body: "{}" });
  assert.deepEqual(await res.json(), { data: [] });
  for (const origin of ["http://api.attio.com", "https://api.attio.com.evil.test", "https://evil.test", "https://api.attio.com/v2", "https://user@api.attio.com"]) {
    process.env.ATTIO_API_BASE_URL = origin;
    await assert.rejects(attioRequest("fixture-token", "/notes"), /must be/);
  }
  delete process.env.ATTIO_API_BASE_URL;
  assert.equal(calls, 1);
  for (const id of ["..", ".", "a/b", "a?delete=1", "%2e%2e", "", "a\\b", "\n"]) assert.throws(() => attioSegment(id), /identifier/);
  assert.equal(attioSegment("telegram_associations-123"), "telegram_associations-123");
  for (const path of ["//evil.test", "/../notes", "/notes#ignore", "/notes\\evil", "/objects/%2e%2e/notes"]) await assert.rejects(attioRequest("fixture-token", path), /path/);
  await assert.rejects(attioRequest("fixture-token", "/notes", { method: "POST", body: "x".repeat(MAX_ATTIO_BYTES + 1) }), /size limit/);
  assert.equal(calls, 1);

  let cancelled = false;
  fakeFetch(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_ATTIO_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(attioRequest("fixture-token", "/notes"), /size limit/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
  fakeFetch(() => new Response("small", { headers: { "content-length": String(MAX_ATTIO_BYTES + 1) } }));
  await assert.rejects(attioRequest("fixture-token", "/notes"), /size limit/);
  assert.equal(calls, 1);

  fakeFetch(() => new Response('SECRET\u001b[2J', { status: 401 }));
  await assert.rejects(attioRequest("fixture-token", "/notes?private=value"), err => {
    assert.equal((err as Error).message, "Attio API 401: /notes");
    assert.ok(!JSON.stringify(err).includes("private=value")); return true;
  });
  assert.equal(calls, 1);
  fakeFetch(() => new Response("retry", { status: calls === 1 ? 429 : 200, headers: { "retry-after": "0" } }));
  await attioRequest("fixture-token", "/notes"); assert.equal(calls, 2);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    fakeFetch(() => { throw new TypeError("ambiguous request failure SECRET"); });
    await assert.rejects(attioRequest("fixture-token", "/notes", { method }), /details withheld/);
    assert.equal(calls, 1);
  }
  fakeFetch(() => new Response("service error", { status: 503 }));
  await assert.rejects(attioRequest("fixture-token", "/notes", { method: "POST" }), /503/);
  assert.equal(calls, 1);
  fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal((await attioRequest("fixture-token", "/notes", { method: "DELETE" })).status, 204);

  AbortSignal.timeout = (ms: number) => { assert.equal(ms, ATTIO_TIMEOUT_MS); return originalTimeout(1); };
  fakeFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }));
  // Native timeout signals are unref'd; hold the test event loop open.
  const hold = setInterval(() => {}, 100);
  try { await assert.rejects(attioRequest("fixture-token", "/notes", { method: "POST" }), /timed out/); }
  finally { clearInterval(hold); AbortSignal.timeout = originalTimeout; }
  assert.equal(calls, 1);

  // Exercise native fetch semantics against loopback fixtures, never live APIs.
  let redirected = 0;
  let streaming = false;
  const server = createServer((req, response) => {
    if (req.url === "/destination") { redirected++; response.end("should not arrive"); }
    else if (req.url === "/stall") {
      streaming = true; response.writeHead(200); response.write("partial");
    } else { response.writeHead(307, { location: "/destination" }); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    fakeFetch((_url, options) => originalFetch(`${local}/redirect`, options));
    await assert.rejects(attioRequest("fixture-token", "/notes", { method: "POST" }), /transport failed/);
    assert.equal(redirected, 0); assert.equal(calls, 1);
    AbortSignal.timeout = () => originalTimeout(100);
    fakeFetch((_url, options) => originalFetch(`${local}/stall`, options));
    await assert.rejects(attioRequest("fixture-token", "/notes", { method: "POST" }), /timed out/);
    assert.equal(streaming, true); assert.equal(calls, 1);
  } finally {
    AbortSignal.timeout = originalTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }

  attio.initAttio("fixture-token");
  fakeFetch(url => {
    if (!url.includes("?")) return new Response('{"data":{"id":{"note_id":"note-fixture"}}}');
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("parent_object"), "people");
    assert.equal(parsed.searchParams.get("parent_record_id"), "safe-id");
    return new Response('{"data":[]}');
  });
  await attio.upsertNote("safe-id", "title", "content");
  calls = 0;
  await assert.rejects(attio.upsertNote("safe-id", "title", "x".repeat(MAX_ATTIO_BYTES)), /size limit/);
  await assert.rejects(attio.upsertNote("../other", "title", "content"), /identifier/);
  await assert.rejects(attio.listTelegramAssociations("people/../companies"), /identifier/);
  assert.equal(calls, 0); // Particularly: no deletion before replacement-size checks.
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  if (originalBase === undefined) delete process.env.ATTIO_API_BASE_URL;
  else process.env.ATTIO_API_BASE_URL = originalBase;
  if (process.exitCode) return;
  const results = await Promise.all([
    runLocal(async () => { out("first"); await new Promise(r => setTimeout(r, 10)); }),
    runLocal(async () => { out("second"); }),
  ]);
  assert.deepEqual(results, ["first", "second"]);
  await assert.rejects(runLocal(async () => { throw new Error("expected failure"); }), /expected failure/);
  assert.equal(await runLocal(async () => { out("after failure"); }), "after failure");
  const serial = serialCommands(2);
  let release!: () => void;
  const first = serial(() => new Promise<void>(r => { release = r; }));
  const second = serial(async () => "second");
  await assert.rejects(serial(async () => "flood"), /Too many/);
  await Promise.resolve(); release(); await first; assert.equal(await second, "second");
  assert.equal(await serial(async () => "recovered"), "recovered");
  console.log("transport-security-smoke: PASS (origin, redirect policy, limits, timeout, redaction, mutation replay, serialized output and queue)");
});
