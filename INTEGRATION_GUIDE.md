# Attio-Telegram Integration Guide

## Overview
This integration connects Telegram conversations to Attio, enabling seamless customer communication tracking and management.

## Features
- ✅ Log Telegram messages as Notes in Attio
- ✅ Send messages from Attio to Telegram
- ✅ Connect Telegram users to People records
- ✅ Link Telegram groups to Companies
- ✅ View conversation history in record widgets
- ✅ Deep linking for easy account connection
- ✅ Automated task creation based on keywords
- ✅ File attachment support

## Setup Instructions

### 1. Install the App
```bash
pnpm run dev
# Press 'i' to open app settings and install in your workspace
```

### 2. Configure the Telegram Bot
The bot token is already configured: `@tellatio_bot`

To connect the bot to Attio:
1. Go to Connections in Attio
2. Add a new Telegram connection
3. Enter the bot token: `7805057774:AAEoyNQYUNXFnBmhLEO3HfJjwP_AZe4Rd5w`

### 3. Test the Integration

#### Send a message to the bot:
1. Open Telegram
2. Search for `@tellatio_bot`
3. Send a test message
4. Check Attio People records for the new conversation

#### Link a Person to Telegram:
1. Open a Person record in Attio
2. Use the "Generate Telegram Link" action
3. Send the link to the person
4. They click it to connect their Telegram account

#### Add bot to a group:
1. Open a Company record in Attio
2. Use the "Generate Telegram Link" action for groups
3. Use the link to add the bot to a Telegram group
4. The group will be linked to the company

## Architecture

### Data Model
- **People**: Extended with Telegram user fields (telegram_user_id, telegram_username, etc.)
- **Companies**: Can have a default_telegram_chat relationship
- **Telegram Chats**: Custom object for group/channel management

### Components
- **Webhook Handler** (`src/webhooks/telegram.webhook.ts`): Processes incoming Telegram messages
- **Message Processor** (`src/server/message-processor.ts`): Handles message logic and Attio updates
- **Send Message Action** (`src/actions/send-telegram-message.action.tsx`): Send messages from Attio
- **Conversation Widget** (`src/widgets/telegram-conversation.widget.tsx`): View chat history
- **Link Generator** (`src/actions/generate-telegram-link.action.tsx`): Create connection links

## Testing

Run the test scripts:
```bash
# Test bot connection
node test-telegram.js

# Send a test message (requires a chat ID from previous messages)
node test-send.js
```

## Development

### Build the app
```bash
pnpm run build
```

### Run development server
```bash
pnpm run dev
```

### Run tests
```bash
pnpm test
```

## Troubleshooting

### Webhook not receiving messages
1. Check webhook info: `node test-telegram.js`
2. Ensure the bot token is correct in the connection
3. Verify the webhook URL is accessible

### Messages not appearing in Attio
1. Check the dev server console for errors
2. Verify the Attio API permissions
3. Ensure custom objects are created in the workspace

### Bot can't see group messages
1. Disable privacy mode in BotFather
2. Or make the bot an admin in the group

## Security Notes
- Bot token is stored securely in Attio Connections
- Webhook validates secret token
- Files are re-hosted (S3/GCS recommended for production)
- All Telegram IDs are treated as strings to prevent precision loss

## Next Steps for Production
1. Configure S3/GCS for file storage
2. Set up proper error monitoring
3. Implement rate limiting
4. Add more sophisticated automation rules
5. Create webhook signature verification