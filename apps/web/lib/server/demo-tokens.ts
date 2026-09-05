import {
  pbkdf2 as nodePbkdf2,
  pbkdf2Sync as nodePbkdf2Sync,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * Demo capability token utilities (Phase 3D).
 *
 * Security and performance rationale:
 * - Raw token: 32 bytes (256-bit) → base64url (43 chars, no padding). 256-bit entropy prevents brute force.
 * - Stored hash: PBKDF2-HMAC-SHA256 with 100,000 iterations, 32-byte salt, 32-byte key. Only Node built-in crypto, no native deps.
 * - Async `pbkdf2` is preferred on public request paths (creation/verification) to avoid blocking the event loop; sync variant remains for
 *   tests and non-request-path utilities but is not used on the hot public routes. With rate limits (create 3/hour/IP, token failures 5/5min)
 *   and bounded iterations, even sync would be limited, but async removes avoidable DoS amplification.
 * - Comparison uses `timingSafeEqual` (constant-time) on equal-length buffers to prevent timing oracles.
 * - Stored hash format is `iterations$saltHex$keyHex` where iterations is strictly validated numeric string (no partial parse), salt/key are
 *   verified as exact-length lower-case hex before any expensive PBKDF2 work, so malformed or excessive-iteration hashes are rejected quickly.
 * - Raw token format is validated (43-char base64url) before hashing/verification to avoid unnecessary crypto and to fail closed.
 * - Fail-closed: any parse/validation failure returns false without revealing why.
 * - No token, salt, key, or raw IP is logged, audited, or stored outside the hashed form.
 */

export const DEMO_TOKEN_BYTES = 32;
export const DEMO_TOKEN_BASE64URL_LENGTH = 43; // 32 bytes → 43 chars base64url (no padding)
export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_KEY_LENGTH = 32;
export const PBKDF2_SALT_LENGTH = 32;
export const PBKDF2_ALGORITHM = "sha256" as const;

// Bounds for stored-hash iteration validation — reject excessive work before PBKDF2.
export const PBKDF2_MIN_ITERATIONS = 10_000;
export const PBKDF2_MAX_ITERATIONS = 500_000;

// Base64url alphabet without padding, exactly 43 chars for 32 bytes.
const BASE64URL_REGEX = /^[A-Za-z0-9_-]{43}$/;
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;
const ITERATIONS_REGEX = /^\d+$/;

const pbkdf2Async = promisify(nodePbkdf2);

/** Stored hash format: `iterations$saltHex$keyHex` */
export interface DemoTokenHash {
  iterations: number;
  salt: Buffer;
  key: Buffer;
}

/**
 * Validate raw token syntax and length before hashing or verification.
 * Returns true iff token is 43-char base64url (256-bit).
 */
export function isValidDemoTokenFormat(token: string): boolean {
  return BASE64URL_REGEX.test(token);
}

/**
 * Generate a cryptographically secure raw capability token.
 * Returns base64url-encoded string (no padding).
 */
export function generateDemoToken(): string {
  const bytes = randomBytes(DEMO_TOKEN_BYTES);
  return bytesToBase64Url(bytes);
}

/**
 * Hash a raw token using PBKDF2-HMAC-SHA256 (sync).
 * Returns formatted string: `iterations$saltHex$keyHex`
 * Validates token format before hashing; throws on malformed token.
 */
export function hashDemoToken(token: string): string {
  if (!isValidDemoTokenFormat(token)) {
    throw new Error("Invalid demo token format");
  }
  const salt = randomBytes(PBKDF2_SALT_LENGTH);
  const key = pbkdf2Sync(token, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_ALGORITHM);
  const iterationsString = String(PBKDF2_ITERATIONS);
  return `${iterationsString}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Hash a raw token using PBKDF2-HMAC-SHA256 (async, non-blocking).
 * Preferred on public request paths to avoid event-loop blocking.
 */
export async function hashDemoTokenAsync(token: string): Promise<string> {
  if (!isValidDemoTokenFormat(token)) {
    throw new Error("Invalid demo token format");
  }
  const salt = randomBytes(PBKDF2_SALT_LENGTH);
  const key = (await pbkdf2Async(
    token,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_ALGORITHM,
  )) as Buffer;
  const iterationsString = String(PBKDF2_ITERATIONS);
  return `${iterationsString}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Verify a raw token against a stored hash using constant-time comparison (sync).
 * Validates token format and stored-hash format strictly before expensive work.
 * Fails closed (returns false) without revealing why.
 */
export function verifyDemoToken(token: string, storedHash: string): boolean {
  try {
    if (!isValidDemoTokenFormat(token)) return false;
    const parsed = parseDemoTokenHash(storedHash);
    const key = pbkdf2Sync(
      token,
      parsed.salt,
      parsed.iterations,
      PBKDF2_KEY_LENGTH,
      PBKDF2_ALGORITHM,
    );
    // Buffers are equal length (32) by validation, safe for timingSafeEqual.
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/**
 * Verify a raw token against a stored hash (async, non-blocking).
 * Preferred on public request paths.
 */
export async function verifyDemoTokenAsync(token: string, storedHash: string): Promise<boolean> {
  try {
    if (!isValidDemoTokenFormat(token)) return false;
    const parsed = parseDemoTokenHash(storedHash);
    const key = (await pbkdf2Async(
      token,
      parsed.salt,
      parsed.iterations,
      PBKDF2_KEY_LENGTH,
      PBKDF2_ALGORITHM,
    )) as Buffer;
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/**
 * Parse a stored hash string into its components.
 * Validates format strictly before any crypto work:
 * - Exactly 3 $-delimited parts
 * - iterations is strict decimal string, integer, within bounds
 * - salt/key are exact-length hex strings (64 chars, 32 bytes)
 * Throws if any check fails.
 */
export function parseDemoTokenHash(storedHash: string): DemoTokenHash {
  const parts = storedHash.split("$");
  if (parts.length !== 3) {
    throw new Error("Invalid token hash format");
  }
  const iterationsString = parts[0] ?? "";
  if (!ITERATIONS_REGEX.test(iterationsString)) {
    throw new Error("Invalid iterations in token hash");
  }
  const iterations = Number.parseInt(iterationsString, 10);
  if (
    !Number.isInteger(iterations) ||
    iterations < PBKDF2_MIN_ITERATIONS ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    throw new Error("Invalid iterations in token hash");
  }
  const saltHex = parts[1] ?? "";
  const keyHex = parts[2] ?? "";
  if (!HEX_64_REGEX.test(saltHex) || !HEX_64_REGEX.test(keyHex)) {
    throw new Error("Invalid salt or key hex in token hash");
  }
  const salt = Buffer.from(saltHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  if (salt.length !== PBKDF2_SALT_LENGTH || key.length !== PBKDF2_KEY_LENGTH) {
    throw new Error("Invalid salt or key length in token hash");
  }
  return { iterations, salt, key };
}

/** Synchronous PBKDF2 wrapper (internal). */
function pbkdf2Sync(
  password: string,
  salt: Buffer,
  iterations: number,
  keyLength: number,
  algorithm: string,
): Buffer {
  return nodePbkdf2Sync(password, salt, iterations, keyLength, algorithm);
}

/** Convert bytes to base64url (no padding). */
function bytesToBase64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Convert base64url back to bytes. */
export function base64UrlToBytes(base64url: string): Buffer {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding) base64 += "=".repeat(4 - padding);
  return Buffer.from(base64, "base64");
}

/**
 * Generate a rate-limit key from client fingerprint (IP + User-Agent).
 * Uses SHA-256 hash, never stores raw IP.
 */
export function hashRateLimitKey(ip: string | null, userAgent: string | null): string {
  const input = `${ip ?? "unknown"}|${userAgent ?? "unknown"}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 64);
}
