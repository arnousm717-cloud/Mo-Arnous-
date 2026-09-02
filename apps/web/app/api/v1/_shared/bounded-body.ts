/**
 * Byte-bounded request body reading for machine-authenticated /api/v1/*
 * routes (Milestone 3.3E). The same incremental-stream-reading technique
 * as apps/web/app/track/_shared/request.ts (that module's own logic has
 * no tracking-specific coupling in it at all — it is a fully generic
 * bounded-JSON reader that happens to live under track/_shared because it
 * was built for, and scoped to, that one route family) — reimplemented
 * here, not imported, so track/_shared keeps its own stated single-scope-
 * family boundary intact. request.json()/request.text() buffer the
 * entire body before returning with no built-in cap, so an ordinary
 * ordinary route handler calling either directly has no protection
 * against an oversized body — this module aborts the moment the running
 * byte count exceeds the limit, before the stream ever finishes
 * draining.
 */

const MAX_BODY_BYTES = 65536; // generous for a normalized provider enrichment payload + raw_payload, far below any DoS-relevant size.

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

export async function readBoundedJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }

  const bodyStream = request.body;
  if (!bodyStream) {
    throw new InvalidJsonError();
  }

  const reader = bodyStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new InvalidJsonError();
  }

  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}
