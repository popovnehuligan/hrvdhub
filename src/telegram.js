/** Minimal Telegram Bot API client. Errors never include the token. */
export class Telegram {
  constructor(token, apiUrl = 'https://api.telegram.org') {
    this.base = `${apiUrl}/bot${token}`;
  }

  async call(method, params = {}, { signal } = {}) {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    return this.#result(method, response);
  }

  /** Sends a local file, e.g. sendPhoto with the item's picture. */
  async upload(method, params, field, { buffer, filename, contentType }) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.append(field, new Blob([buffer], { type: contentType }), filename);
    const response = await fetch(`${this.base}/${method}`, { method: 'POST', body: form });
    return this.#result(method, response);
  }

  async #result(method, response) {
    const data = await response.json().catch(() => null);
    if (!data?.ok) {
      const error = new Error(`Telegram ${method} failed: ${data?.description || `HTTP ${response.status}`}`);
      error.code = data?.error_code ?? response.status;
      error.retryAfter = data?.parameters?.retry_after;
      throw error;
    }
    return data.result;
  }
}
