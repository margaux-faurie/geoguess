// Runtime-agnostic: no Node imports, so this file also runs in a Cloudflare Worker.

export class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code short machine-readable code
   * @param {string} message plain-language message
   * @param {object} body extra fields merged into the JSON response
   */
  constructor(status, code, message, body = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
