/// Mapping an HS chapter to the carrier's own package category.
///
/// This is **routing only**. It decides which couriers get offered, nothing
/// more. It does not decide whether goods may be shipped — that is a compliance
/// question, answered by the engine and recorded on-chain with a decision hash,
/// and by `policy.ts` for the carrier's own published rules. A routing table
/// that also refused would put a compliance decision somewhere no audit trail
/// can reach it.
///
/// The HS code is the customs answer: what the goods legally are. The carrier
/// category is a private taxonomy of eleven buckets. One does not derive the
/// other, and this table is a deliberate approximation in one direction only.
/// Nothing here ever influences a classification — a category is chosen *after*
/// the HS code is decided.
///
/// Categories are matched **by name, resolved to an id at runtime**. Ids are
/// account-specific: the sandbox account returns entirely different numbers from
/// Shipbubble's published example, so a hardcoded id would work in development
/// and quietly mis-route in production.

export const CATEGORY_NAMES = {
  hotFood: "Hot food",
  dryFood: "Dry food and supplements",
  electronics: "Electronics and gadgets",
  groceries: "Groceries",
  sensitive: "Sensitive items (ATM cards, documents)",
  lightweight: "Light weight items",
  machinery: "Machinery",
  medical: "Medical supplies",
  healthBeauty: "Health and beauty",
  furniture: "Furniture and fittings",
  fashion: "Fashion wears",
} as const;

export type CategoryName = (typeof CATEGORY_NAMES)[keyof typeof CATEGORY_NAMES];

/// Chapter 77 is reserved for future use by the WCO and has no goods in it.
/// A code claiming to be in it is malformed, not merely unmapped.
const RESERVED_CHAPTERS = new Set(["77"]);

/// Every HS chapter that carries goods, mapped to a routing bucket.
///
/// Complete by construction: a test asserts that chapters 01-97, other than the
/// reserved one, all resolve. An unmapped chapter used to mean common goods —
/// vehicle parts, leather, wood, base metals — could not be quoted at all.
const CHAPTER_TO_CATEGORY: Readonly<Record<string, CategoryName>> = {
  // I. Live animals; animal products
  "01": CATEGORY_NAMES.groceries, "02": CATEGORY_NAMES.groceries,
  "03": CATEGORY_NAMES.groceries, "04": CATEGORY_NAMES.groceries,
  "05": CATEGORY_NAMES.dryFood,
  // II. Vegetable products
  "06": CATEGORY_NAMES.groceries, "07": CATEGORY_NAMES.groceries,
  "08": CATEGORY_NAMES.groceries, "09": CATEGORY_NAMES.dryFood,
  "10": CATEGORY_NAMES.dryFood, "11": CATEGORY_NAMES.dryFood,
  "12": CATEGORY_NAMES.dryFood, "13": CATEGORY_NAMES.dryFood,
  "14": CATEGORY_NAMES.dryFood,
  // III. Fats and oils
  "15": CATEGORY_NAMES.groceries,
  // IV. Prepared foodstuffs, beverages, tobacco
  "16": CATEGORY_NAMES.groceries, "17": CATEGORY_NAMES.dryFood,
  "18": CATEGORY_NAMES.dryFood, "19": CATEGORY_NAMES.dryFood,
  "20": CATEGORY_NAMES.groceries, "21": CATEGORY_NAMES.dryFood,
  "22": CATEGORY_NAMES.groceries, "23": CATEGORY_NAMES.dryFood,
  "24": CATEGORY_NAMES.dryFood,
  // V. Mineral products
  "25": CATEGORY_NAMES.lightweight, "26": CATEGORY_NAMES.machinery,
  "27": CATEGORY_NAMES.machinery,
  // VI. Chemicals
  "28": CATEGORY_NAMES.lightweight, "29": CATEGORY_NAMES.lightweight,
  "30": CATEGORY_NAMES.medical, "31": CATEGORY_NAMES.lightweight,
  "32": CATEGORY_NAMES.lightweight, "33": CATEGORY_NAMES.healthBeauty,
  "34": CATEGORY_NAMES.healthBeauty, "35": CATEGORY_NAMES.lightweight,
  "36": CATEGORY_NAMES.lightweight, "37": CATEGORY_NAMES.electronics,
  "38": CATEGORY_NAMES.lightweight,
  // VII. Plastics and rubber
  "39": CATEGORY_NAMES.lightweight, "40": CATEGORY_NAMES.lightweight,
  // VIII. Hides, leather, travel goods
  "41": CATEGORY_NAMES.fashion, "42": CATEGORY_NAMES.fashion,
  "43": CATEGORY_NAMES.fashion,
  // IX. Wood, cork, basketware
  "44": CATEGORY_NAMES.furniture, "45": CATEGORY_NAMES.lightweight,
  "46": CATEGORY_NAMES.furniture,
  // X. Pulp, paper, printed matter
  "47": CATEGORY_NAMES.lightweight, "48": CATEGORY_NAMES.lightweight,
  "49": CATEGORY_NAMES.sensitive,
  // XI. Textiles
  "50": CATEGORY_NAMES.fashion, "51": CATEGORY_NAMES.fashion,
  "52": CATEGORY_NAMES.fashion, "53": CATEGORY_NAMES.fashion,
  "54": CATEGORY_NAMES.fashion, "55": CATEGORY_NAMES.fashion,
  "56": CATEGORY_NAMES.lightweight, "57": CATEGORY_NAMES.furniture,
  "58": CATEGORY_NAMES.fashion, "59": CATEGORY_NAMES.lightweight,
  "60": CATEGORY_NAMES.fashion, "61": CATEGORY_NAMES.fashion,
  "62": CATEGORY_NAMES.fashion, "63": CATEGORY_NAMES.fashion,
  // XII. Footwear, headgear, umbrellas
  "64": CATEGORY_NAMES.fashion, "65": CATEGORY_NAMES.fashion,
  "66": CATEGORY_NAMES.fashion, "67": CATEGORY_NAMES.fashion,
  // XIII. Stone, ceramics, glass
  "68": CATEGORY_NAMES.furniture, "69": CATEGORY_NAMES.furniture,
  "70": CATEGORY_NAMES.furniture,
  // XIV. Precious metals and stones
  "71": CATEGORY_NAMES.sensitive,
  // XV. Base metals
  "72": CATEGORY_NAMES.machinery, "73": CATEGORY_NAMES.machinery,
  "74": CATEGORY_NAMES.machinery, "75": CATEGORY_NAMES.machinery,
  "76": CATEGORY_NAMES.machinery, "78": CATEGORY_NAMES.machinery,
  "79": CATEGORY_NAMES.machinery, "80": CATEGORY_NAMES.machinery,
  "81": CATEGORY_NAMES.machinery, "82": CATEGORY_NAMES.machinery,
  "83": CATEGORY_NAMES.machinery,
  // XVI. Machinery and electrical equipment
  "84": CATEGORY_NAMES.machinery, "85": CATEGORY_NAMES.electronics,
  // XVII. Vehicles, aircraft, vessels
  "86": CATEGORY_NAMES.machinery, "87": CATEGORY_NAMES.machinery,
  "88": CATEGORY_NAMES.machinery, "89": CATEGORY_NAMES.machinery,
  // XVIII. Instruments, clocks, musical instruments
  "90": CATEGORY_NAMES.medical, "91": CATEGORY_NAMES.electronics,
  "92": CATEGORY_NAMES.electronics,
  // XIX-XXI. Arms, miscellaneous, art
  "93": CATEGORY_NAMES.sensitive, "94": CATEGORY_NAMES.furniture,
  "95": CATEGORY_NAMES.lightweight, "96": CATEGORY_NAMES.lightweight,
  "97": CATEGORY_NAMES.sensitive,
};

export type CategoryResolution =
  | { readonly ok: true; readonly category: CategoryName }
  | { readonly ok: false; readonly reason: "malformed"; readonly detail: string };

/// Choose a routing category for goods already classified to an HS-6.
///
/// The only failure is a code that is not a real HS-6. Whether the goods may be
/// shipped at all is asked separately — see `isAcceptable` in `policy.ts`.
export function categoryForHs6(hs6: string): CategoryResolution {
  if (!/^\d{6}$/.test(hs6)) {
    return { ok: false, reason: "malformed", detail: `not an HS-6 code: ${hs6}` };
  }

  const chapter = hs6.slice(0, 2);

  if (RESERVED_CHAPTERS.has(chapter)) {
    return {
      ok: false,
      reason: "malformed",
      detail: `chapter ${chapter} is reserved by the WCO and holds no goods`,
    };
  }

  const category = CHAPTER_TO_CATEGORY[chapter];
  if (category === undefined) {
    return {
      ok: false,
      reason: "malformed",
      detail: `chapter ${chapter} is not an HS chapter`,
    };
  }

  return { ok: true, category };
}
