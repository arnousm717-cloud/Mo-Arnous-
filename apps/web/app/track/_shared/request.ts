/**
 * Byte-bounded request body reading for the public /track/* routes
 * (Milestone 3.1C-C). Route Handlers run in the Node.js runtime by
 * default in this app (confirmed: no `runtime: "edge"` declaration
 * exists anywhere in apps/web) — both routes declare `runtime = "nodejs"`
 * explicitly regardless, since correctness here genuinely depends on it
 * (Buffer, and pg elsewhere in the request lifecycle, are Node-only).
 *
 * request.json()/request.text() buffer the ENTIRE body before returning
 * — there is no built-in size cap, so calling either directly on an
 * anonymous public endpoint would allow unbounded buffering. This module
 * never calls them. Instead it reads request.body (a
 * ReadableStream<Uint8Array> | null) incrementally, aborting the moment
 * the running byte count exceeds the limit — before the stream ever
 * finishes draining.
 *
 * Content-Length is used only as an optional fast-path pre-rejection
 * (skip touching the body entirely for an obviously oversized declared
 * length) — never as the authoritative limit, since it can be absent,
 * understated, or outright malformed/negative by a client that doesn't
 * control the actual bytes sent. The incremental byte count is what
 * actually enforces the limit in every case.
 */

const MAX_BODY_BYTES = 16384;

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("request body is empty or not valid JSON");
    this.name = "InvalidJsonError";
  }
}

/**
 * Content-Length is a cheap upfront signal only. A parseable, non-negative
 * value that already exceeds the limit lets us reject without reading a
 * single byte of the body. Anything else (absent, NaN, negative) is not
 * trusted in either direction — the caller falls through to the
 * authoritative incremental read below.
 */
function declaredContentLengthExceedsLimit(request: Request): boolean {
  const header = request.headers.get("content-length");
  if (header === null) {
    return false;
  }
  const declared = Number(header);
  return Number.isFinite(declared) && declared >= 0 && declared > MAX_BODY_BYTES;
}

/**
 * Reads request.body incrementally, enforces the byte cap authoritatively
 * (regardless of what Content-Length claimed), decodes UTF-8 once the
 * bounded byte total is confirmed, and parses JSON. Throws
 * PayloadTooLargeError or InvalidJsonError — never returns a partial or
 * best-effort result, never silently truncates.
 */
export async function readBoundedJsonBody(request: Request): Promise<unknown> {
  if (declaredContentLengthExceedsLimit(request)) {
    throw new PayloadTooLargeError();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const body = request.body;
  if (body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength > 0) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new PayloadTooLargeError();
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  const decoded = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(decoded);
  } catch {
    throw new InvalidJsonError();
  }
}
