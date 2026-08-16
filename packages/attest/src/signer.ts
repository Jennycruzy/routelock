/// The EIP-712 signature that authorises a retirement to spend.
///
/// This is the single most dangerous function in the repo. The signature it
/// produces is an EIP-3009 authorisation: hand it to the relay and USDC leaves
/// the issuer's account, a carbon credit is permanently burned, and none of it
/// can be undone. Everything else in the carbon path is free and reversible.
///
/// So it is deliberately small, lives in its own file, and does exactly one
/// thing. The adapter takes a `SignTypedData` callback rather than a key
/// precisely so the key never enters `@routelock/carbon`; keeping the
/// implementation here preserves that.
///
/// ## What this refuses to sign
///
/// The adapter already checks that the prepared authorisation matches the
/// order it was built from, and enforces the spend caps, before calling this.
/// This adds the last independent check: a ceiling on the authorised value,
/// read at the call site, so a signer cannot be handed a payload whose cost
/// nobody looked at. Belt and braces on the one action with no undo.

import type { PrivateKeyAccount } from "viem";

export class SignatureRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureRefused";
  }
}

/// The shape `CarbonmarkX402Adapter` hands to its `sign` callback.
interface TypedDataPayload {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/// Build a signer bound to one account and one hard ceiling.
///
/// `maxValueUsdc` is expressed in whole USDC and compared against the
/// authorisation's `value`, which USDC denominates in 6-decimal atomic units.
/// The conversion happens here rather than at the call site so a caller cannot
/// accidentally authorise a million times what they meant.
export function makeRetirementSigner(
  account: PrivateKeyAccount,
  maxValueUsdc: number,
): (typedData: TypedDataPayload) => Promise<string> {
  return async (typedData) => {
    const message = typedData.message;

    // The authorisation must be from the account doing the signing. A payload
    // naming someone else is either a mistake or an attempt to have this key
    // endorse a third party's spend.
    const from = String(message["from"] ?? "");
    if (from.toLowerCase() !== account.address.toLowerCase()) {
      throw new SignatureRefused(
        `authorisation is from ${from || "(unset)"} but this signer is ` +
          `${account.address} — refusing to sign for another account`,
      );
    }

    const rawValue = message["value"];
    if (rawValue === undefined || rawValue === null) {
      throw new SignatureRefused("authorisation has no value — refusing to sign a blank cheque");
    }

    const atomic = BigInt(String(rawValue));
    const ceiling = BigInt(Math.round(maxValueUsdc * 1_000_000));
    if (atomic > ceiling) {
      throw new SignatureRefused(
        `authorisation is for ${Number(atomic) / 1e6} USDC, ceiling is ` +
          `${maxValueUsdc} USDC — refusing to sign`,
      );
    }

    // The account signs; the key is never extracted back out of it.
    //
    // One cast, on the payload as a whole: the provider supplies the EIP-712
    // structure at runtime, so it cannot be statically typed here. Casting the
    // whole object rather than each field keeps the escape hatch in one place
    // and visible.
    type SignArgs = Parameters<typeof account.signTypedData>[0];
    return account.signTypedData(typedData as unknown as SignArgs);
  };
}
