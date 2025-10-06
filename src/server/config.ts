import { z } from 'zod';

const configSchema = z.object({
  telegramBotToken: z.string().min(1),
  telegramWebhookSecret: z.string().min(1),
  s3Bucket: z.string().optional(),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsRegion: z.string().default('us-east-1'),
});

export type Config = z.infer<typeof configSchema>;

export function getConfig(): Config {
  const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    s3Bucket: process.env.S3_BUCKET,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsRegion: process.env.AWS_REGION || 'us-east-1',
  };

  return configSchema.parse(config);
}