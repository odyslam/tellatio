/**
 * Smoke test for the prompt-injection / write-guard helpers.
 *
 * Imports the side-effect-free `src/guard` module (NOT the self-executing CLI)
 * so it can run without Telegram credentials. Runs clean under both:
 *   npx ts-node scripts/guard-smoke.ts
 *   bun scripts/guard-smoke.ts
 */

import assert from "node:assert/strict";
import { evaluateWriteGuard, sanitizeUntrusted, sanitizeUntrustedValue } from "../src/guard";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// mode off -> allowed
withEnv({ TELLATIO_WRITE_GUARD: "off", TELLATIO_ALLOW_WRITES: undefined }, () => {
  const d = evaluateWriteGuard("send message");
  assert.equal(d.mode, "off");
  assert.equal(d.allowed, true);
});

// mode warn -> allowed
withEnv({ TELLATIO_WRITE_GUARD: "warn", TELLATIO_ALLOW_WRITES: undefined }, () => {
  const d = evaluateWriteGuard("send message");
  assert.equal(d.mode, "warn");
  assert.equal(d.allowed, true);
});

// mode enforce without confirm -> NOT allowed
withEnv({ TELLATIO_WRITE_GUARD: "enforce", TELLATIO_ALLOW_WRITES: undefined }, () => {
  const d = evaluateWriteGuard("delete messages");
  assert.equal(d.mode, "enforce");
  assert.equal(d.allowed, false);
});

// mode enforce with TELLATIO_ALLOW_WRITES=1 -> allowed
withEnv({ TELLATIO_WRITE_GUARD: "enforce", TELLATIO_ALLOW_WRITES: "1" }, () => {
  const d = evaluateWriteGuard("delete messages");
  assert.equal(d.mode, "enforce");
  assert.equal(d.allowed, true);
});

// default (unset) -> warn and allowed
withEnv({ TELLATIO_WRITE_GUARD: undefined, TELLATIO_ALLOW_WRITES: undefined }, () => {
  const d = evaluateWriteGuard("send message");
  assert.equal(d.mode, "warn");
  assert.equal(d.allowed, true);
});

// unknown mode -> treated as warn and allowed
withEnv({ TELLATIO_WRITE_GUARD: "bogus", TELLATIO_ALLOW_WRITES: undefined }, () => {
  const d = evaluateWriteGuard("send message");
  assert.equal(d.mode, "warn");
  assert.equal(d.allowed, true);
});

// sanitizeUntrusted: strips bidi override (U+202E) and zero-width (U+200B), keeps visible text.
const bidi = "\u202Eevil";
const zwsp = "he\u200Bllo";
assert.equal(sanitizeUntrusted(bidi), "evil");
assert.equal(sanitizeUntrusted(zwsp), "hello");
assert.equal(sanitizeUntrusted(undefined), "");
assert.equal(sanitizeUntrusted(null), "");
assert.equal(sanitizeUntrusted("plain text"), "plain text");
assert.deepEqual(
  sanitizeUntrustedValue({ title: "he\u200Bllo", nested: ["a\u202Eb"] }),
  { title: "hello", nested: ["ab"] },
);

console.log("guard-smoke: PASS (write-guard matrix + sanitizeUntrusted)");
