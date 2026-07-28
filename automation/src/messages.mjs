export function nonEmptyMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => String(message ?? "").trim())
    .filter(Boolean);
}
