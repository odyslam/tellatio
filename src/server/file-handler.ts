import { TelegramAPI } from './telegram-api';
import { nanoid } from 'nanoid';

export class FileHandler {
  async processFile(fileId: string, fileName: string, telegramApi: TelegramAPI): Promise<string | null> {
    try {
      const fileInfo = await telegramApi.getFile(fileId);
      if (!fileInfo || !fileInfo.file_path) {
        console.error('Failed to get file info:', fileId);
        return null;
      }

      const fileBuffer = await telegramApi.downloadFile(fileInfo.file_path);
      if (!fileBuffer) {
        console.error('Failed to download file:', fileInfo.file_path);
        return null;
      }

      const uploadedUrl = await this.uploadToStorage(fileBuffer, fileName);
      return uploadedUrl;
    } catch (error) {
      console.error('Failed to process file:', error);
      return null;
    }
  }

  private async uploadToStorage(buffer: Buffer, fileName: string): Promise<string> {
    const uniqueFileName = `${nanoid()}_${fileName}`;
    
    if (process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return await this.uploadToS3(buffer, uniqueFileName);
    } else {
      console.warn('S3 not configured, using temporary URL placeholder');
      return `https://files.tellatio.example/${uniqueFileName}`;
    }
  }

  private async uploadToS3(buffer: Buffer, fileName: string): Promise<string> {
    console.log(`Would upload ${fileName} to S3 (${buffer.length} bytes)`);
    return `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${fileName}`;
  }
}