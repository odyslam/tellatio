import { useState, useEffect } from 'react';
import { z } from 'zod';

const configSchema = z.object({
  recordType: z.enum(['people', 'telegram_chats']),
});

interface Note {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

export const telegramConversationWidget = {
  slug: 'telegram-conversation',
  name: 'Telegram Conversation',
  description: 'View and send Telegram messages',
  config: configSchema,
  
  async canRender({ config, record }: any) {
    if (config.recordType === 'people') {
      return !!record.values?.telegram_user_id;
    } else if (config.recordType === 'telegram_chats') {
      return !!record.values?.chat_id;
    }
    return false;
  },

  ui: ({ context, record, config }: any) => {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);

    useEffect(() => {
      loadNotes();
    }, [record.id.record_id]);

    const loadNotes = async () => {
      try {
        setLoading(true);
        const response = await context.attioFetch('/v2/notes/query', {
          method: 'POST',
          body: JSON.stringify({
            filter: {
              parent_object: config.recordType,
              parent_record_id: record.id.record_id,
            },
            sorts: [
              {
                attribute: 'created_at',
                direction: 'desc',
              },
            ],
            limit: 20,
          }),
        });

        const data = await response.json();
        const telegramNotes = (data.data || []).filter((note: Note) => 
          note.title?.includes('Telegram')
        );
        setNotes(telegramNotes);
      } catch (error) {
        console.error('Failed to load notes:', error);
      } finally {
        setLoading(false);
      }
    };

    const sendMessage = async () => {
      if (!message.trim() || sending) return;
      
      setSending(true);
      try {
        const { TelegramAPI } = await import('../server/telegram-api');
        const { AttioAPI } = await import('../server/attio-api');
        
        const telegramApi = new TelegramAPI();
        const attioApi = new AttioAPI(context);
        
        let chatId: string | number;
        let recipientName: string;
        
        if (config.recordType === 'people') {
          chatId = record.values.telegram_user_id;
          recipientName = record.values.name || 'Unknown Person';
        } else {
          chatId = record.values.chat_id;
          recipientName = record.values.title || 'Unknown Chat';
        }

        const sentMessage = await telegramApi.sendMessage(chatId, message);
        
        if (sentMessage) {
          const timestamp = new Date(sentMessage.date * 1000).toISOString();
          await attioApi.createNote({
            parent_object: config.recordType,
            parent_record_id: record.id.record_id,
            title: `Telegram • outgoing • ${recipientName}`,
            content: `${message}\n\n---\n_Message ID: ${sentMessage.message_id}_\n_Sent at: ${timestamp}_`,
            format: 'markdown',
            created_at: timestamp,
          });
          
          setMessage('');
          await loadNotes();
        }
      } catch (error) {
        console.error('Failed to send message:', error);
        alert('Failed to send message. Please try again.');
      } finally {
        setSending(false);
      }
    };

    const formatDate = (dateStr: string) => {
      const date = new Date(dateStr);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    const getMessageDirection = (title: string) => {
      if (title?.includes('incoming')) return 'incoming';
      if (title?.includes('outgoing')) return 'outgoing';
      return 'unknown';
    };

    if (loading) {
      return (
        <div className="p-4 text-center">
          <p className="text-gray-500">Loading conversation...</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b bg-gray-50">
          <h3 className="font-semibold">Telegram Conversation</h3>
          <p className="text-sm text-gray-600">
            {notes.length} message{notes.length !== 1 ? 's' : ''}
          </p>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {notes.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              No Telegram messages yet
            </p>
          ) : (
            notes.map((note) => {
              const direction = getMessageDirection(note.title);
              const isIncoming = direction === 'incoming';
              
              return (
                <div
                  key={note.id}
                  className={`flex ${isIncoming ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-[70%] rounded-lg p-3 ${
                      isIncoming
                        ? 'bg-gray-100 text-gray-900'
                        : 'bg-blue-500 text-white'
                    }`}
                  >
                    <div className="text-sm whitespace-pre-wrap">
                      {note.content.split('\n---\n')[0]}
                    </div>
                    <div
                      className={`text-xs mt-1 ${
                        isIncoming ? 'text-gray-500' : 'text-blue-100'
                      }`}
                    >
                      {formatDate(note.created_at)}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        
        <div className="p-3 border-t bg-gray-50">
          <div className="flex gap-2">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Type a message..."
              className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={sending}
            />
            <button
              onClick={sendMessage}
              disabled={!message.trim() || sending}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {sending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    );
  },
};