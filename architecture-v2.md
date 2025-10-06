# Tellatio: Telegram ↔ Attio Integration Architecture v2

## Executive Summary

This document outlines the enhanced architecture for Tellatio, evolving from a basic Bot API integration to a comprehensive User API-based solution that provides an email-like experience for managing Telegram conversations in Attio.

## Current State (Bot API - v1)

### Limitations
- ❌ Manual linking required for each chat
- ❌ No access to chat history
- ❌ Cannot discover existing conversations
- ❌ Unnatural user experience
- ❌ Limited to bot-initiated conversations

### What's Built
- ✅ Webhook handler for incoming messages
- ✅ Message processor creating Notes in Attio
- ✅ Send message actions from Attio
- ✅ Basic deep linking for account connection
- ✅ File attachment handling

---

## Proposed Architecture (User API - v2)

### Core Concept
Transform Tellatio from a bot-based integration to a **Telegram client** that acts as an email-like sync service, automatically managing business conversations in Attio.

### Key Features
1. **Automatic Chat Discovery** - All Telegram chats visible without manual setup
2. **Folder-Based Organization** - Use Telegram folders to control what syncs
3. **Full History Access** - Complete conversation history, not just new messages
4. **Natural Workflow** - Works like email, no manual linking needed
5. **Smart Filtering** - Auto-detect business conversations

---

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

#### 1.1 User Authentication System
```typescript
// New authentication flow
interface TelegramUserAuth {
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  session?: string; // Encrypted session storage
}

// Secure session management
class SessionManager {
  async authenticate(user: AttioUser): Promise<TelegramSession>
  async refreshSession(sessionId: string): Promise<void>
  async revokeAccess(userId: string): Promise<void>
}
```

#### 1.2 Data Model Updates
```typescript
// Enhanced People attributes
People {
  // Existing
  telegram_user_id: string
  telegram_username: string
  
  // New
  telegram_phone: string (encrypted)
  telegram_session_id: string (reference)
  telegram_folders: string[] // Synced folders
  sync_enabled: boolean
  last_sync: datetime
}

// New: Telegram Sessions object
TelegramSessions {
  id: string
  user_id: string (relationship → People)
  encrypted_session: string
  api_credentials: string (encrypted)
  active: boolean
  created_at: datetime
  last_used: datetime
}

// Enhanced Telegram Chats
TelegramChats {
  // Existing fields...
  
  // New
  folder_id: string
  folder_name: string
  auto_synced: boolean
  sync_rules: json
  message_count: number
  first_message_date: datetime
  last_message_date: datetime
}
```

#### 1.3 Connection Architecture
```typescript
// Dual-mode connection handler
class TelegramConnectionManager {
  private botClient: TelegramBot;      // For public/support
  private userClients: Map<string, TelegramUserClient>; // Per-user clients
  
  async connectUser(userId: string, auth: TelegramUserAuth) {
    const client = new TelegramUserClient(auth);
    await client.connect();
    this.userClients.set(userId, client);
    
    // Start folder monitoring
    await this.setupFolderSync(userId, client);
  }
  
  async setupFolderSync(userId: string, client: TelegramUserClient) {
    // Monitor specific folders
    const folders = await client.getDialogFilters();
    const attioFolder = folders.find(f => f.title === 'Attio');
    
    if (attioFolder) {
      await this.syncFolder(userId, client, attioFolder);
    }
  }
}
```

### Phase 2: Core Sync Engine (Week 3-4)

#### 2.1 Message Sync Service
```typescript
class TelegramSyncService {
  async syncUserChats(userId: string, options: SyncOptions) {
    const client = this.getClient(userId);
    
    // Get all dialogs
    const dialogs = await client.getDialogs({
      limit: options.limit || 100,
      offsetDate: options.lastSync
    });
    
    for (const dialog of dialogs) {
      if (this.shouldSync(dialog, options)) {
        await this.syncDialog(userId, dialog);
      }
    }
  }
  
  private shouldSync(dialog: Dialog, options: SyncOptions): boolean {
    // Check folder membership
    if (options.folderOnly && !dialog.folderId) return false;
    
    // Smart detection for business chats
    if (options.smartDetection) {
      return this.isBusinessRelated(dialog);
    }
    
    return true;
  }
  
  private isBusinessRelated(dialog: Dialog): boolean {
    const businessIndicators = [
      dialog.entity?.username?.includes('support'),
      dialog.entity?.username?.includes('sales'),
      dialog.title?.match(/customer|client|partner/i),
      dialog.messages?.some(m => 
        m.text?.match(/pricing|demo|meeting|contract/i)
      )
    ];
    
    return businessIndicators.some(Boolean);
  }
  
  async syncDialog(userId: string, dialog: Dialog) {
    // Create or update Telegram Chat record
    const chat = await this.upsertTelegramChat({
      chat_id: String(dialog.id),
      title: dialog.title || dialog.name,
      type: dialog.isChannel ? 'channel' : 
            dialog.isGroup ? 'group' : 'private',
      folder_name: dialog.folder?.title,
      auto_synced: true,
      message_count: dialog.unreadCount
    });
    
    // Sync messages
    const messages = await dialog.getMessages({ limit: 100 });
    for (const message of messages) {
      await this.syncMessage(chat.id, message);
    }
    
    // Setup real-time sync
    await this.setupRealtimeSync(userId, dialog.id);
  }
}
```

#### 2.2 Folder Management
```typescript
class FolderSyncManager {
  async createAttioFolder(client: TelegramUserClient) {
    // Create default "Attio" folder if not exists
    const folders = await client.getDialogFilters();
    
    if (!folders.find(f => f.title === 'Attio')) {
      await client.createDialogFilter({
        id: 100, // Custom ID
        title: 'Attio',
        includePeers: [],
        excludePeers: [],
        emoticon: '💼'
      });
    }
  }
  
  async addChatToFolder(client: TelegramUserClient, chatId: string) {
    const folders = await client.getDialogFilters();
    const attioFolder = folders.find(f => f.title === 'Attio');
    
    if (attioFolder) {
      attioFolder.includePeers.push(chatId);
      await client.updateDialogFilter({
        id: attioFolder.id,
        filter: attioFolder
      });
    }
  }
  
  async watchFolderChanges(client: TelegramUserClient, callback: Function) {
    client.addEventHandler(async (update) => {
      if (update instanceof UpdateDialogFilter) {
        const folder = update.filter;
        if (folder.title === 'Attio') {
          await callback(folder);
        }
      }
    });
  }
}
```

### Phase 3: Advanced Features (Week 5-6)

#### 3.1 Smart Sync Rules
```typescript
interface SyncRule {
  id: string;
  name: string;
  conditions: {
    folders?: string[];
    keywords?: string[];
    senders?: string[];
    chatTypes?: ('private' | 'group' | 'channel')[];
    dateRange?: { start: Date; end: Date };
  };
  actions: {
    syncToAttio: boolean;
    createTask?: boolean;
    assignTo?: string;
    addTags?: string[];
  };
}

class SyncRuleEngine {
  async evaluateRules(message: Message): Promise<SyncAction[]> {
    const rules = await this.loadRules();
    const actions: SyncAction[] = [];
    
    for (const rule of rules) {
      if (this.matchesConditions(message, rule.conditions)) {
        actions.push(...this.createActions(rule.actions));
      }
    }
    
    return actions;
  }
}
```

#### 3.2 Bidirectional Sync
```typescript
class BidirectionalSync {
  async sendFromAttio(message: AttioMessage) {
    const client = this.getClient(message.userId);
    const chat = await this.resolveChatId(message.recipientId);
    
    // Send via User API (appears as user, not bot)
    const sentMessage = await client.sendMessage(chat, {
      message: message.text,
      file: message.attachment
    });
    
    // Update Attio with sent message
    await this.createAttioNote({
      direction: 'outgoing',
      message: sentMessage,
      timestamp: new Date()
    });
  }
  
  async handleAttioUpdate(update: AttioUpdate) {
    // Listen for changes in Attio and sync to Telegram
    if (update.type === 'note_created' && update.source !== 'telegram') {
      await this.sendFromAttio(update.note);
    }
  }
}
```

### Phase 4: UI/UX Enhancements (Week 7-8)

#### 4.1 Configuration Widget
```typescript
export const TelegramConfigWidget = {
  name: 'Telegram Sync Settings',
  
  ui: ({ context, record }: any) => {
    return (
      <div className="telegram-config">
        <AuthenticationSection>
          <PhoneInput />
          <VerificationCode />
          <SessionStatus />
        </AuthenticationSection>
        
        <FolderManagement>
          <FolderList />
          <CreateFolder name="Attio" />
          <SyncRules />
        </FolderManagement>
        
        <SmartSync>
          <BusinessDetection enabled={true} />
          <KeywordFilters />
          <AutoArchive />
        </SmartSync>
        
        <SyncStatus>
          <LastSync />
          <MessageCount />
          <SyncButton />
        </SyncStatus>
      </div>
    );
  }
};
```

#### 4.2 Enhanced Conversation Widget
```typescript
export const EnhancedConversationWidget = {
  ui: ({ context, chat }: any) => {
    return (
      <div className="conversation">
        <ChatHeader>
          <Avatar src={chat.photo} />
          <Title>{chat.title}</Title>
          <FolderBadge>{chat.folder}</FolderBadge>
          <SyncStatus />
        </ChatHeader>
        
        <MessageList>
          {/* Full message history with search */}
          <SearchBar />
          <Messages threadView={true} />
          <LoadMore />
        </MessageList>
        
        <Composer>
          <RichTextEditor />
          <FileAttachment />
          <SendOptions>
            <SendAsUser /> {/* Not as bot! */}
            <ScheduleSend />
          </SendOptions>
        </Composer>
        
        <ChatActions>
          <AddToFolder />
          <ExportChat />
          <ArchiveChat />
        </ChatActions>
      </div>
    );
  }
};
```

### Phase 5: Migration & Deployment (Week 9-10)

#### 5.1 Migration Strategy
```typescript
class MigrationService {
  async migrateFromBotToUser(workspaceId: string) {
    // Step 1: Maintain bot for backward compatibility
    const botChats = await this.getBotManagedChats();
    
    // Step 2: Prompt users to authenticate
    await this.sendMigrationNotice(workspaceId);
    
    // Step 3: Gradual migration
    for (const user of workspace.users) {
      if (await user.hasAuthenticated()) {
        // Migrate their chats to User API
        await this.migrateUserChats(user);
        
        // Keep bot as fallback
        await this.setupDualMode(user);
      }
    }
    
    // Step 4: Deprecate bot after full migration
    await this.scheduleBotDeprecation(workspaceId);
  }
}
```

#### 5.2 Security Implementation
```typescript
class SecurityManager {
  // Encrypted credential storage
  async storeCredentials(userId: string, credentials: TelegramAuth) {
    const encrypted = await this.encrypt(credentials);
    await attio.vault.store(`telegram_${userId}`, encrypted);
  }
  
  // Session rotation
  async rotateSession(userId: string) {
    const client = this.getClient(userId);
    const newSession = await client.regenerateSession();
    await this.storeSession(userId, newSession);
  }
  
  // Access control
  async validateAccess(userId: string, chatId: string): boolean {
    const client = this.getClient(userId);
    const userChats = await client.getDialogs();
    return userChats.some(chat => chat.id === chatId);
  }
}
```

---

## Performance Optimization

### Caching Strategy
```typescript
class CacheManager {
  private messageCache: LRUCache<string, Message>;
  private chatCache: Map<string, Chat>;
  
  async getCachedOrFetch(key: string, fetcher: Function) {
    if (this.messageCache.has(key)) {
      return this.messageCache.get(key);
    }
    
    const data = await fetcher();
    this.messageCache.set(key, data);
    return data;
  }
}
```

### Batch Processing
```typescript
class BatchProcessor {
  async processBatch(messages: Message[], batchSize = 50) {
    const batches = chunk(messages, batchSize);
    
    for (const batch of batches) {
      await Promise.all(
        batch.map(msg => this.processMessage(msg))
      );
      
      // Rate limiting
      await this.delay(1000);
    }
  }
}
```

---

## Testing Strategy

### Unit Tests
```typescript
describe('TelegramUserSync', () => {
  test('authenticates user successfully', async () => {
    const client = new TelegramUserClient(mockAuth);
    await expect(client.connect()).resolves.toBe(true);
  });
  
  test('syncs folder contents', async () => {
    const messages = await syncFolder('Attio');
    expect(messages.length).toBeGreaterThan(0);
  });
  
  test('detects business conversations', () => {
    const isB Business = isBusinessRelated(mockDialog);
    expect(isBusiness).toBe(true);
  });
});
```

### Integration Tests
```typescript
describe('End-to-end sync', () => {
  test('full sync cycle', async () => {
    // 1. Authenticate
    await authenticate(testUser);
    
    // 2. Create folder
    await createFolder('Attio');
    
    // 3. Add chat to folder
    await addChatToFolder(testChat);
    
    // 4. Verify sync
    const attioNotes = await getAttioNotes(testChat);
    expect(attioNotes.length).toEqual(testChat.messageCount);
  });
});
```

---

## Rollout Plan

### Beta Phase (Month 1)
- Internal testing with team accounts
- 5-10 beta customers
- Focus on folder sync functionality

### Limited Release (Month 2)
- 50 customers
- Both Bot and User API available
- Gather feedback on UX

### General Availability (Month 3)
- Full release
- Migration tools for Bot users
- Complete documentation

---

## Success Metrics

### Key Performance Indicators
1. **Sync Reliability**: 99.9% message delivery
2. **Sync Speed**: < 2 seconds per message
3. **User Adoption**: 80% enable User API within 30 days
4. **Folder Usage**: Average 3 folders per user
5. **Message Volume**: 10,000+ messages/day synced

### User Experience Metrics
1. **Setup Time**: < 5 minutes from install to first sync
2. **Manual Actions**: 0 manual links required
3. **History Access**: 100% of messages available
4. **Search Success**: 95% find rate for queries

---

## Cost Estimates

### Development Resources
- 2 engineers × 10 weeks = 20 engineer-weeks
- 1 designer × 2 weeks = 2 designer-weeks
- 1 PM × 10 weeks (part-time) = 5 PM-weeks

### Infrastructure
- Telegram API costs: Free
- Session storage: ~$50/month
- Message caching: ~$100/month
- Total: < $200/month operational costs

---

## Conclusion

The User API approach transforms Tellatio from a basic bot integration into a powerful, email-like experience for managing Telegram conversations in Attio. By implementing folder-based sync and automatic chat discovery, we eliminate the friction of manual setup while providing users with complete control over their business communications.

This architecture provides:
- ✅ Natural, email-like workflow
- ✅ Zero manual configuration
- ✅ Full conversation history
- ✅ Smart business chat detection
- ✅ Seamless bidirectional sync

The phased approach ensures we can deliver value incrementally while maintaining backward compatibility with the existing bot implementation.