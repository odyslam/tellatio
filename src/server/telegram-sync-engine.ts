import { TelegramUserClient, ChatSyncConfig } from './telegram-user-client';
import { AttioAPI } from './attio-api';

export interface SyncStats {
  totalChats: number;
  syncedChats: number;
  excludedChats: number;
  totalMessages: number;
  errors: string[];
}

export class TelegramSyncEngine {
  private client: TelegramUserClient;
  private attioApi: AttioAPI;
  private stats: SyncStats;
  private syncConfig: ChatSyncConfig;

  constructor(
    client: TelegramUserClient,
    attioApi: AttioAPI,
    syncConfig: ChatSyncConfig
  ) {
    this.client = client;
    this.attioApi = attioApi;
    this.syncConfig = syncConfig;
    this.stats = {
      totalChats: 0,
      syncedChats: 0,
      excludedChats: 0,
      totalMessages: 0,
      errors: [],
    };
  }

  async performInitialSync(): Promise<SyncStats> {
    try {
      console.log('Starting initial sync with privacy filtering...');
      
      // Get all dialogs
      const dialogs = await this.client.getDialogs(100);
      this.stats.totalChats = dialogs.length;
      
      // Create Attio folder if using folder mode
      if (this.syncConfig.mode === 'folders') {
        await this.client.createAttioFolder();
      }
      
      // Process each dialog with privacy filter
      for (const dialog of dialogs) {
        await this.processDialog(dialog);
      }
      
      console.log('Initial sync complete:', this.stats);
      return this.stats;
    } catch (error) {
      console.error('Sync failed:', error);
      this.stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
      return this.stats;
    }
  }

  private async processDialog(dialog: any): Promise<void> {
    try {
      // Apply privacy filter
      const shouldSync = this.client.shouldSyncChat(dialog);
      
      if (!shouldSync) {
        this.stats.excludedChats++;
        console.log(`Excluded (privacy): ${this.getChatName(dialog)}`);
        return;
      }
      
      console.log(`Syncing: ${this.getChatName(dialog)}`);
      
      // Create or update Telegram Chat record in Attio
      const chat = await this.upsertTelegramChat(dialog);
      if (!chat) {
        this.stats.errors.push(`Failed to create chat: ${this.getChatName(dialog)}`);
        return;
      }
      
      // Sync messages
      const chatId = dialog.id || dialog.chatId || dialog.entity?.id;
      const messages = await this.client.getChatMessages(chatId, 50);
      
      for (const message of messages) {
        await this.syncMessage(chat.id.record_id, message, dialog);
        this.stats.totalMessages++;
      }
      
      this.stats.syncedChats++;
    } catch (error) {
      console.error(`Failed to process dialog:`, error);
      this.stats.errors.push(`Dialog processing failed: ${this.getChatName(dialog)}`);
    }
  }

  private getChatName(dialog: any): string {
    const entity = dialog.entity || dialog;
    return entity.title || entity.firstName || entity.username || entity.name || 'Unknown';
  }

  private async upsertTelegramChat(dialog: any): Promise<any> {
    const entity = dialog.entity || dialog;
    const chatId = String(dialog.id || dialog.chatId || entity.id);
    
    // Determine if it's a person or a group/channel
    const isPersonalChat = !entity.title && entity.firstName;
    
    if (isPersonalChat) {
      // For personal chats, update/create Person record
      return await this.attioApi.upsertPerson({
        telegram_user_id: chatId,
        telegram_username: entity.username,
        telegram_first_name: entity.firstName,
        telegram_last_name: entity.lastName,
        name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
      });
    } else {
      // For groups/channels, create Telegram Chat record
      return await this.attioApi.upsertTelegramChat({
        chat_id: chatId,
        title: entity.title || 'Unnamed Chat',
        type: this.getChatType(entity),
      });
    }
  }

  private getChatType(entity: any): 'private' | 'group' | 'supergroup' | 'channel' {
    if (entity.broadcast) return 'channel';
    if (entity.megagroup) return 'supergroup';
    if (entity.title) return 'group';
    return 'private';
  }

  private async syncMessage(
    parentRecordId: string,
    message: any,
    dialog: any
  ): Promise<void> {
    try {
      const entity = dialog.entity || dialog;
      const isPersonalChat = !entity.title;
      const sender = (message.sender as any);
      const senderName = sender?.firstName || sender?.username || 'Unknown';
      const direction = message.out ? 'outgoing' : 'incoming';
      
      // Format message content
      let content = message.text || '';
      
      // Add media indicators
      if (message.photo) content += '\n📷 [Photo]';
      if (message.document) content += '\n📎 [Document]';
      if (message.voice) content += '\n🎤 [Voice Message]';
      if (message.video) content += '\n🎥 [Video]';
      
      // Create metadata
      const metadata = `\n\n---\n_Sender: ${senderName}_\n_Message ID: ${message.id}_\n_Date: ${new Date(message.date * 1000).toISOString()}_`;
      content += metadata;
      
      // Create Note in Attio
      await this.attioApi.createNote({
        parent_object: isPersonalChat ? 'people' : 'telegram_chats',
        parent_record_id: parentRecordId,
        title: `Telegram • ${direction} • ${this.getChatName(dialog)}`,
        content,
        format: 'markdown',
        created_at: new Date(message.date * 1000).toISOString(),
      });
    } catch (error) {
      console.error('Failed to sync message:', error);
      this.stats.errors.push(`Message sync failed: ${message.id}`);
    }
  }

  async setupRealtimeSync(): Promise<void> {
    // Set up event handler for new messages
    // Note: This would need access to the internal Telegram client
    // In production, we'd set up a listener for new messages
    // that respects the privacy filter
    console.log('Real-time sync setup placeholder');
  }

  getStats(): SyncStats {
    return this.stats;
  }
}