// Credentials must never be sent to a configurable origin or followed redirect.
const API_ORIGIN = "https://api.attio.com";
export const MAX_ATTIO_BYTES = 8 * 1024 * 1024;
export const ATTIO_TIMEOUT_MS = 30_000;

export class AttioApiError extends Error {
  public readonly path: string;
  constructor(public readonly status: number, path: string) {
    // Response bodies may contain CRM data, tokens, or terminal control codes.
    super(`Attio API ${status}: ${path.split("?")[0]}`);
    this.path = path.split("?")[0];
  }
}

export function attioSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid Attio path identifier");
  return value;
}

class AttioBoundaryError extends Error {}

async function boundedBody(res: Response, signal: AbortSignal): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const advertised = Number(res.headers.get("content-length"));
    if (advertised > MAX_ATTIO_BYTES) throw new AttioBoundaryError("Attio response exceeds size limit");
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTIO_BYTES) throw new AttioBoundaryError("Attio response exceeds size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export async function attioRequest(key: string, path: string, options: RequestInit = {}): Promise<Response> {
  if (!key) throw new AttioBoundaryError("Missing Attio API key");
  const configured = process.env["ATTIO_API_BASE_URL"];
  if (configured && configured.replace(/\/+$/, "") !== API_ORIGIN) {
    throw new AttioBoundaryError("ATTIO_API_BASE_URL must be https://api.attio.com");
  }
  // All dynamic path components must also pass attioSegment at their call site.
  if (!/^\/[A-Za-z0-9_/-]+$/.test(path.split("?")[0]) || !path.startsWith("/") || path.startsWith("//") || /[\\\r\n#]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(path)) {
    throw new AttioBoundaryError("Invalid Attio API path");
  }
  if (options.body !== undefined && options.body !== null &&
      (typeof options.body !== "string" || Buffer.byteLength(options.body) > MAX_ATTIO_BYTES)) {
    throw new AttioBoundaryError("Attio request exceeds size limit or is not a JSON string");
  }
  const method = (options.method || "GET").toUpperCase();
  const retryableRead = method === "GET" || (method === "POST" && /^\/objects\/[A-Za-z0-9_-]+\/records\/query$/.test(path));
  const maxAttempts = retryableRead ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(ATTIO_TIMEOUT_MS);
    let retryAfterMs: number | undefined;
    try {
      const headers = new Headers(options.headers);
      headers.set("Authorization", `Bearer ${key}`);
      headers.set("Content-Type", "application/json");
      const res = await fetch(`${API_ORIGIN}/v2${path}`, {
        ...options, headers, redirect: "error", signal,
      });
      // Buffer before returning: the deadline and size cap cover body consumption,
      // not just the arrival of response headers (also caps decompressed bytes).
      const body = await boundedBody(res, signal);
      if (res.ok) {
        // The body has been decompressed; don't retain stale length/encoding headers.
        return new Response([204, 205].includes(res.status) ? null : new Uint8Array(body), { status: res.status });
      }
      const error = new AttioApiError(res.status, path);
      if (!retryableRead || ![429, 502, 503, 504].includes(res.status) || attempt === maxAttempts) throw error;
      const seconds = Number.parseFloat(res.headers.get("retry-after") || "");
      if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, Math.min(30_000, seconds * 1000));
    } catch (err) {
      if (err instanceof AttioApiError || err instanceof AttioBoundaryError) throw err;
      // Never automatically replay a mutation whose response may have been lost.
      if (!retryableRead || attempt === maxAttempts) {
        throw new Error("Attio transport failed or timed out; response details withheld");
      }
    }
    await new Promise(resolve => setTimeout(resolve, retryAfterMs ?? Math.min(30_000, 750 * 2 ** (attempt - 1))));
  }
  throw new Error("Attio request failed");
}
