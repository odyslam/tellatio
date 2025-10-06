import type { AttioContext } from 'attio';
import type {
  AttioPersonAttributes,
  AttioCompanyAttributes,
  AttioTelegramChatAttributes,
  AttioNoteData,
  AttioTaskData,
  AttioRecord,
} from '../types/attio.types';

export class AttioAPI {
  constructor(private context: AttioContext) {}

  async findPersonByTelegramId(telegramUserId: string): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch('/v2/objects/people/records/query', {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            telegram_user_id: {
              attribute: 'telegram_user_id',
              operator: 'equals',
              value: telegramUserId,
            },
          },
        }),
      });

      const data = await response.json();
      return data.data?.length > 0 ? data.data[0] : null;
    } catch (error) {
      console.error('Failed to find person by Telegram ID:', error);
      return null;
    }
  }

  async findPersonByUsername(username: string): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch('/v2/objects/people/records/query', {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            telegram_username: {
              attribute: 'telegram_username',
              operator: 'equals',
              value: username,
            },
          },
        }),
      });

      const data = await response.json();
      return data.data?.length > 0 ? data.data[0] : null;
    } catch (error) {
      console.error('Failed to find person by username:', error);
      return null;
    }
  }

  async upsertPerson(attributes: AttioPersonAttributes): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch('/v2/objects/people/records', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            values: attributes,
          },
        }),
      });

      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Failed to upsert person:', error);
      return null;
    }
  }

  async findTelegramChatByChatId(chatId: string): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch('/v2/objects/telegram_chats/records/query', {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            chat_id: {
              attribute: 'chat_id',
              operator: 'equals',
              value: chatId,
            },
          },
        }),
      });

      const data = await response.json();
      return data.data?.length > 0 ? data.data[0] : null;
    } catch (error) {
      console.error('Failed to find Telegram chat:', error);
      return null;
    }
  }

  async upsertTelegramChat(attributes: AttioTelegramChatAttributes): Promise<AttioRecord | null> {
    try {
      const existingChat = await this.findTelegramChatByChatId(attributes.chat_id);
      
      if (existingChat) {
        const response = await this.context.attioFetch(
          `/v2/objects/telegram_chats/records/${existingChat.id.record_id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              data: {
                values: attributes,
              },
            }),
          }
        );
        const data = await response.json();
        return data.data;
      } else {
        const response = await this.context.attioFetch('/v2/objects/telegram_chats/records', {
          method: 'POST',
          body: JSON.stringify({
            data: {
              values: attributes,
            },
          }),
        });
        const data = await response.json();
        return data.data;
      }
    } catch (error) {
      console.error('Failed to upsert Telegram chat:', error);
      return null;
    }
  }

  async createNote(noteData: AttioNoteData): Promise<any> {
    try {
      const response = await this.context.attioFetch('/v2/notes', {
        method: 'POST',
        body: JSON.stringify({
          data: noteData,
        }),
      });

      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Failed to create note:', error);
      return null;
    }
  }

  async createTask(taskData: AttioTaskData): Promise<any> {
    try {
      const response = await this.context.attioFetch('/v2/tasks', {
        method: 'POST',
        body: JSON.stringify({
          data: taskData,
        }),
      });

      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Failed to create task:', error);
      return null;
    }
  }

  async findCompanyById(companyId: string): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch(`/v2/objects/companies/records/${companyId}`, {
        method: 'GET',
      });

      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Failed to find company:', error);
      return null;
    }
  }

  async updatePersonTelegramId(personId: string, telegramUserId: string): Promise<AttioRecord | null> {
    try {
      const response = await this.context.attioFetch(`/v2/objects/people/records/${personId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            values: {
              telegram_user_id: telegramUserId,
            },
          },
        }),
      });

      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Failed to update person Telegram ID:', error);
      return null;
    }
  }

  async listNotesByParent(parentObject: string, parentRecordId: string, limit = 20): Promise<any[]> {
    try {
      const response = await this.context.attioFetch('/v2/notes/query', {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            parent_object: parentObject,
            parent_record_id: parentRecordId,
          },
          sorts: [
            {
              attribute: 'created_at',
              direction: 'desc',
            },
          ],
          limit,
        }),
      });

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error('Failed to list notes:', error);
      return [];
    }
  }
}