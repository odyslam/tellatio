import React, { useState, useEffect } from 'react';
import type { Action } from 'attio';
import { z } from 'zod';

const configSchema = z.object({
  recordType: z.enum(['people', 'companies']),
});

const generateLinkSchema = z.object({
  linkType: z.enum(['personal', 'group']),
});

export const generateTelegramLinkAction: Action<
  z.infer<typeof configSchema>,
  z.infer<typeof generateLinkSchema>
> = {
  slug: 'generate-telegram-link',
  name: 'Generate Telegram Link',
  description: 'Generate a link to connect this record with Telegram',
  config: configSchema,
  input: generateLinkSchema,
  
  async canRun({ config, record }) {
    if (config.recordType === 'people') {
      return !record.values?.telegram_user_id;
    } else if (config.recordType === 'companies') {
      return true;
    }
    return false;
  },

  ui: ({ input, setInput, record, config }) => {
    const [linkUrl, setLinkUrl] = useState<string>('');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
      if (input?.linkType) {
        generateLink();
      }
    }, [input?.linkType]);

    const generateLink = () => {
      const botUsername = 'TellatioBot'; // Replace with actual bot username
      
      if (input?.linkType === 'personal' && config.recordType === 'people') {
        const token = Buffer.from(JSON.stringify({
          personId: record.id.record_id,
          timestamp: Date.now(),
        })).toString('base64');
        
        setLinkUrl(`https://t.me/${botUsername}?start=${token}`);
      } else if (input?.linkType === 'group' && config.recordType === 'companies') {
        const companyId = record.id.record_id;
        setLinkUrl(`https://t.me/${botUsername}?startgroup=${companyId}`);
      }
    };

    const copyToClipboard = () => {
      navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <div className="p-4 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">
            Link Type
          </label>
          <select
            value={input?.linkType || ''}
            onChange={(e) => setInput({ linkType: e.target.value as 'personal' | 'group' })}
            className="w-full p-2 border rounded-md"
          >
            <option value="">Select link type...</option>
            {config.recordType === 'people' && (
              <option value="personal">Personal Chat Link</option>
            )}
            {config.recordType === 'companies' && (
              <option value="group">Group Chat Link</option>
            )}
          </select>
        </div>

        {linkUrl && (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              Generated Link
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={linkUrl}
                readOnly
                className="flex-1 p-2 border rounded-md bg-gray-50"
              />
              <button
                onClick={copyToClipboard}
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
              >
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            
            <div className="mt-4 p-3 bg-blue-50 rounded-md">
              <p className="text-sm text-blue-800">
                {input?.linkType === 'personal' ? (
                  <>
                    <strong>Instructions:</strong> Send this link to the person. 
                    When they click it and start the bot, their Telegram account 
                    will be connected to their Attio profile.
                  </>
                ) : (
                  <>
                    <strong>Instructions:</strong> Use this link to add the bot to 
                    a Telegram group. The group will be automatically linked to 
                    this company.
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  },

  async run({ input, record }) {
    const botUsername = 'TellatioBot'; // Replace with actual bot username
    let link: string;
    
    if (input.linkType === 'personal') {
      const token = Buffer.from(JSON.stringify({
        personId: record.id.record_id,
        timestamp: Date.now(),
      })).toString('base64');
      
      link = `https://t.me/${botUsername}?start=${token}`;
    } else {
      link = `https://t.me/${botUsername}?startgroup=${record.id.record_id}`;
    }

    return {
      success: true,
      link,
      expiresIn: '1 hour',
    };
  },
};