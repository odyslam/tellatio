#!/usr/bin/env node
process.umask(0o077);
/**
 * Tellatio CLI - Full Telegram API for agents.
 */

import { serveCli } from "./cli/registry";

serveCli();
