import axios from 'axios';
import { getConfig } from './config';
import type { TelegramMessage } from '../types/telegram.types';

export class TelegramAPI {
  private baseUrl: string;
  private token: string;

  constructor(token?: string) {
    this.token = token || getConfig().telegramBotToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    try {
      const response = await axios.post(`${this.baseUrl}/setWebhook`, {
        url,
        secret_token: secretToken,
        drop_pending_updates: true,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
      });
      
      return response.data.ok === true;
    } catch (error) {
      console.error('Failed to set webhook:', error);
      return false;
    }
  }

  async deleteWebhook(): Promise<boolean> {
    try {
      const response = await axios.post(`${this.baseUrl}/deleteWebhook`);
      return response.data.ok === true;
    } catch (error) {
      console.error('Failed to delete webhook:', error);
      return false;
    }
  }

  async sendMessage(chatId: string | number, text: string, options?: any): Promise<TelegramMessage | null> {
    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...options,
      });
      
      return response.data.ok ? response.data.result : null;
    } catch (error) {
      console.error('Failed to send message:', error);
      return null;
    }
  }

  async sendPhoto(chatId: string | number, photo: string, caption?: string): Promise<TelegramMessage | null> {
    try {
      const response = await axios.post(`${this.baseUrl}/sendPhoto`, {
        chat_id: chatId,
        photo,
        caption,
        parse_mode: 'Markdown',
      });
      
      return response.data.ok ? response.data.result : null;
    } catch (error) {
      console.error('Failed to send photo:', error);
      return null;
    }
  }

  async sendDocument(chatId: string | number, document: string, caption?: string): Promise<TelegramMessage | null> {
    try {
      const response = await axios.post(`${this.baseUrl}/sendDocument`, {
        chat_id: chatId,
        document,
        caption,
        parse_mode: 'Markdown',
      });
      
      return response.data.ok ? response.data.result : null;
    } catch (error) {
      console.error('Failed to send document:', error);
      return null;
    }
  }

  async getFile(fileId: string): Promise<{ file_path?: string } | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/getFile`, {
        params: { file_id: fileId },
      });
      
      return response.data.ok ? response.data.result : null;
    } catch (error) {
      console.error('Failed to get file:', error);
      return null;
    }
  }

  async downloadFile(filePath: string): Promise<Buffer | null> {
    try {
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
      });
      
      return Buffer.from(response.data);
    } catch (error) {
      console.error('Failed to download file:', error);
      return null;
    }
  }

  async getWebhookInfo(): Promise<any> {
    try {
      const response = await axios.get(`${this.baseUrl}/getWebhookInfo`);
      return response.data.result;
    } catch (error) {
      console.error('Failed to get webhook info:', error);
      return null;
    }
  }
}