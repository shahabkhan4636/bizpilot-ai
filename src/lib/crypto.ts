import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two secrets supplied as strings.
 *
 * `a !== b` on a shared API key returns as soon as the first byte differs, which
 * leaks the key one byte at a time to anyone who can time the responses. Hashing
 * both sides first makes the comparison fixed-length and constant-time whatever
 * the inputs look like (different lengths included).
 */
export function secureCompare(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
