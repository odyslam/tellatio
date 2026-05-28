import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import type { Config } from "./config";
import type { BannedTelegramUser } from "./bans";

export interface TelegramMessage {
  id: number;
  date: number; // unix timestamp
  senderIdStr: string | undefined;
  senderUsername: string | undefined;
  senderName: string;
  text: string;
}

export interface ChatInfo {
  idStr: string;
  username?: string;
  title: string;
  isGroup: boolean;
  type: "dm" | "group" | "supergroup" | "channel" | "unknown";
}

export interface Participant {
  userIdStr: string;
  firstName: string;
  lastName: string;
  phone: string | undefined;
  username: string | undefined;
}

export interface RecentChat {
  peer: Api.TypeInputPeer;
  chatInfo: ChatInfo;
  unreadCount: number;
  lastMessage?: {
    id: number;
    date: number;
    text: string;
  };
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
export async function getFolderChatIds(
  folderName: string,
  options: { warnIfMissing?: boolean } = {},
): Promise<Api.TypeInputPeer[]> {
  const c = getClient();
  const result = await c.invoke(new Api.messages.GetDialogFilters());

  const filters = result.filters;
  const folder = filters.find(
    (f): f is Api.DialogFilter =>
      f instanceof Api.DialogFilter && f.title.text === folderName,
  );

  if (!folder) {
    if (options.warnIfMissing === false) return [];
    console.warn(`[telegram] Folder "${folderName}" not found. Available folders:`,
      filters
        .filter((f): f is Api.DialogFilter => f instanceof Api.DialogFilter)
        .map((f) => f.title.text),
    );
    return [];
  }

  return folder.includePeers;
}

function entityToChatInfo(entity: unknown): ChatInfo | null {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown";
    return { idStr: entity.id.toString(), username: entity.username, title: name, isGroup: false, type: "dm" };
  }

  if (entity instanceof Api.Chat) {
    return { idStr: entity.id.toString(), title: entity.title, isGroup: true, type: "group" };
  }

  if (entity instanceof Api.Channel) {
    return {
      idStr: entity.id.toString(),
      username: entity.username,
      title: entity.title,
      isGroup: true,
      type: entity.megagroup ? "supergroup" : "channel",
    };
  }

  return null;
}

function entityToBannedUser(entity: unknown): BannedTelegramUser | null {
  const chatInfo = entityToChatInfo(entity);
  if (!chatInfo) return null;

  if (entity instanceof Api.User) {
    return {
      chatId: entity.id.toString(),
      chatType: "dm",
      userId: entity.id.toString(),
      username: entity.username,
      displayName: chatInfo.title,
      source: "folder",
    };
  }

  return {
    chatId: chatInfo.idStr,
    chatType: chatInfo.type,
    username: chatInfo.username,
    displayName: chatInfo.title,
    source: "folder",
  };
}

/**
 * Load peers from the ban folder. DMs become user-level bans, so the same
 * account is filtered from group message fetches as well.
 */
export async function getBanFolderUsers(folderName: string): Promise<BannedTelegramUser[]> {
  const peers = await getFolderChatIds(folderName, { warnIfMissing: false });
  const users: BannedTelegramUser[] = [];

  for (const peer of peers) {
    try {
      const entity = await getClient().getEntity(peer);
      const banned = entityToBannedUser(entity);
      if (banned) users.push(banned);
    } catch (err) {
      console.warn(`[telegram] Failed to resolve ban folder peer in "${folderName}":`, err);
    }
  }

  return users;
}

/**
 * Resolve a peer to a ChatInfo with title and group status.
 */
export async function resolveChat(peer: Api.TypeInputPeer): Promise<ChatInfo | null> {
  const c = getClient();
  try {
    const entity = await c.getEntity(peer);
    return entityToChatInfo(entity);
  } catch (err) {
    console.error("[telegram] Failed to resolve peer:", err);
    return null;
  }
}

/**
 * List recent dialogs as syncable chats. This is used by association mode, where
 * Attio stores chat IDs and the worker maps those IDs back to live Telegram peers.
 */
export async function getRecentChats(limit: number): Promise<RecentChat[]> {
  const c = getClient();
  const dialogs = await c.getDialogs({ limit });
  const chats: RecentChat[] = [];

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity) continue;

    const chatInfo = entityToChatInfo(entity);
    if (!chatInfo) continue;

    try {
      const peer = await c.getInputEntity(entity as never) as Api.TypeInputPeer;
      const message = dialog.message;
      const text = message ? (message.text || message.message || "") : "";
      chats.push({
        peer,
        chatInfo,
        unreadCount: dialog.unreadCount,
        lastMessage: message
          ? {
              id: message.id,
              date: message.date,
              text,
            }
          : undefined,
      });
    } catch (err) {
      console.error(`[telegram] Failed to get input peer for ${chatInfo.title}:`, err);
    }
  }

  return chats;
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
    let senderUsername: string | undefined;
    if (msg.sender) {
      if (msg.sender instanceof Api.User) {
        senderName = [msg.sender.firstName, msg.sender.lastName].filter(Boolean).join(" ") || "Unknown";
        senderUsername = msg.sender.username;
      } else if ("title" in msg.sender) {
        senderName = (msg.sender as { title: string }).title;
      }
    }

    messages.push({
      id: msg.id,
      date: msg.date,
      senderIdStr: msg.senderId?.toString(),
      senderUsername,
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
  userIdStr?: string;
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
        userIdStr: entity.id.toString(),
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
