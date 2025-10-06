import type { AttioContext } from 'attio';
import type { TelegramMessage, TelegramWebhookData } from '../types/telegram.types';
import { AttioAPI } from './attio-api';
import { TelegramAPI } from './telegram-api';
import { FileHandler } from './file-handler';
import { nanoid } from 'nanoid';

export class MessageProcessor {
  private attioApi: AttioAPI;
  private telegramApi: TelegramAPI;
  private fileHandler: FileHandler;

  constructor(context: AttioContext) {
    this.attioApi = new AttioAPI(context);
    this.telegramApi = new TelegramAPI();
    this.fileHandler = new FileHandler();
  }

  async processUpdate(update: TelegramWebhookData): Promise<void> {
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    
    if (!message) {
      console.log('No message in update:', update);
      return;
    }

    await this.processMessage(message, update.edited_message ? 'edited' : 'new');
  }

  private async processMessage(message: TelegramMessage, type: 'new' | 'edited'): Promise<void> {
    const { chat, from, text, photo, document, voice, video, caption } = message;
    
    if (!from && chat.type === 'private') {
      console.error('Private message without sender:', message);
      return;
    }

    let parentObject: string;
    let parentRecordId: string;
    
    if (chat.type === 'private' && from) {
      const person = await this.upsertPerson(from);
      if (!person) {
        console.error('Failed to upsert person:', from);
        return;
      }
      parentObject = 'people';
      parentRecordId = person.id.record_id;
    } else {
      const telegramChat = await this.upsertTelegramChat(chat);
      if (!telegramChat) {
        console.error('Failed to upsert Telegram chat:', chat);
        return;
      }
      parentObject = 'telegram_chats';
      parentRecordId = telegramChat.id.record_id;
    }

    let noteContent = '';
    const direction = from?.is_bot ? 'outgoing' : 'incoming';
    const timestamp = new Date(message.date * 1000).toISOString();
    
    if (text) {
      noteContent = text;
    } else if (caption) {
      noteContent = caption;
    }

    const attachments: string[] = [];
    
    if (photo && photo.length > 0) {
      const largestPhoto = photo[photo.length - 1];
      const fileUrl = await this.fileHandler.processFile(largestPhoto.file_id, 'photo.jpg', this.telegramApi);
      if (fileUrl) {
        attachments.push(`📷 [Photo](${fileUrl})`);
      }
    }
    
    if (document) {
      const fileUrl = await this.fileHandler.processFile(
        document.file_id,
        document.file_name || 'document',
        this.telegramApi
      );
      if (fileUrl) {
        attachments.push(`📎 [${document.file_name || 'Document'}](${fileUrl})`);
      }
    }
    
    if (voice) {
      const fileUrl = await this.fileHandler.processFile(voice.file_id, 'voice.ogg', this.telegramApi);
      if (fileUrl) {
        attachments.push(`🎤 [Voice Message](${fileUrl}) (${voice.duration}s)`);
      }
    }
    
    if (video) {
      const fileUrl = await this.fileHandler.processFile(video.file_id, 'video.mp4', this.telegramApi);
      if (fileUrl) {
        attachments.push(`🎥 [Video](${fileUrl}) (${video.duration}s)`);
      }
    }

    if (attachments.length > 0) {
      noteContent += '\n\n**Attachments:**\n' + attachments.join('\n');
    }

    const senderInfo = from ? `@${from.username || from.first_name}` : 'Unknown';
    const chatInfo = chat.type === 'private' ? senderInfo : (chat.title || 'Unknown Chat');
    
    const noteTitle = `Telegram • ${direction} • ${chatInfo}`;
    
    if (!noteContent && attachments.length === 0) {
      noteContent = '(Empty message)';
    }

    const metadata = `\n\n---\n_Message ID: ${message.message_id}_\n_${type === 'edited' ? 'Edited at' : 'Sent at'}: ${timestamp}_`;
    noteContent += metadata;

    await this.attioApi.createNote({
      parent_object: parentObject,
      parent_record_id: parentRecordId,
      title: noteTitle,
      content: noteContent,
      format: 'markdown',
      created_at: timestamp,
    });

    await this.checkForAutomations(noteContent, parentObject, parentRecordId);
  }

  private async upsertPerson(user: any): Promise<any> {
    const telegramUserId = String(user.id);
    
    let person = await this.attioApi.findPersonByTelegramId(telegramUserId);
    
    if (!person && user.username) {
      person = await this.attioApi.findPersonByUsername(user.username);
    }
    
    const attributes = {
      telegram_user_id: telegramUserId,
      telegram_username: user.username || undefined,
      telegram_first_name: user.first_name || undefined,
      telegram_last_name: user.last_name || undefined,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.username || `User ${telegramUserId}`,
    };
    
    if (person) {
      const response = await this.attioApi.updatePersonTelegramId(person.id.record_id, telegramUserId);
      return response || person;
    }
    
    return await this.attioApi.upsertPerson(attributes);
  }

  private async upsertTelegramChat(chat: any): Promise<any> {
    const chatId = String(chat.id);
    
    const attributes = {
      chat_id: chatId,
      title: chat.title || chat.username || `${chat.first_name || ''} ${chat.last_name || ''}`.trim(),
      type: chat.type,
    };
    
    return await this.attioApi.upsertTelegramChat(attributes);
  }

  private async checkForAutomations(content: string, parentObject: string, parentRecordId: string): Promise<void> {
    const lowerContent = content.toLowerCase();
    const keywords = ['pricing', 'demo', 'trial', 'help', 'support', 'bug', 'issue', 'problem'];
    
    for (const keyword of keywords) {
      if (lowerContent.includes(keyword)) {
        await this.attioApi.createTask({
          parent_object: parentObject,
          parent_record_id: parentRecordId,
          title: `Follow up on ${keyword} inquiry`,
          description: `Customer mentioned "${keyword}" in Telegram message. Original message:\n\n${content.substring(0, 500)}`,
          due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        break;
      }
    }
  }

  async processStartCommand(message: TelegramMessage, token?: string): Promise<void> {
    if (!message.from) return;
    
    if (token) {
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const { personId, timestamp } = JSON.parse(decoded);
        
        const hourAgo = Date.now() - 60 * 60 * 1000;
        if (timestamp < hourAgo) {
          await this.telegramApi.sendMessage(
            message.chat.id,
            '⚠️ This link has expired. Please request a new one from Attio.'
          );
          return;
        }
        
        await this.attioApi.updatePersonTelegramId(personId, String(message.from.id));
        
        await this.telegramApi.sendMessage(
          message.chat.id,
          `✅ Your Telegram account has been successfully linked to your Attio profile!\n\nYou can now receive messages directly from Attio.`
        );
      } catch (error) {
        console.error('Failed to process start token:', error);
        await this.telegramApi.sendMessage(
          message.chat.id,
          '❌ Invalid or expired link. Please request a new one from Attio.'
        );
      }
    } else {
      await this.telegramApi.sendMessage(
        message.chat.id,
        `👋 Welcome to the Attio Telegram integration!\n\nTo link your account, please use the link provided in Attio.`
      );
    }
  }

  async processGroupAdd(message: TelegramMessage, companyId?: string): Promise<void> {
    if (!message.chat || message.chat.type === 'private') return;
    
    const attributes: any = {
      chat_id: String(message.chat.id),
      title: message.chat.title || 'Unnamed Group',
      type: message.chat.type,
    };
    
    if (companyId) {
      attributes.company = companyId;
    }
    
    await this.attioApi.upsertTelegramChat(attributes);
    
    await this.telegramApi.sendMessage(
      message.chat.id,
      `✅ This group has been connected to Attio${companyId ? ' and linked to your company' : ''}!\n\nAll messages will be logged for better customer communication tracking.`
    );
  }
}