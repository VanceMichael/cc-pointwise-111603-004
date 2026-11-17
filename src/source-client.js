export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  async #read(path, headers = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    const response = await fetch(address, { headers, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
    };
  }

  async read(path) {
    return this.#read(path);
  }

  async readManifest(path) {
    const response = await this.#read(path);
    let value;
    try { value = JSON.parse(response.text); } catch { throw new Error(`source manifest is not JSON: ${path}`); }
    return value;
  }
}
