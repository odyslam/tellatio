# Telegram User API Setup Guide

## Prerequisites

1. **Get Telegram API Credentials**
   - Go to https://my.telegram.org/apps
   - Log in with your phone number
   - Create a new application
   - Copy your `api_id` and `api_hash`

2. **Configure Environment Variables**
   ```bash
   # Copy the example file
   cp .env.example .env
   
   # Edit .env and add your credentials:
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   
   # Generate an encryption key for session storage
   openssl rand -hex 16
   # Add to .env as:
   TELEGRAM_SESSION_KEY=your_generated_key
   ```

## Testing the Integration

1. **Start Development Server**
   ```bash
   pnpm run dev
   ```

2. **Install in Attio**
   - Press `i` when prompted to install to your Attio workspace
   - Navigate to any Person record in Attio
   - Press `CMD+K` to open command palette
   - Search for "Connect Telegram Account"
   - Follow the authentication flow

## Authentication Flow

1. **Phone Number**: Enter your Telegram phone number with country code (e.g., +1234567890)
2. **Verification Code**: Check your Telegram app for the code
3. **Configure Sync**: Choose how to sync your chats:
   - **Smart Detection**: Auto-detects business conversations
   - **Folder-based**: Only syncs chats in specific folders
   - **Manual Selection**: Choose specific chats to sync

## Privacy & Security

- Personal chats are excluded by default
- Session data is encrypted before storage
- Only business-related keywords trigger sync
- You can manually exclude any chat

## Troubleshooting

### "Telegram API credentials not configured"
- Ensure `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are set in .env

### "Session expired"
- Authentication sessions expire after 10 minutes
- Start the process again if it times out

### "Failed to sync chats"
- Check that your Telegram account has 2FA disabled (temporary limitation)
- Ensure you have internet connectivity
- Check the console logs for detailed errors

## Next Steps

After successful authentication:
1. Chats will be synced based on your configuration
2. New messages will appear as Notes in Attio
3. Personal chats in groups will be created as Person records
4. Group chats will be created as Telegram Chat records

## API Rate Limits

- Initial sync: Up to 100 chats
- Messages per chat: 50 most recent
- Real-time updates: Coming soon