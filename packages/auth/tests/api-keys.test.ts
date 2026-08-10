import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX_LIVE,
  API_KEY_PREFIX_TEST,
  generateApiKey,
  hashApiKey,
  isApiKeyValid,
  verifyApiKey,
} from "../src/api-keys";

describe("generateApiKey(): entropy and displayability", () => {
  it("generates a plaintext key starting with the correct environment prefix", () => {
    expect(generateApiKey("live").plaintext.startsWith(API_KEY_PREFIX_LIVE)).toBe(true);
    expect(generateApiKey("test").plaintext.startsWith(API_KEY_PREFIX_TEST)).toBe(true);
  });

  it("the plaintext key contains no whitespace or control characters — safe to display/copy/paste", () => {
    const { plaintext } = generateApiKey("live");
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("has sufficient entropy: 1000 generated keys are all unique", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      keys.add(generateApiKey("test").plaintext);
    }
    expect(keys.size).toBe(1000);
  });

  it("the random portion (excluding the prefix) is long enough to be brute-force-infeasible", () => {
    const { plaintext, keyPrefix } = generateApiKey("live");
    const randomPortion = plaintext.slice(keyPrefix.length);
    // 32 bytes base64url-encoded is at least 42 characters — asserting a
    // floor here catches an accidental regression to a much shorter key,
    // not pinning the exact encoded length.
    expect(randomPortion.length).toBeGreaterThanOrEqual(40);
  });

  it("keyHash is present and is not the plaintext itself", () => {
    const { plaintext, keyHash } = generateApiKey("test");
    expect(keyHash).toBeTruthy();
    expect(keyHash).not.toBe(plaintext);
    expect(keyHash).not.toContain(plaintext);
  });
});

describe("hashApiKey() / verifyApiKey(): stored value is a hash, never plaintext", () => {
  it("hashing the same key twice produces the same hash (deterministic)", () => {
    const { plaintext } = generateApiKey("live");
    expect(hashApiKey(plaintext)).toBe(hashApiKey(plaintext));
  });

  it("hashing two different keys produces different hashes", () => {
    const a = generateApiKey("live").plaintext;
    const b = generateApiKey("live").plaintext;
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
  });

  it("the hash is not reversible to plaintext by inspection — it is hex, fixed-length, unrelated in shape to the input", () => {
    const { plaintext, keyHash } = generateApiKey("live");
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
    expect(keyHash.length).not.toBe(plaintext.length);
  });

  it("verification succeeds for the correct key against its own hash", () => {
    const { plaintext, keyHash } = generateApiKey("live");
    expect(verifyApiKey(plaintext, keyHash)).toBe(true);
  });

  it("verification fails for a wrong key against another key's hash", () => {
    const { keyHash } = generateApiKey("live");
    const wrongKey = generateApiKey("live").plaintext;
    expect(verifyApiKey(wrongKey, keyHash)).toBe(false);
  });

  it("verification fails for a subtly modified (single-character-changed) key", () => {
    const { plaintext, keyHash } = generateApiKey("live");
    const tampered = plaintext.slice(0, -1) + (plaintext.endsWith("A") ? "B" : "A");
    expect(verifyApiKey(tampered, keyHash)).toBe(false);
  });

  it("verification does not throw for a malformed/short stored hash", () => {
    expect(() => verifyApiKey("anything", "not-a-real-hash")).not.toThrow();
    expect(verifyApiKey("anything", "not-a-real-hash")).toBe(false);
  });
});

describe("isApiKeyValid(): revocation is enforced as part of the utility contract", () => {
  it("a correct, non-revoked key is valid", () => {
    const { plaintext, keyHash } = generateApiKey("live");
    expect(isApiKeyValid(plaintext, { keyHash, revokedAt: null })).toBe(true);
  });

  it("a correct but revoked key is invalid", () => {
    const { plaintext, keyHash } = generateApiKey("live");
    expect(isApiKeyValid(plaintext, { keyHash, revokedAt: new Date().toISOString() })).toBe(false);
  });

  it("a wrong key is invalid regardless of revocation state", () => {
    const { keyHash } = generateApiKey("live");
    const wrongKey = generateApiKey("live").plaintext;
    expect(isApiKeyValid(wrongKey, { keyHash, revokedAt: null })).toBe(false);
  });
});
