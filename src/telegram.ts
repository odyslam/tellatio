import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import type { Config } from "./config";

export interface TelegramMessage {
  id: number;
  date: number; // unix timestamp
  senderIdStr: string | undefined;
  senderName: string;
  text: string;
}

export interface ChatInfo {
  idStr: string;
  title: string;
  isGroup: boolean;
}

export interface Participant {
  userIdStr: string;
  firstName: string;
  lastName: string;
  phone: string | undefined;
  username: string | undefined;
}

let client: TelegramClient | null = null;

export async function connect(config: Config): Promise<TelegramClient> {
  const session = new StringSession(config.telegramSession);
  client = new TelegramClient(session, config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  console.log("[telegram] Connected");
  return client;
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log("[telegram] Disconnected");
  }
}

function getClient(): TelegramClient {
  if (!client) throw new Error("Telegram client not connected");
  return client;
}

/**
 * Find the Telegram folder by name and return the chat IDs (peers) it contains.
 */
export async function getFolderChatIds(folderName: string): Promise<Api.TypeInputPeer[]> {
  const c = getClient();
  const result = await c.invoke(new Api.messages.GetDialogFilters());

  const filters = result.filters;
  const folder = filters.find(
    (f): f is Api.DialogFilter =>
      f instanceof Api.DialogFilter && f.title.text === folderName,
  );

  if (!folder) {
    console.warn(`[telegram] Folder "${folderName}" not found. Available folders:`,
      filters
        .filter((f): f is Api.DialogFilter => f instanceof Api.DialogFilter)
        .map((f) => f.title.text),
    );
    return [];
  }

  return folder.includePeers;
}

/**
 * Resolve a peer to a ChatInfo with title and group status.
 */
export async function resolveChat(peer: Api.TypeInputPeer): Promise<ChatInfo | null> {
  const c = getClient();
  try {
    const entity = await c.getEntity(peer);

    if (entity instanceof Api.User) {
      const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || "Unknown";
      return { idStr: entity.id.toString(), title: name, isGroup: false };
    }

    if (entity instanceof Api.Chat) {
      return { idStr: entity.id.toString(), title: entity.title, isGroup: true };
    }

    if (entity instanceof Api.Channel) {
      return { idStr: entity.id.toString(), title: entity.title, isGroup: true };
    }

    return null;
  } catch (err) {
    console.error("[telegram] Failed to resolve peer:", err);
    return null;
  }
}

/**
 * Fetch messages from a chat, optionally after a minimum message ID.
 * Returns messages in chronological order (oldest first).
 */
export async function getMessages(
  peer: Api.TypeInputPeer,
  minId: number = 0,
  limit: number = 500,
): Promise<TelegramMessage[]> {
  const c = getClient();
  const messages: TelegramMessage[] = [];

  const result = await c.getMessages(peer, { limit, minId });

  for (const msg of result) {
    if (!msg.message) continue; // skip service messages with no text

    let senderName = "Unknown";
    if (msg.sender) {
      if (msg.sender instanceof Api.User) {
        senderName = [msg.sender.firstName, msg.sender.lastName].filter(Boolean).join(" ") || "Unknown";
      } else if ("title" in msg.sender) {
        senderName = (msg.sender as { title: string }).title;
      }
    }

    messages.push({
      id: msg.id,
      date: msg.date,
      senderIdStr: msg.senderId?.toString(),
      senderName,
      text: msg.text || msg.message,
    });
  }

  // GramJS returns newest first; reverse for chronological
  messages.reverse();
  return messages;
}

/**
 * Get the current user's ID (as string) and name.
 */
export async function getMe(): Promise<{ idStr: string; firstName: string }> {
  const c = getClient();
  const me = await c.getMe() as Api.User;
  return { idStr: me.id.toString(), firstName: me.firstName || "You" };
}

/**
 * Get a DM partner's phone number and username.
 */
export async function getUserInfo(peer: Api.TypeInputPeer): Promise<{
  firstName?: string;
  lastName?: string;
  phone?: string;
  username?: string;
}> {
  const c = getClient();
  try {
    const entity = await c.getEntity(peer);
    if (entity instanceof Api.User) {
      return {
        firstName: entity.firstName,
        lastName: entity.lastName,
        phone: entity.phone,
        username: entity.username,
      };
    }
  } catch {
    // ignore
  }
  return {};
}

/**
 * Get participants of a group chat with their phone numbers.
 */
export async function getGroupParticipants(peer: Api.TypeInputPeer): Promise<Participant[]> {
  const c = getClient();
  const participants: Participant[] = [];

  try {
    const users = await c.getParticipants(peer, {});
    for (const user of users) {
      if (user instanceof Api.User && !user.bot) {
        participants.push({
          userIdStr: user.id.toString(),
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          phone: user.phone,
          username: user.username,
        });
      }
    }
  } catch (err) {
    console.error("[telegram] Failed to get participants:", err);
  }

  return participants;
}
