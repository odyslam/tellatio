import type { RecordAction } from "attio/client";
import { showDialog } from "attio/client";

export const recordAction: RecordAction = {
  id: "telegram-test",
  label: "Telegram Test",
  icon: "Send",
  onTrigger: async ({ recordId, object }) => {
    // Show a dialog
    showDialog({
      title: "Telegram Integration Test",
      Dialog: () => <TestDialog recordId={recordId} object={object} />,
    });
  },
};

function TestDialog({ recordId, object }: any) {
  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Telegram Integration Status</h2>
      
      <div className="space-y-2">
        <p className="text-sm text-gray-600">
          Record Type: <span className="font-medium">{object}</span>
        </p>
        <p className="text-sm text-gray-600">
          Record ID: <span className="font-mono text-xs">{recordId}</span>
        </p>
      </div>

      <div className="border-t pt-4">
        <h3 className="font-medium mb-2">Integration Features:</h3>
        <ul className="text-sm space-y-1">
          <li>✓ Send Telegram messages</li>
          <li>✓ Receive and log messages</li>
          <li>✓ Connect Telegram accounts</li>
          <li>✓ View conversation history</li>
        </ul>
      </div>

      <div className="border-t pt-4">
        <p className="text-sm text-gray-600">
          To use this integration:
        </p>
        <ol className="text-sm mt-2 space-y-1">
          <li>1. Add a Telegram connection in Settings</li>
          <li>2. Enter your bot token</li>
          <li>3. Send a message to @tellatio_bot</li>
        </ol>
      </div>

      <button
        onClick={() => window.close()}
        className="w-full px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
      >
        Close
      </button>
    </div>
  );
}