import type { EventHandler } from 'attio';
import { TelegramAPI } from '../server/telegram-api';

export const connectionRemovedEvent: EventHandler<'connection-removed'> = {
  async run(event, context) {
    try {
      const { connectionId, connectionSlug, credentials } = event.payload;
      
      if (connectionSlug !== 'telegram') {
        return;
      }

      const botToken = credentials?.bot_token as string;
      if (botToken) {
        const telegramApi = new TelegramAPI(botToken);
        await telegramApi.deleteWebhook();
        console.log('Successfully removed Telegram webhook for connection:', connectionId);
      }
    } catch (error) {
      console.error('Failed to remove Telegram webhook:', error);
    }
  },
};