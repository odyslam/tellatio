#!/usr/bin/env node
/*
 * CLI helper to generate a Telegram session string using GramJS.
 *
 * Non-interactive mode (reads from .env):
 *   TELEGRAM_PHONE=+30... TELEGRAM_2FA_PASSWORD=... pnpm login:telegram
 *
 * Interactive mode (prompts for missing values):
 *   pnpm login:telegram
 *
 * The verification code is always prompted (can't be known in advance).
 */

const readline = require("readline");
const path = require("path");
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const { computeCheck } = require("telegram/Password");

// Load .env file manually (no dotenv dependency)
function loadEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // no .env file, that's fine
  }
}

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  loadEnv();

  const rl = createInterface();
  let client = null;
  let stringSession = null;

  try {
    console.log("Tellatio Telegram Login Helper\n--------------------------------\n");

    const apiId = Number.parseInt(process.env.TELEGRAM_API_ID, 10);
    if (!Number.isFinite(apiId)) {
      throw new Error("TELEGRAM_API_ID not set or not a number");
    }

    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiHash) {
      throw new Error("TELEGRAM_API_HASH not set");
    }

    console.log(`API ID: ${apiId}`);
    console.log(`API Hash: ${apiHash.slice(0, 6)}...`);

    const phoneNumber =
      process.env.TELEGRAM_PHONE ||
      (await ask(rl, "Phone number (with country code, e.g. +1234567890): "));

    if (!phoneNumber) {
      throw new Error("Phone number is required");
    }

    console.log(`Phone: ${phoneNumber}`);
    console.log("\nConnecting to Telegram and sending the login code...");

    stringSession = new StringSession("");
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    await client.connect();

    const sendCodeResult = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );

    // Code always requires user input
    const code = await ask(rl, "Verification code (from Telegram): ");

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: sendCodeResult.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (error) {
      if (error?.errorMessage === "SESSION_PASSWORD_NEEDED") {
        const password =
          process.env.TELEGRAM_2FA_PASSWORD ||
          (await ask(rl, "Two-factor password: "));

        if (!password) {
          throw new Error("Two-factor password required");
        }

        const passwordInfo = await client.invoke(
          new Api.account.GetPassword({}),
        );
        const srpResult = await computeCheck(passwordInfo, password);
        await client.invoke(
          new Api.auth.CheckPassword({ password: srpResult }),
        );
      } else {
        throw error;
      }
    }

    const sessionString = stringSession.save();
    console.log("\n✅ Login complete!");
    console.log(
      "Session string (add as TELEGRAM_SESSION in .env):\n",
    );
    console.log(sessionString);
  } catch (error) {
    console.error("\n❌ Failed to generate session string.");
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        await client.disconnect();
      } catch (disconnectError) {
        console.error(
          "Warning: failed to disconnect Telegram client",
          disconnectError,
        );
      }
    }
    rl.close();
  }
}

main();
