/**
 * Smoke checks for CLI-adjacent pure logic. These avoid Telegram and Attio
 * network access while covering behavior that gates approval-scoped runs.
 */

import assert from "node:assert/strict";
import { canonicalCompanyName, suggestAssociation } from "../src/association";
import { commandFlags } from "../src/cli/runtime";
import { identityDisplayName, identityUsername } from "../src/identity";

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

withEnv({
  TELLATIO_OWN_COMPANY_NAMES: "Phylax",
  TELLATIO_COMPANY_ALIASES: JSON.stringify({ "safe protocol": "Safe" }),
}, () => {
  const suggestion = suggestAssociation({
    chatId: "12345",
    title: "Phylax <> Safe Protocol",
    type: "group",
    lastMessageText: "multisig policy meeting",
  });

  assert.equal(suggestion.suggestedTargetObject, "companies");
  assert.equal(suggestion.suggestedTargetName, "Safe Protocol");
  assert.equal(canonicalCompanyName(suggestion.suggestedTargetName), "Safe");
  assert.ok(suggestion.confidence >= 0.45, "work group should stay reviewable");
});

assert.deepEqual(
  commandFlags({
    limit: 100,
    includeIdentityEvidence: false,
    omitLastMessageText: true,
    onlyChats: undefined,
  }),
  {
    limit: "100",
    includeIdentityEvidence: "false",
    omitLastMessageText: "true",
  },
);

assert.equal(identityDisplayName({ telegramUserId: "42", firstName: "Ada", lastName: "Lovelace" }), "Ada Lovelace");
assert.equal(identityDisplayName({ telegramUserId: "42", username: "Ada_Calc" }), "Ada_Calc");
assert.equal(identityUsername({ telegramUserId: "42", username: "@Ada_Calc" }), "ada_calc");

console.log("cli-logic-smoke: PASS (association hints + flag plumbing + identity display)");
