/// Mapping an HS chapter to the carrier's own package category.
///
/// These are two different things and the distinction matters. The **HS code**
/// is the customs answer — what the goods legally are, determined by the
/// compliance engine and committed on-chain. The **carrier category** is a
/// routing hint that decides which couriers are offered, and it is the carrier's
/// private taxonomy of eleven buckets. One does not derive the other; this table
/// is a deliberate, reviewable approximation in one direction only.
///
/// Nothing here ever influences the classification. A category is chosen *after*
/// the HS code is decided, never to help decide it.
///
/// Categories are matched **by name, resolved to an id at runtime**. The ids are
/// account-specific — the sandbox account returns entirely different numbers
/// from the ones in Shipbubble's published example — so a hardcoded id would
/// work in development and quietly mis-route in production.

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

/// HS chapter (the first two digits of an HS-6) to carrier category.
///
/// Chapters absent from this table have no honest carrier equivalent and are
/// handled by refusing rather than by falling back to a general bucket — see
/// `categoryForHs6`.
const CHAPTER_TO_CATEGORY: Readonly<Record<string, CategoryName>> = {
  // Live animals and animal products
  "02": CATEGORY_NAMES.groceries, "03": CATEGORY_NAMES.groceries,
  "04": CATEGORY_NAMES.groceries, "05": CATEGORY_NAMES.dryFood,
  // Vegetable products
  "06": CATEGORY_NAMES.groceries, "07": CATEGORY_NAMES.groceries,
  "08": CATEGORY_NAMES.groceries, "09": CATEGORY_NAMES.dryFood,
  "10": CATEGORY_NAMES.dryFood, "11": CATEGORY_NAMES.dryFood,
  "12": CATEGORY_NAMES.dryFood, "13": CATEGORY_NAMES.dryFood,
  "14": CATEGORY_NAMES.dryFood, "15": CATEGORY_NAMES.groceries,
  // Prepared foodstuffs
  "16": CATEGORY_NAMES.groceries, "17": CATEGORY_NAMES.dryFood,
  "18": CATEGORY_NAMES.dryFood, "19": CATEGORY_NAMES.dryFood,
  "20": CATEGORY_NAMES.groceries, "21": CATEGORY_NAMES.dryFood,
  "22": CATEGORY_NAMES.groceries,
  // Chemicals and allied
  "30": CATEGORY_NAMES.medical, "33": CATEGORY_NAMES.healthBeauty,
  "34": CATEGORY_NAMES.healthBeauty,
  // Plastics, rubber
  "39": CATEGORY_NAMES.lightweight, "40": CATEGORY_NAMES.lightweight,
  // Leather, travel goods
  "42": CATEGORY_NAMES.fashion, "43": CATEGORY_NAMES.fashion,
  // Paper, printed matter
  "48": CATEGORY_NAMES.lightweight, "49": CATEGORY_NAMES.sensitive,
  // Textiles and apparel
  "50": CATEGORY_NAMES.fashion, "51": CATEGORY_NAMES.fashion,
  "52": CATEGORY_NAMES.fashion, "53": CATEGORY_NAMES.fashion,
  "54": CATEGORY_NAMES.fashion, "55": CATEGORY_NAMES.fashion,
  "56": CATEGORY_NAMES.lightweight, "57": CATEGORY_NAMES.furniture,
  "58": CATEGORY_NAMES.fashion, "59": CATEGORY_NAMES.lightweight,
  "60": CATEGORY_NAMES.fashion, "61": CATEGORY_NAMES.fashion,
  "62": CATEGORY_NAMES.fashion, "63": CATEGORY_NAMES.fashion,
  "64": CATEGORY_NAMES.fashion, "65": CATEGORY_NAMES.fashion,
  "66": CATEGORY_NAMES.fashion, "67": CATEGORY_NAMES.fashion,
  // Stone, ceramics, glass
  "69": CATEGORY_NAMES.furniture, "70": CATEGORY_NAMES.furniture,
  // Precious metals and stones
  "71": CATEGORY_NAMES.sensitive,
  // Base metals and articles
  "73": CATEGORY_NAMES.machinery, "76": CATEGORY_NAMES.machinery,
  "82": CATEGORY_NAMES.machinery, "83": CATEGORY_NAMES.machinery,
  // Machinery and electrical
  "84": CATEGORY_NAMES.machinery, "85": CATEGORY_NAMES.electronics,
  // Instruments
  "90": CATEGORY_NAMES.medical, "91": CATEGORY_NAMES.electronics,
  "92": CATEGORY_NAMES.electronics,
  // Miscellaneous manufactured
  "94": CATEGORY_NAMES.furniture, "95": CATEGORY_NAMES.lightweight,
  "96": CATEGORY_NAMES.lightweight,
};

/// Chapters a parcel carrier will not knowingly accept, or that require handling
/// this adapter does not implement.
///
/// Naming them explicitly is the point: an unmapped chapter and a forbidden one
/// are different outcomes and must not collapse into the same "unknown".
const REFUSED_CHAPTERS: Readonly<Record<string, string>> = {
  "01": "live animals",
  "24": "tobacco products",
  "27": "mineral fuels and oils",
  "28": "inorganic chemicals",
  "29": "organic chemicals",
  "31": "fertilisers",
  "36": "explosives and pyrotechnics",
  "93": "arms and ammunition",
  "97": "works of art and antiques",
};

export type CategoryResolution =
  | { readonly ok: true; readonly category: CategoryName }
  | { readonly ok: false; readonly reason: "refused"; readonly detail: string }
  | { readonly ok: false; readonly reason: "unmapped"; readonly detail: string };

/// Choose a carrier category for goods already classified to an HS-6.
///
/// Returns a refusal rather than a default. A general-purpose fallback bucket
/// would let goods a carrier forbids — explosives, live animals — be quoted and
/// bought as "light weight items", which is precisely the failure the
/// compliance gate exists to prevent.
export function categoryForHs6(hs6: string): CategoryResolution {
  if (!/^\d{6}$/.test(hs6)) {
    return { ok: false, reason: "unmapped", detail: `not an HS-6 code: ${hs6}` };
  }

  const chapter = hs6.slice(0, 2);

  const refused = REFUSED_CHAPTERS[chapter];
  if (refused !== undefined) {
    return { ok: false, reason: "refused", detail: refused };
  }

  const category = CHAPTER_TO_CATEGORY[chapter];
  if (category === undefined) {
    return {
      ok: false,
      reason: "unmapped",
      detail: `chapter ${chapter} has no carrier category`,
    };
  }

  return { ok: true, category };
}
