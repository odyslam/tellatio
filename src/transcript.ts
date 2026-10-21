import type { StoredMessage } from "./state";
import { sanitizeUntrusted, UNTRUSTED_ADVISORY } from "./guard";

// Escape HTML and Markdown metacharacters so remote content cannot forge headings,
// links, embedded images, or transcript boundaries in the CRM note.
export function escapeTranscriptText(text: string): string {
  return sanitizeUntrusted(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, "\\$1");
}

export function formatTranscript(messages: StoredMessage[]): string {
  if (messages.length === 0) return "";
  const sections = [`**UNTRUSTED TELEGRAM TRANSCRIPT**\n\n${UNTRUSTED_ADVISORY}`];
  let previousDay = "";
  for (const msg of messages) {
    const timestamp = new Date(msg.date * 1000).toISOString();
    const day = timestamp.slice(0, 10);
    if (day !== previousDay) { sections.push(`### ${day}`); previousDay = day; }
    const sender = escapeTranscriptText(msg.sender).replace(/[\r\n\t]+/g, " ");
    const lines = escapeTranscriptText(msg.text).replace(/\r\n?/g, "\n").split("\n");
    sections.push(`**${timestamp.slice(11, 16)}** ${sender}:\n\n${lines.map(line => `> ${line || " "}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
