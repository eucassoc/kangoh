import { createHash, randomBytes } from 'node:crypto';

/** Lowercase hex SHA-256 of a string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** base64url SHA-256, as SD-JWT's `sd_hash` uses it. */
export function sha256b64url(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('base64url');
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
