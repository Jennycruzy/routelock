/// The carrier's own published acceptance policy, as a check over HS codes.
///
/// **Source:** Shipbubble acceptable products and use policy, "Prohibited
/// products", at <https://shipbubble.com/terms-and-conditions>, read 14 August
/// 2026. The goods-based clause is quoted verbatim below. Every rule in this
/// file traces to that sentence; nothing here is inferred from general knowledge
/// about what carriers usually refuse.
///
/// > Products that are, or appear to be, restricted by law or regulation,
/// > including products that require specific licenses to store or distribute,
/// > including, but not limited to, **live plants and animals, alcoholic
/// > beverages, prescription pharmaceuticals, ammunition and firearms,
/// > tobacco**.
///
/// This is a **carrier acceptance** question — will this carrier move these
/// goods — and it is distinct from the **customs** question of whether the goods
/// may lawfully cross a border. The compliance engine answers the second and
/// commits its verdict on-chain. Both can refuse, for different reasons, and
/// collapsing them would lose the reason.
///
/// The policy's other eight clauses (child exploitation, hate, IP infringement,
/// malware, personal data, self-harm, terrorism, illegality generally) describe
/// the *content or purpose* of goods rather than their tariff classification.
/// An HS code cannot express them, so they are deliberately **not** encoded
/// here — they belong to the compliance engine, which reads a description.

/// A prohibition traceable to a specific phrase in the published policy.
interface Prohibition {
  /// The phrase from the policy this rule implements.
  readonly clause: string;
  /// Why these HS codes fall under it.
  readonly reason: string;
}

/// Whole chapters the policy's named categories cover.
const PROHIBITED_CHAPTERS: Readonly<Record<string, Prohibition>> = {
  "01": {
    clause: "live plants and animals",
    reason: "chapter 01 is live animals",
  },
  "06": {
    clause: "live plants and animals",
    reason: "chapter 06 is live trees and other plants",
  },
  "24": {
    clause: "tobacco",
    reason: "chapter 24 is tobacco and manufactured tobacco substitutes",
  },
  "30": {
    clause: "prescription pharmaceuticals",
    reason: "chapter 30 is pharmaceutical products",
  },
  "93": {
    clause: "ammunition and firearms",
    reason: "chapter 93 is arms and ammunition",
  },
};

/// Headings, not chapters, because chapter 22 mixes prohibited and ordinary
/// goods: 2201 and 2202 are water and soft drinks, while 2203 through 2208 are
/// beer, wine, spirits and other alcoholic beverages. Refusing the whole chapter
/// would block bottled water; permitting it would ship whisky.
const PROHIBITED_HEADINGS: Readonly<Record<string, Prohibition>> = {
  "2203": { clause: "alcoholic beverages", reason: "beer made from malt" },
  "2204": { clause: "alcoholic beverages", reason: "wine of fresh grapes" },
  "2205": { clause: "alcoholic beverages", reason: "vermouth" },
  "2206": { clause: "alcoholic beverages", reason: "other fermented beverages" },
  "2207": { clause: "alcoholic beverages", reason: "undenatured ethyl alcohol" },
  "2208": { clause: "alcoholic beverages", reason: "spirits and liqueurs" },
};

export type AcceptanceResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly clause: string;
      readonly reason: string;
      readonly source: string;
    };

export const POLICY_SOURCE =
  "Shipbubble acceptable products and use policy, " +
  "https://shipbubble.com/terms-and-conditions (read 2026-08-14)";

/// Would this carrier accept goods of this classification?
///
/// A refusal names the clause it came from, so the decision can be shown to the
/// person it affects and checked against the published policy rather than taken
/// on trust.
///
/// This answers only what the carrier's policy states about *classes of goods*.
/// It is not a customs determination and it is not a judgement about a specific
/// consignment — a description that reveals a prohibited purpose is the
/// compliance engine's to catch.
export function isAcceptable(hs6: string): AcceptanceResult {
  if (!/^\d{6}$/.test(hs6)) {
    return {
      ok: false,
      clause: "not applicable",
      reason: `not an HS-6 code: ${hs6}`,
      source: POLICY_SOURCE,
    };
  }

  const heading = PROHIBITED_HEADINGS[hs6.slice(0, 4)];
  if (heading !== undefined) {
    return { ok: false, ...heading, source: POLICY_SOURCE };
  }

  const chapter = PROHIBITED_CHAPTERS[hs6.slice(0, 2)];
  if (chapter !== undefined) {
    return { ok: false, ...chapter, source: POLICY_SOURCE };
  }

  return { ok: true };
}
