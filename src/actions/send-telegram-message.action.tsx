import { useState } from 'react';
import { z } from 'zod';

const configSchema = z.object({
  recordType: z.enum(['people', 'telegram_chats']),
});

const sendMessageSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  attachmentUrl: z.string().url().optional(),
});

export const sendTelegramMessageAction = {
  slug: 'send-telegram-message',
  name: 'Send Telegram Message',
  description: 'Send a message via Telegram to this person or chat',
  config: configSchema,
  input: sendMessageSchema,
  
  async canRun({ config, context, record }: any) {
    if (config.recordType === 'people') {
      const telegramUserId = record.values?.telegram_user_id;
      return !!telegramUserId;
    } else if (config.recordType === 'telegram_chats') {
      const chatId = record.values?.chat_id;
      return !!chatId;
    }
    return false;
  },

  ui: ({ input, setInput, isValid }: any) => {
    const [message, setMessage] = useState(input?.message || '');
    const [attachmentUrl, setAttachmentUrl] = useState(input?.attachmentUrl || '');

    const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newMessage = e.target.value;
      setMessage(newMessage);
      setInput({ 
        message: newMessage, 
        attachmentUrl: attachmentUrl || undefined 
      });
    };

    const handleAttachmentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newUrl = e.target.value;
      setAttachmentUrl(newUrl);
      setInput({ 
        message, 
        attachmentUrl: newUrl || undefined 
      });
    };

    return (
      <div className="p-4 space-y-4">
        <div>
          <label htmlFor="message" className="block text-sm font-medium mb-2">
            Message
          </label>
          <textarea
            id="message"
            value={message}
            onChange={handleMessageChange}
            className="w-full p-2 border rounded-md"
            rows={5}
            placeholder="Type your message..."
          />
        </div>
        
        <div>
          <label htmlFor="attachment" className="block text-sm font-medium mb-2">
            Attachment URL (optional)
          </label>
          <input
            id="attachment"
            type="url"
            value={attachmentUrl}
            onChange={handleAttachmentChange}
            className="w-full p-2 border rounded-md"
            placeholder="https://example.com/file.pdf"
          />
        </div>

        {message && (
          <div className="mt-4 p-3 bg-gray-50 rounded-md">
            <p className="text-sm font-medium mb-1">Preview:</p>
            <p className="text-sm whitespace-pre-wrap">{message}</p>
            {attachmentUrl && (
              <p className="text-sm text-blue-600 mt-2">
                📎 <a href={attachmentUrl} target="_blank" rel="noopener noreferrer">
                  {attachmentUrl}
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    );
  },

  async run({ input, config, context, record }: any) {
    const { TelegramAPI } = await import('../server/telegram-api');
    const { AttioAPI } = await import('../server/attio-api');
    
    const telegramApi = new TelegramAPI();
    const attioApi = new AttioAPI(context);
    
    let chatId: string | number;
    let recipientName: string;
    
    if (config.recordType === 'people') {
      const telegramUserId = record.values?.telegram_user_id;
      if (!telegramUserId) {
        throw new Error('Person does not have a Telegram ID');
      }
      chatId = telegramUserId;
      recipientName = record.values?.name || 'Unknown Person';
    } else {
      const telegramChatId = record.values?.chat_id;
      if (!telegramChatId) {
        throw new Error('Chat does not have a Telegram ID');
      }
      chatId = telegramChatId;
      recipientName = record.values?.title || 'Unknown Chat';
    }

    let fullMessage = input.message;
    if (input.attachmentUrl) {
      fullMessage += `\n\n📎 [Attachment](${input.attachmentUrl})`;
    }

    const sentMessage = await telegramApi.sendMessage(chatId, fullMessage);
    
    if (!sentMessage) {
      throw new Error('Failed to send message');
    }

    const timestamp = new Date(sentMessage.date * 1000).toISOString();
    await attioApi.createNote({
      parent_object: config.recordType,
      parent_record_id: record.id.record_id,
      title: `Telegram • outgoing • ${recipientName}`,
      content: `${input.message}${input.attachmentUrl ? `\n\n📎 [Attachment](${input.attachmentUrl})` : ''}\n\n---\n_Message ID: ${sentMessage.message_id}_\n_Sent at: ${timestamp}_`,
      format: 'markdown',
      created_at: timestamp,
    });

    return {
      success: true,
      messageId: sentMessage.message_id,
    };
  },
};