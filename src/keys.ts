import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';

/** The algorithm every signature in a program uses. */
export const ALG = 'EdDSA';

/** A signing key with its public half. Keys are plain JWKs so that stores and agents can keep them wherever they keep keys. */
export interface KeyPair {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

/** Generates an Ed25519 key pair. */
export async function generateKey(): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { kid, privateJwk: { ...privateJwk, kid }, publicJwk: { ...publicJwk, kid } };
}

/** The public half of a JWK, as it goes into a program or a voucher. */
export function toPublic(jwk: JWK): JWK {
  const { d: _d, ...pub } = jwk;
  return pub;
}

export async function signingKey(jwk: JWK): Promise<CryptoKey | Uint8Array> {
  return importJWK(jwk, ALG);
}

export async function verifyingKey(jwk: JWK): Promise<CryptoKey | Uint8Array> {
  return importJWK(toPublic(jwk), ALG);
}
