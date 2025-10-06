import type { App } from 'attio';

import { connectionAddedEvent } from './events/connection-added.event';
import { connectionRemovedEvent } from './events/connection-removed.event';
import { telegramWebhook } from './webhooks/telegram.webhook';
import { sendTelegramMessageAction } from './actions/send-telegram-message.action';
import { generateTelegramLinkAction } from './actions/generate-telegram-link.action';
import { telegramConversationWidget } from './widgets/telegram-conversation.widget';

const app: App = {
  name: 'Telegram Integration',
  slug: 'telegram-integration',
  description: 'Connect Telegram conversations to Attio for seamless customer communication',
  icon: 'telegram-icon',
  
  connections: [
    {
      slug: 'telegram',
      name: 'Telegram Bot',
      description: 'Connect your Telegram bot to Attio',
      fields: [
        {
          slug: 'bot_token',
          name: 'Bot Token',
          type: 'password',
          required: true,
          description: 'Get this from @BotFather on Telegram',
        },
      ],
    },
  ],

  events: {
    'connection-added': connectionAddedEvent,
    'connection-removed': connectionRemovedEvent,
  },

  webhooks: {
    telegram: telegramWebhook,
  },

  actions: [
    {
      ...sendTelegramMessageAction,
      config: { recordType: 'people' },
      availableOn: ['people'],
    },
    {
      ...sendTelegramMessageAction,
      config: { recordType: 'telegram_chats' },
      availableOn: ['telegram_chats'],
    },
    {
      ...generateTelegramLinkAction,
      config: { recordType: 'people' },
      availableOn: ['people'],
    },
    {
      ...generateTelegramLinkAction,
      config: { recordType: 'companies' },
      availableOn: ['companies'],
    },
  ],

  widgets: [
    {
      ...telegramConversationWidget,
      config: { recordType: 'people' },
      availableOn: ['people'],
    },
    {
      ...telegramConversationWidget,
      config: { recordType: 'telegram_chats' },
      availableOn: ['telegram_chats'],
    },
  ],

  customObjects: [
    {
      slug: 'telegram_chats',
      name: 'Telegram Chats',
      singularName: 'Telegram Chat',
      icon: 'chat',
      attributes: [
        {
          slug: 'chat_id',
          name: 'Chat ID',
          type: 'text',
          unique: true,
          required: true,
        },
        {
          slug: 'title',
          name: 'Title',
          type: 'text',
        },
        {
          slug: 'type',
          name: 'Type',
          type: 'select',
          options: [
            { value: 'private', label: 'Private' },
            { value: 'group', label: 'Group' },
            { value: 'supergroup', label: 'Supergroup' },
            { value: 'channel', label: 'Channel' },
          ],
        },
        {
          slug: 'company',
          name: 'Company',
          type: 'relationship',
          relationshipTo: 'companies',
        },
      ],
    },
  ],

  peopleAttributes: [
    {
      slug: 'telegram_user_id',
      name: 'Telegram User ID',
      type: 'text',
      unique: true,
    },
    {
      slug: 'telegram_username',
      name: 'Telegram Username',
      type: 'text',
    },
    {
      slug: 'telegram_first_name',
      name: 'Telegram First Name',
      type: 'text',
    },
    {
      slug: 'telegram_last_name',
      name: 'Telegram Last Name',
      type: 'text',
    },
  ],

  companyAttributes: [
    {
      slug: 'default_telegram_chat',
      name: 'Default Telegram Chat',
      type: 'relationship',
      relationshipTo: 'telegram_chats',
    },
  ],

  scopes: [
    'object_configuration:read',
    'record_permission:read-write',
    'note:read-write',
    'task:read-write',
    'user_management:read',
  ],
};

export default app;