import type { RecordAction } from "attio/client";
import { alert } from "attio/client";

export const recordAction: RecordAction = {
  id: "telegram-simple-test",
  label: "Telegram Simple Test",
  onTrigger: async ({ recordId, object }) => {
    await alert({
      title: "Telegram Integration Working!",
      text: `Successfully triggered on ${object} record with ID: ${recordId}`,
      okLabel: "Great!",
    });
  },
};