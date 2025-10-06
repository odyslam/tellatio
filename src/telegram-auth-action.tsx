import type { RecordAction } from "attio/client";
import { showDialog } from "attio/client";
import { useState } from 'react';

export const recordAction: RecordAction = {
  id: "telegram-auth",
  label: "Connect Telegram Account",
  icon: "Send",
  onTrigger: async ({ recordId, object }) => {
    showDialog({
      title: "Connect Your Telegram Account",
      Dialog: () => <TelegramAuthDialog recordId={recordId} object={object} />,
    });
  },
};

function TelegramAuthDialog({ recordId, object }: any) {
  const [step, setStep] = useState<'phone' | 'code' | 'config' | 'syncing'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [syncConfig, setSyncConfig] = useState({
    mode: 'smart',
    autoDetectBusiness: true,
    syncGroups: true,
    keywords: ['customer', 'client', 'meeting', 'contract', 'invoice'],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handlePhoneSubmit = async () => {
    if (!phoneNumber) {
      setError('Please enter your phone number');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // This would call your server function to initiate authentication
      const response = await fetch('/api/telegram-auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          recordId,
        }),
      });

      if (!response.ok) throw new Error('Failed to start authentication');
      
      setStep('code');
    } catch (err) {
      setError('Failed to send verification code. Please check your phone number.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async () => {
    if (!verificationCode) {
      setError('Please enter the verification code');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/telegram-auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          code: verificationCode,
          recordId,
        }),
      });

      if (!response.ok) throw new Error('Invalid code');
      
      setStep('config');
    } catch (err) {
      setError('Invalid verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfigSubmit = async () => {
    setLoading(true);
    setError('');
    setStep('syncing');

    try {
      const response = await fetch('/api/telegram-auth/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId,
          syncConfig,
        }),
      });

      if (!response.ok) throw new Error('Configuration failed');
      
      // Success - close dialog after showing success state
      setTimeout(() => {
        window.close();
      }, 2000);
    } catch (err) {
      setError('Failed to configure sync settings.');
      setStep('config');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-md mx-auto">
      {step === 'phone' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold mb-2">Enter Your Phone Number</h2>
            <p className="text-sm text-gray-600 mb-4">
              We'll send a verification code to your Telegram app
            </p>
          </div>

          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+1234567890"
            className="w-full p-3 border rounded-lg"
            disabled={loading}
          />

          {error && (
            <div className="text-red-600 text-sm">{error}</div>
          )}

          <button
            onClick={handlePhoneSubmit}
            disabled={loading || !phoneNumber}
            className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300"
          >
            {loading ? 'Sending Code...' : 'Send Verification Code'}
          </button>

          <div className="text-xs text-gray-500 text-center">
            Your phone number will be used only for authentication and will not be shared
          </div>
        </div>
      )}

      {step === 'code' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold mb-2">Enter Verification Code</h2>
            <p className="text-sm text-gray-600 mb-4">
              Check your Telegram app for the code sent to {phoneNumber}
            </p>
          </div>

          <input
            type="text"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value)}
            placeholder="12345"
            className="w-full p-3 border rounded-lg text-center text-2xl tracking-wide"
            disabled={loading}
            maxLength={5}
          />

          {error && (
            <div className="text-red-600 text-sm">{error}</div>
          )}

          <button
            onClick={handleCodeSubmit}
            disabled={loading || !verificationCode}
            className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300"
          >
            {loading ? 'Verifying...' : 'Verify Code'}
          </button>

          <button
            onClick={() => setStep('phone')}
            className="w-full py-2 text-gray-600 hover:text-gray-800"
          >
            Use Different Number
          </button>
        </div>
      )}

      {step === 'config' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold mb-2">Configure Sync Settings</h2>
            <p className="text-sm text-gray-600 mb-4">
              Choose how we should sync your Telegram chats
            </p>
          </div>

          <div className="space-y-3">
            <label className="flex items-start p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="smart"
                checked={syncConfig.mode === 'smart'}
                onChange={(e) => setSyncConfig({...syncConfig, mode: e.target.value as any})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Smart Detection</div>
                <div className="text-xs text-gray-600">
                  Auto-detect business chats, exclude personal
                </div>
              </div>
            </label>

            <label className="flex items-start p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="folders"
                checked={syncConfig.mode === 'folders'}
                onChange={(e) => setSyncConfig({...syncConfig, mode: e.target.value as any})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Folder-based</div>
                <div className="text-xs text-gray-600">
                  Only sync chats in "Attio" folder
                </div>
              </div>
            </label>

            <label className="flex items-start p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="syncMode"
                value="manual"
                checked={syncConfig.mode === 'manual'}
                onChange={(e) => setSyncConfig({...syncConfig, mode: e.target.value as any})}
                className="mt-1 mr-3"
              />
              <div>
                <div className="font-medium">Manual Selection</div>
                <div className="text-xs text-gray-600">
                  I'll choose which chats to sync
                </div>
              </div>
            </label>
          </div>

          <div className="p-3 bg-yellow-50 rounded-lg">
            <p className="text-xs text-yellow-800">
              <strong>Privacy:</strong> Personal chats are excluded by default. 
              You can adjust settings anytime.
            </p>
          </div>

          {error && (
            <div className="text-red-600 text-sm">{error}</div>
          )}

          <button
            onClick={handleConfigSubmit}
            disabled={loading}
            className="w-full py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300"
          >
            {loading ? 'Configuring...' : 'Start Syncing'}
          </button>
        </div>
      )}

      {step === 'syncing' && (
        <div className="space-y-4 text-center py-8">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          <h2 className="text-lg font-semibold">Setting Up Sync</h2>
          <p className="text-sm text-gray-600">
            Analyzing your chats and applying privacy filters...
          </p>
          {!error && (
            <p className="text-xs text-gray-500">
              This may take a few moments
            </p>
          )}
        </div>
      )}
    </div>
  );
}