import { TelegramUserClient, TelegramAuthConfig, ChatSyncConfig } from './telegram-user-client-browser';
import { AttioAPI } from './attio-api';
import { TelegramSyncEngine } from './telegram-sync-engine';
import { encrypt, decrypt } from '../lib/encryption';

// Store active authentication sessions temporarily
const authSessions = new Map<string, {
  client: TelegramUserClient;
  phoneNumber: string;
  recordId: string;
  timestamp: number;
}>();

// Clean up old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of authSessions.entries()) {
    if (now - session.timestamp > 10 * 60 * 1000) { // 10 minutes
      authSessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

export async function startAuthentication(req: any, res: any) {
  try {
    const { phoneNumber, recordId } = req.body;
    
    if (!phoneNumber || !recordId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Get API credentials from environment or Attio settings
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    
    if (!apiId || !apiHash) {
      return res.status(500).json({ error: 'Telegram API credentials not configured' });
    }
    
    // Create client with initial config
    const config: TelegramAuthConfig = {
      apiId,
      apiHash,
      phoneNumber,
    };
    
    const syncConfig: ChatSyncConfig = {
      mode: 'smart',
      autoDetectBusiness: true,
      syncGroups: true,
    };
    
    const client = new TelegramUserClient(config, syncConfig);
    
    // Connect and start authentication
    const status = await client.connect();
    
    if (status === 'CONNECTED') {
      return res.status(400).json({ error: 'Already authenticated' });
    }
    
    // Store session
    const sessionKey = `${phoneNumber}-${recordId}`;
    authSessions.set(sessionKey, {
      client,
      phoneNumber,
      recordId,
      timestamp: Date.now(),
    });
    
    // Request code to be sent
    await client.authenticate(async () => {
      // This callback will be called when code is needed
      // We'll handle this in the verify endpoint
      return '';
    }).catch(() => {
      // Expected - will wait for code
    });
    
    return res.json({ success: true, message: 'Code sent' });
  } catch (error) {
    console.error('Auth start error:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Authentication failed' 
    });
  }
}

export async function verifyCode(req: any, res: any) {
  try {
    const { phoneNumber, code, recordId } = req.body;
    
    if (!phoneNumber || !code || !recordId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const sessionKey = `${phoneNumber}-${recordId}`;
    const session = authSessions.get(sessionKey);
    
    if (!session) {
      return res.status(400).json({ error: 'Session expired. Please start over.' });
    }
    
    // Complete authentication with code
    const sessionString = await session.client.authenticate(async () => code);
    
    // Store encrypted session in Attio record metadata
    const attioApi = new AttioAPI(process.env.ATTIO_API_KEY || '');
    const encryptedSession = encrypt(sessionString);
    
    // Store session in record
    await attioApi.updateRecord('people', recordId, {
      telegram_session: encryptedSession,
      telegram_phone: phoneNumber,
      telegram_connected: true,
      telegram_connected_at: new Date().toISOString(),
    });
    
    return res.json({ success: true, sessionStored: true });
  } catch (error) {
    console.error('Code verification error:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Verification failed' 
    });
  }
}

export async function configureSyncSettings(req: any, res: any) {
  try {
    const { recordId, syncConfig } = req.body;
    
    if (!recordId || !syncConfig) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const attioApi = new AttioAPI(process.env.ATTIO_API_KEY || '');
    
    // Get stored session
    const record = await attioApi.getRecord('people', recordId);
    const encryptedSession = record.attributes.telegram_session;
    const phoneNumber = record.attributes.telegram_phone;
    
    if (!encryptedSession || !phoneNumber) {
      return res.status(400).json({ error: 'Not authenticated' });
    }
    
    // Decrypt session
    const sessionString = decrypt(encryptedSession);
    
    // Create client with stored session
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    
    const authConfig: TelegramAuthConfig = {
      apiId,
      apiHash,
      phoneNumber,
      sessionString,
    };
    
    const client = new TelegramUserClient(authConfig, syncConfig);
    await client.connect();
    
    // Start initial sync
    const syncEngine = new TelegramSyncEngine(client, attioApi, syncConfig);
    const stats = await syncEngine.performInitialSync();
    
    // Store sync config in record
    await attioApi.updateRecord('people', recordId, {
      telegram_sync_config: JSON.stringify(syncConfig),
      telegram_last_sync: new Date().toISOString(),
      telegram_sync_stats: JSON.stringify(stats),
    });
    
    // Set up real-time sync
    await syncEngine.setupRealtimeSync();
    
    // Clean up session
    const sessionKey = `${phoneNumber}-${recordId}`;
    authSessions.delete(sessionKey);
    
    return res.json({ 
      success: true, 
      stats,
      message: `Synced ${stats.syncedChats} chats, excluded ${stats.excludedChats} personal chats`
    });
  } catch (error) {
    console.error('Sync configuration error:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Configuration failed' 
    });
  }
}

// Webhook handler for real-time updates
export async function handleTelegramWebhook(req: any, res: any) {
  try {
    // const { recordId, update } = req.body;
    
    // This would handle real-time message updates
    // Implementation depends on how we set up the webhook with Telegram
    // TODO: Implement webhook processing
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}