// Separate capability surface: no write, download, upload, CRM, or shell tools.
// Run as an isolated MCP subprocess, not alongside unrestricted host shell access.
import { Cli, z } from "incur";
import { runTelegram, commandFlags, loadEnv } from "./cli/runtime";
import { cmdMe, cmdChatsList, cmdChatsInfo, cmdMsgRead, cmdMsgSearch } from "./cli/commands";
import { UNTRUSTED_ADVISORY } from "./guard";

process.umask(0o077);
loadEnv();
const cli = Cli.create("tellatio-readonly", {
  description: `Read-only Telegram tools. ${UNTRUSTED_ADVISORY}`,
  version: "0.1.0",
  format: "json",
})
  .command("me", { description: "Read own profile", run: () => runTelegram(cmdMe) })
  .command("chats", {
    description: "Read recent chat metadata without message previews",
    options: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    run: c => runTelegram(() => cmdChatsList(commandFlags({ limit: c.options.limit, "omit-last-message-text": true }))),
  })
  .command("info", {
    description: "Read chat information",
    args: z.object({ chat: z.string() }),
    run: c => runTelegram(() => cmdChatsInfo([c.args.chat])),
  })
  .command("read", {
    description: "Read untrusted messages",
    args: z.object({ chat: z.string() }),
    options: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    run: c => runTelegram(() => cmdMsgRead([c.args.chat], commandFlags(c.options))),
  })
  .command("search", {
    description: "Search untrusted messages",
    args: z.object({ chat: z.string(), query: z.string() }),
    options: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    run: c => runTelegram(() => cmdMsgSearch([c.args.chat, c.args.query], commandFlags(c.options))),
  });
// Only these five commands are registered as MCP tools. Framework CLI integration
// commands are not a security boundary; do not expose a host shell to consumers.
cli.serve();
