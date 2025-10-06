import { useState } from 'react';

export function SyncConfigurationWizard({ onComplete }: any) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState({
    syncMode: 'smart', // 'all', 'folders', 'smart'
    folders: [],
    rules: {
      includeGroups: true,
      includeChannels: false,
      includeBots: false,
      autoDetectBusiness: true,
    },
    keywords: ['customer', 'client', 'meeting', 'contract', 'invoice', 'support'],
  });

  return (
    <div className="p-6 max-w-2xl">
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">How should we sync your Telegram chats?</h2>
          
          <div className="space-y-3">
            <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="smart"
                checked={config.syncMode === 'smart'}
                onChange={(e) => setConfig({...config, syncMode: e.target.value})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Smart Detection (Recommended)</div>
                <div className="text-sm text-gray-600">
                  Automatically detect business conversations using AI and keywords.
                  You can always override specific chats.
                </div>
              </div>
            </label>

            <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="folders"
                checked={config.syncMode === 'folders'}
                onChange={(e) => setConfig({...config, syncMode: e.target.value})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Folder-based</div>
                <div className="text-sm text-gray-600">
                  Only sync chats in specific Telegram folders (like "Work" or "Customers")
                </div>
              </div>
            </label>

            <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="manual"
                checked={config.syncMode === 'manual'}
                onChange={(e) => setConfig({...config, syncMode: e.target.value})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Manual Selection</div>
                <div className="text-sm text-gray-600">
                  Hand-pick which chats to sync (you can add more anytime)
                </div>
              </div>
            </label>
          </div>

          <button
            onClick={() => setStep(2)}
            className="w-full py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Continue
          </button>
        </div>
      )}

      {step === 2 && config.syncMode === 'smart' && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Configure Smart Detection</h2>
          
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-2">
                Business Keywords (comma-separated)
              </label>
              <textarea
                value={config.keywords.join(', ')}
                onChange={(e) => setConfig({
                  ...config,
                  keywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean)
                })}
                className="w-full p-2 border rounded-md"
                rows={3}
                placeholder="customer, client, meeting, invoice..."
              />
              <p className="text-xs text-gray-500 mt-1">
                Chats containing these keywords will be synced
              </p>
            </div>

            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.rules.includeGroups}
                  onChange={(e) => setConfig({
                    ...config,
                    rules: {...config.rules, includeGroups: e.target.checked}
                  })}
                  className="mr-2"
                />
                <span>Sync group chats</span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.rules.autoDetectBusiness}
                  onChange={(e) => setConfig({
                    ...config,
                    rules: {...config.rules, autoDetectBusiness: e.target.checked}
                  })}
                  className="mr-2"
                />
                <span>Use AI to detect business conversations</span>
              </label>
            </div>

            <div className="p-4 bg-yellow-50 rounded-lg">
              <p className="text-sm text-yellow-800">
                <strong>Privacy Note:</strong> Personal chats without business keywords 
                will NOT be synced. You can always manually exclude specific chats.
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setStep(1)}
              className="flex-1 py-2 border rounded-lg hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              className="flex-1 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Review Your Chats</h2>
          
          <div className="space-y-2 max-h-96 overflow-y-auto">
            <ChatList 
              mode={config.syncMode}
              onToggle={(chatId: string, enabled: boolean) => {
                // Handle manual overrides
              }}
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setStep(2)}
              className="flex-1 py-2 border rounded-lg hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={() => onComplete(config)}
              className="flex-1 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
            >
              Start Syncing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatList({ mode, onToggle }: any) {
  // This would fetch actual chats from Telegram
  const mockChats = [
    { id: '1', title: 'John from Acme Corp', type: 'private', suggested: true, reason: 'Contains "contract"' },
    { id: '2', title: 'Family Group', type: 'group', suggested: false, reason: 'Personal' },
    { id: '3', title: 'Customer Support', type: 'group', suggested: true, reason: 'Business group' },
    { id: '4', title: 'Sarah', type: 'private', suggested: false, reason: 'No business indicators' },
  ];

  return (
    <>
      {mockChats.map(chat => (
        <div key={chat.id} className="flex items-center p-3 border rounded-lg">
          <input
            type="checkbox"
            defaultChecked={chat.suggested}
            onChange={(e) => onToggle(chat.id, e.target.checked)}
            className="mr-3"
          />
          <div className="flex-1">
            <div className="font-medium">{chat.title}</div>
            <div className="text-xs text-gray-500">
              {chat.type} • {chat.reason}
            </div>
          </div>
          <div className="text-sm">
            {chat.suggested ? (
              <span className="text-green-600">Will sync</span>
            ) : (
              <span className="text-gray-400">Won't sync</span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}