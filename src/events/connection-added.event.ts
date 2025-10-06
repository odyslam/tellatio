import { TelegramAPI } from '../server/telegram-api';
import { getConfig } from '../server/config';

export const connectionAddedEvent = {
  async run(event: any, context: any) {
    try {
      const { connectionId, connectionSlug, credentials } = event.payload;
      
      if (connectionSlug !== 'telegram') {
        return;
      }

      const botToken = credentials?.bot_token as string;
      if (!botToken) {
        throw new Error('Bot token not provided in connection credentials');
      }

      const webhookHandler = await context.createWebhookHandler({
        fileName: 'telegram',
      });

      if (!webhookHandler.url) {
        throw new Error('Failed to create webhook handler');
      }

      const telegramApi = new TelegramAPI(botToken);
      const secretToken = getConfig().telegramWebhookSecret;
      
      const success = await telegramApi.setWebhook(webhookHandler.url, secretToken);
      
      if (!success) {
        throw new Error('Failed to register webhook with Telegram');
      }

      await context.updateWebhookHandler(webhookHandler.id, {
        externalWebhookId: connectionId,
        metadata: {
          botToken: botToken.substring(0, 10) + '...',
          webhookUrl: webhookHandler.url,
          registeredAt: new Date().toISOString(),
        },
      });

      console.log('Successfully registered Telegram webhook:', {
        connectionId,
        webhookUrl: webhookHandler.url,
      });
    } catch (error) {
      console.error('Failed to set up Telegram connection:', error);
      throw error;
    }
  },
};