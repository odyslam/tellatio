import type { WebhookHandler } from 'attio';
import type { TelegramWebhookData } from '../types/telegram.types';
import { MessageProcessor } from '../server/message-processor';
import { getConfig } from '../server/config';

export const telegramWebhook: WebhookHandler = {
  async handleRequest(request, context) {
    try {
      const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      const expectedSecret = getConfig().telegramWebhookSecret;
      
      if (secretToken !== expectedSecret) {
        console.error('Invalid secret token received');
        return new Response('Unauthorized', { status: 401 });
      }

      const update = await request.json() as TelegramWebhookData;
      console.log('Received Telegram update:', JSON.stringify(update, null, 2));

      const processor = new MessageProcessor(context);
      
      const message = update.message || update.edited_message;
      if (message?.text?.startsWith('/start')) {
        const token = message.text.split(' ')[1];
        await processor.processStartCommand(message, token);
      } else if (message?.new_chat_members) {
        const urlParams = new URL(request.url).searchParams;
        const companyId = urlParams.get('company_id');
        await processor.processGroupAdd(message, companyId || undefined);
      } else {
        await processor.processUpdate(update);
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook handler error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};