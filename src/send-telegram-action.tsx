import type { RecordAction } from "attio/client";
import { showDialog } from "attio/client";
import { useState } from "react";
// Server APIs will be used via server functions

export const recordAction: RecordAction = {
  id: "send-telegram-message",
  label: "Send Telegram Message",
  icon: "Send",
  onTrigger: async ({ recordId, object }) => {
    showDialog({
      title: "Send Telegram Message",
      Dialog: () => <SendMessageDialog recordId={recordId} object={object} />,
    });
  },
};

function SendMessageDialog({ recordId, object }: any) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSend = async () => {
    if (!message.trim()) {
      setError("Please enter a message");
      return;
    }

    setSending(true);
    setError("");

    try {
      // Get the record to find Telegram ID
      const response = await fetch(`/api/send-telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId,
          object,
          message,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      setSuccess(true);
      setTimeout(() => {
        window.close();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  if (success) {
    return (
      <div className="p-6 text-center">
        <div className="text-green-600 mb-2">✓</div>
        <p className="text-green-600">Message sent successfully!</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2">Message</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full p-2 border rounded-md"
          rows={5}
          placeholder="Type your message..."
          disabled={sending}
        />
      </div>

      {error && (
        <div className="text-red-600 text-sm">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => window.close()}
          className="px-4 py-2 text-gray-600 border rounded-md hover:bg-gray-50"
          disabled={sending}
        >
          Cancel
        </button>
        <button
          onClick={handleSend}
          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-gray-300"
          disabled={sending || !message.trim()}
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}