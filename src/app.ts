export default {
  name: 'Telegram Integration',
  description: 'Connect Telegram conversations to Attio for seamless customer communication',
  
  // Connection configuration
  connections: [
    {
      slug: 'telegram',
      name: 'Telegram Bot',
      description: 'Connect your Telegram bot to sync conversations',
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

  // Event handlers
  events: {
    'connection-added': './events/connection-added.event',
    'connection-removed': './events/connection-removed.event',
  },

  // Webhook handlers
  webhooks: {
    telegram: './webhooks/telegram.webhook',
  },

  // Actions available on records
  actions: [
    {
      file: './actions/send-telegram-message.action',
      availableOn: ['people', 'telegram_chats'],
    },
    {
      file: './actions/generate-telegram-link.action',
      availableOn: ['people', 'companies'],
    },
  ],

  // Widgets on record pages
  widgets: [
    {
      file: './widgets/telegram-conversation.widget',
      availableOn: ['people', 'telegram_chats'],
    },
  ],
};