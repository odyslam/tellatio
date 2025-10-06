import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions';

export interface TelegramAuthConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  password?: string;
  sessionString?: string;
}

export interface ChatSyncConfig {
  mode: 'smart' | 'folders' | 'manual';
  folders?: string[];
  keywords?: string[];
  blacklist?: string[];
  whitelist?: string[];
  autoDetectBusiness?: boolean;
  syncGroups?: boolean;
  syncChannels?: boolean;
  syncBots?: boolean;
}

export class TelegramUserClient {
  private client: TelegramClient;
  private session: StoreSession;
  private phoneNumber: string;
  private syncConfig: ChatSyncConfig;

  constructor(config: TelegramAuthConfig, syncConfig: ChatSyncConfig) {
    this.phoneNumber = config.phoneNumber;
    this.syncConfig = syncConfig;
    
    // Use StoreSession for browser localStorage
    const sessionName = `telegram_session_${config.phoneNumber}`;
    this.session = new StoreSession(sessionName);
    
    // Initialize client with user API credentials
    this.client = new TelegramClient(
      this.session,
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5,
      }
    );
  }

  async connect(): Promise<string> {
    await this.client.connect();
    
    // Check if authenticated
    try {
      await this.client.getMe();
      return 'CONNECTED';
    } catch {
      // New authentication needed
      return 'AUTH_REQUIRED';
    }
  }

  async authenticate(phoneCodeCallback: () => Promise<string>): Promise<string> {
    await this.client.start({
      phoneNumber: async () => this.phoneNumber,
      phoneCode: phoneCodeCallback,
      onError: (err) => console.error('Auth error:', err),
    });
    
    // Session is automatically saved to localStorage by StoreSession
    return 'authenticated';
  }

  async getDialogs(limit = 100): Promise<any[]> {
    const dialogs = await this.client.getDialogs({ limit });
    return dialogs;
  }

  async getFolders(): Promise<any[]> {
    try {
      const result = await this.client.invoke(
        new Api.messages.GetDialogFilters()
      );
      return (result as any).filters || [];
    } catch {
      return [];
    }
  }

  async createAttioFolder(): Promise<void> {
    const folders = await this.getFolders();
    const attioFolder = folders.find((f: any) => f.title === 'Attio');
    
    if (!attioFolder) {
      await this.client.invoke(
        new Api.messages.UpdateDialogFilter({
          id: Math.floor(Math.random() * 1000) + 100,
          filter: new Api.DialogFilter({
            id: Math.floor(Math.random() * 1000) + 100,
            title: 'Attio' as any,
            pinnedPeers: [],
            includePeers: [],
            excludePeers: [],
            emoticon: '💼',
          }),
        })
      );
    }
  }

  async getChatMessages(chatId: string | number, limit = 100): Promise<Api.Message[]> {
    const messages = await this.client.getMessages(chatId, { limit });
    return messages as Api.Message[];
  }

  async sendMessage(chatId: string | number, text: string): Promise<Api.Message> {
    const result = await this.client.sendMessage(chatId, { message: text });
    return result as Api.Message;
  }

  shouldSyncChat(dialog: any): boolean {
    const privacyFilter = new PrivacyFilter(this.syncConfig);
    return privacyFilter.shouldSync(dialog);
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}

export class PrivacyFilter {
  constructor(private config: ChatSyncConfig) {}

  shouldSync(dialog: any): boolean {
    const chat = dialog.entity || dialog;
    const title = chat.title || chat.firstName || chat.name || '';
    const chatId = dialog.id?.toString() || '';
    
    // Check blacklist first (privacy priority)
    if (this.isBlacklisted(title, chatId)) return false;
    
    // Check whitelist
    if (this.isWhitelisted(title, chatId)) return true;
    
    // Apply mode-specific logic
    switch (this.config.mode) {
      case 'manual':
        return false; // Only sync whitelisted
        
      case 'folders':
        return this.isInSyncFolder(dialog);
        
      case 'smart':
      default:
        return this.smartDetect(dialog);
    }
  }

  private isBlacklisted(title: string, chatId: string): boolean {
    const blacklistPatterns = [
      /family|personal|private/i,
      /mom|dad|sister|brother/i,
      /girlfriend|boyfriend|wife|husband/i,
    ];
    
    // Check built-in patterns
    if (blacklistPatterns.some(pattern => pattern.test(title))) {
      return true;
    }
    
    // Check user blacklist
    if (this.config.blacklist?.includes(chatId)) {
      return true;
    }
    
    return false;
  }

  private isWhitelisted(title: string, chatId: string): boolean {
    const whitelistPatterns = [
      /customer|client|support/i,
      /business|work|office/i,
      /sales|marketing|product/i,
    ];
    
    // Check built-in patterns
    if (whitelistPatterns.some(pattern => pattern.test(title))) {
      return true;
    }
    
    // Check user whitelist
    if (this.config.whitelist?.includes(chatId)) {
      return true;
    }
    
    return false;
  }

  private isInSyncFolder(dialog: any): boolean {
    // Check if dialog is in any of the sync folders
    const folder = (dialog as any).folderId;
    if (!folder) return false;
    
    // This would need to map folder IDs to names
    return this.config.folders?.includes(folder) || false;
  }

  private smartDetect(dialog: any): boolean {
    if (!this.config.autoDetectBusiness) return false;
    
    const chat = dialog.entity || dialog;
    const title = chat.title || chat.firstName || chat.name || '';
    
    // Skip certain types
    if ((chat as any).type === 'channel' && !this.config.syncChannels) return false;
    if ((chat as any).type === 'bot' && !this.config.syncBots) return false;
    
    // Check for business keywords
    const businessKeywords = this.config.keywords || [
      'customer', 'client', 'meeting', 'contract',
      'invoice', 'project', 'deadline', 'payment',
      'proposal', 'deal', 'opportunity',
    ];
    
    const hasBusinessKeyword = businessKeywords.some(keyword => 
      title.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (hasBusinessKeyword) return true;
    
    // Check if it's a group (more likely business)
    if ((chat as any).type === 'group' && this.config.syncGroups) {
      // Groups are often business-related
      return true;
    }
    
    return false;
  }
}