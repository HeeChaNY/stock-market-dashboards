export class TelegramClient {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset) {
    return this.call("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ["message"] });
  }

  async sendMessage(chatId, text) {
    return this.call("sendMessage", { chat_id: chatId, text: truncate(text), disable_web_page_preview: true });
  }

  async setCommands(commands) {
    return this.call("setMyCommands", { commands });
  }

  async sendDocument(chatId, filePath, filename) {
    const bytes = await (await import("node:fs/promises")).readFile(filePath);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
    const response = await fetch(`${this.baseUrl}/sendDocument`, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.description || "Telegram sendDocument failed");
    return payload.result;
  }

  async call(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram ${method} failed`);
    return payload.result;
  }
}

function truncate(text) {
  const max = 3900;
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}
