export type VoucherErrorCode = 'format' | 'issuer' | 'program' | 'holder' | 'audience' | 'nonce' | 'expired' | 'spent';

/** A voucher or presentation that does not verify, with why. */
export class VoucherError extends Error {
  constructor(
    readonly code: VoucherErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VoucherError';
  }
}
