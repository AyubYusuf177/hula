import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Server-only token vault (Section 10).
 *
 * Provider access/refresh tokens must NEVER reach the mobile app and must never
 * sit in the database in plaintext. This module is the single place tokens are
 * encrypted/decrypted, using AES-256-GCM (authenticated encryption) with a key
 * from the environment.
 *
 * Hard rules enforced here:
 *   - The mobile app never calls this — it lives only on the backend.
 *   - Token VALUES are never logged, thrown, or included in error messages.
 *   - If the encryption key is missing/invalid and encryption is attempted, we
 *     throw a safe configuration error (no token, no key material in it).
 *
 * The key comes from `INTEGRATION_TOKEN_ENCRYPTION_KEY`. It is read lazily (at
 * call time, not import time) so the server still boots without it — the key is
 * only required the moment a token is actually encrypted or decrypted.
 *
 * Ciphertext format (all base64url, colon-separated), self-describing so we can
 * rotate the scheme later without guessing:
 *
 *     v1:<iv>:<authTag>:<ciphertext>
 */

/** Env var holding the 32-byte AES key (base64, base64url, or hex encoded). */
const KEY_ENV = "INTEGRATION_TOKEN_ENCRYPTION_KEY";
const SCHEME = "v1";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

/** Thrown for any configuration/format problem. Never contains token/key data. */
export class TokenVaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenVaultConfigError";
  }
}

/**
 * Decode a raw key string (base64 / base64url / hex) into exactly 32 bytes.
 * Exported so tests can supply a deterministic key without going through env.
 * Throws a safe error (no key material) if the value can't yield 32 bytes.
 */
export function decodeEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new TokenVaultConfigError(
      `${KEY_ENV} is not set — token storage is unavailable until it is configured.`,
    );
  }

  // Try hex first only when it looks like hex of the right length, otherwise
  // treat as base64/base64url. Never log the value on failure.
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    key = Buffer.from(value, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new TokenVaultConfigError(
      `${KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Provide a 32-byte key as base64 or hex.",
    );
  }
  return key;
}

/** Resolve the active key from the environment (lazy). */
function resolveKey(): Buffer {
  return decodeEncryptionKey(process.env[KEY_ENV]);
}

/**
 * True when a usable encryption key is configured. Lets callers avoid attempting
 * token storage (and the resulting error) when the vault isn't set up. Never
 * throws and never reveals the key.
 */
export function isTokenVaultConfigured(): boolean {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext token. Returns the self-describing ciphertext string.
 * `keyOverride` is for tests only — production passes nothing and uses env.
 * Throws `TokenVaultConfigError` if no key is available.
 */
export function encryptToken(plaintext: string, keyOverride?: Buffer): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TokenVaultConfigError("Cannot encrypt an empty token.");
  }
  const key = keyOverride ?? resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a ciphertext produced by `encryptToken`. Throws
 * `TokenVaultConfigError` if the key is missing or the payload is malformed.
 * GCM authentication failures (wrong key / tampered data) surface as a generic
 * error with NO token or key material in the message.
 */
export function decryptToken(payload: string, keyOverride?: Buffer): string {
  const key = keyOverride ?? resolveKey();
  const parts = (payload ?? "").split(":");
  const [scheme, ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 4 || scheme !== SCHEME || !ivB64 || !tagB64 || !dataB64) {
    throw new TokenVaultConfigError("Malformed encrypted token payload.");
  }
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Never include the token, key, or raw crypto error detail.
    throw new TokenVaultConfigError("Failed to decrypt token (bad key or data).");
  }
}

/**
 * A stable, non-reversible hash of a granted scope set, for change detection
 * (e.g. "did the user's grant change since last time?"). Order-independent and
 * safe to store/compare — it reveals nothing about tokens.
 */
export function hashScopes(scopes: readonly string[] | null | undefined): string | null {
  if (!scopes || scopes.length === 0) return null;
  const normalized = [...scopes].map((s) => s.trim()).filter(Boolean).sort();
  if (normalized.length === 0) return null;
  return createHash("sha256").update(normalized.join(" ")).digest("hex");
}
