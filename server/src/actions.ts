// Actions for the Credit Card Coupon Book Dashboard.
//
// Data model: Plaid (via the connector CLI, read by an agent task or by the
// initial seed import) supplies card accounts and the actual statement-credit
// postings the issuer paid out. Usage is computed ONLY from those postings — never
// inferred from merchant spending. The credit catalog (amount + calendar
// period per card product) is seeded on first import and fully editable.

import { defineAction, z, type ActionsModule, type SpaceDb } from "@hatch/space-sdk";
import { asc, desc, eq, isNull } from "drizzle-orm";
import * as schema from "./schema";
import { effectiveEnding, renderAgentMarkdown } from "./agentMarkdown";

// ---------------------------------------------------------------------------
// Catalog seed: current published Amex benefit terms per card product.
// Every row is a default the user can edit (amount, period, enrolled, active).
// ---------------------------------------------------------------------------

export type Period = "monthly" | "quarterly" | "semiannual" | "annual";
type CreditDef = {
  name: string;
  amount: number;
  period: Period;
  pattern: string;
  note?: string;
  /**
   * True when the issuer requires enrolling in the benefit before use:
   * the credit pays out only after enrollment. This is a catalog fact
   * about the benefit — distinct from the per-row `enrolled` state the
   * user tracks — and it drives the enrollment notice in the credit's
   * expanded detail (dashboard UI and Agent Markdown).
   */
  enrollmentRequired?: boolean;
  /**
   * The enrollment notice shown in the expanded detail when
   * enrollmentRequired is true (a full sentence, starting with
   * "Enrollment required:"). Falls back to DEFAULT_ENROLLMENT_NOTE.
   */
  enrollmentNote?: string;
  /**
   * Anniversary anchor (e.g. 5/1) for credits whose cycle runs on the
   * cardmember year instead of the calendar: annual credits run
   * anchor-to-anchor, semiannual credits run in two 6-month halves from
   * the anchor. The values in this catalog are PLACEHOLDER defaults —
   * every cardholder's real anniversary differs — so rows seeded from
   * them start with the anchor UNCONFIRMED and the dashboard warns
   * until the user confirms or corrects it (see anchorConfirmed).
   */
  anchorMonth?: number;
  anchorDay?: number;
};

const BIZ_PLAT: CreditDef[] = [
  { name: "Hotel Credit (FHR / Hotel Collection)", amount: 300, period: "semiannual", pattern: "hotel credit", note: "Prepaid FHR or The Hotel Collection via Amex Travel; Hotel Collection needs 2+ nights" },
  { name: "Hilton Credit", amount: 50, period: "quarterly", pattern: "hilton", note: "Direct Hilton purchases; needs Hilton for Business enrollment", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll the card in Hilton for Business first — Hilton purchases count toward the credit only after enrollment" },
  { name: "Dell Credit", amount: 150, period: "annual", pattern: "dell", note: "Plus $1,000 more after $5,000 of Dell spend in the year", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll the card in the Dell credit first — Dell purchases count toward the credit only after enrollment" },
  { name: "Airline Fee Credit", amount: 200, period: "annual", pattern: "airline fee", note: "Incidentals on your one selected airline", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll and select a single qualifying airline — only that airline's incidental charges count toward the credit, and the airline selection can be changed each January" },
  { name: "Wireless Credit", amount: 10, period: "monthly", pattern: "wireless", note: "U.S. wireless provider paid directly — your mobile phone bill credit" },
];

const PERSONAL_PLAT: CreditDef[] = [
  { name: "Hotel Credit (FHR / Hotel Collection)", amount: 300, period: "semiannual", pattern: "hotel credit", note: "Prepaid FHR or The Hotel Collection via Amex Travel; Hotel Collection needs 2+ nights" },
  { name: "Resy Credit", amount: 100, period: "quarterly", pattern: "resy", note: "U.S. Resy restaurants; enrollment required", enrollmentRequired: true },
  { name: "Lululemon Credit", amount: 75, period: "quarterly", pattern: "lululemon", note: "U.S. lululemon stores (excl. outlets) and online" },
  { name: "Airline Fee Credit", amount: 200, period: "annual", pattern: "airline fee", note: "Incidentals on your one selected airline", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll and select a single qualifying airline — only that airline's incidental charges count toward the credit, and the airline selection can be changed each January" },
  { name: "Oura Ring Credit", amount: 200, period: "annual", pattern: "oura", note: "Oura Ring hardware only, via ouraring.com" },
  { name: "Uber One Credit", amount: 120, period: "annual", pattern: "uber one", note: "Auto-renewing Uber One membership paid with this card" },
];

const ASPIRE: CreditDef[] = [
  { name: "Flight Credit", amount: 50, period: "quarterly", pattern: "flight credit", note: "Flights booked directly with airlines or Amex Travel" },
  // Amex runs the resort credit on CALENDAR halves — $200 from
  // January through June and another $200 from July through December
  // (per the benefit terms for the Aspire card) — NOT on the
  // cardmember year. It therefore carries no anniversary anchor,
  // unlike the Chase and U.S. Bank credits below.
  { name: "Hilton Resort Credit", amount: 200, period: "semiannual", pattern: "hilton", note: "At participating Hilton resorts. Amex runs this on calendar halves — $200 from January through June and another $200 from July through December; your account anniversary does not affect it" },
];

const BRILLIANT: CreditDef[] = [
  { name: "Dining Credit", amount: 25, period: "monthly", pattern: "dining", note: "Restaurants worldwide, up to $25 back per month" },
  // The $300 Property Credit is deliberately absent: Marriott ended
  // that benefit long ago, so it is not a live credit and is not tracked.
];

const BIZ_GOLD: CreditDef[] = [
  { name: "Flexible Business Credit", amount: 20, period: "monthly", pattern: "flexible", note: "Grubhub, FedEx, and U.S. office supply stores — the $20/mo office supply credit" },
];

// ---------------------------------------------------------------------------
// Chase catalog: published benefit terms per Chase card product. Chase
// coupons mostly run on the cardmember anniversary year (anchored to the
// account anniversary, May 1 for these defaults — edit the credit's anchor
// if yours differs), not the calendar year.
// ---------------------------------------------------------------------------

const SAPPHIRE_PREFERRED: CreditDef[] = [
  { name: "Annual Hotel Credit", amount: 100, period: "annual", anchorMonth: 5, anchorDay: 1, pattern: "annual hotel credit", note: "Hotel bookings through Chase Travel only; runs on the cardmember anniversary year" },
];

const HYATT_BUSINESS: CreditDef[] = [
  // The statement credit posts under the generic name "CREDIT ADJUSTMENT".
  // Matching is always scoped to the account's own credits, so this pattern
  // only ever fires on this card.
  { name: "Hyatt Credit", amount: 100, period: "annual", anchorMonth: 5, anchorDay: 1, pattern: "credit adjustment", note: "$50 back per $50+ purchase at Hyatt properties, up to 2x per anniversary year" },
];

const IHG_PREMIER: CreditDef[] = [
  { name: "Airline Credit", amount: 100, period: "annual", pattern: "airline credit", note: "Posts when a single flight purchase of $250+ is made directly with the airline" },
];

const RITZ_CARLTON: CreditDef[] = [
  { name: "Travel Credit", amount: 300, period: "annual", pattern: "travel credit", note: "Airline incidentals only; NOT automatic — request it via J.P. Morgan Priority Services within 4 billing cycles of the purchase" },
];

// ---------------------------------------------------------------------------
// U.S. Bank catalog: published benefit terms per U.S. Bank card product.
// U.S. Bank is the awkward issuer for identification: Plaid returns a
// generic account name ("Credit Card - 7536") for its cards, so
// catalogFor can only fire when the account name actually carries the
// product name. For generically named accounts the product is
// identified by evidence instead — the $400 annual fee and the "Annual
// Travel/dining Credit" postings — and the credit row is created from
// this definition during setup (see SETUP_FOR_MUSE.md).
// ---------------------------------------------------------------------------

const ALTITUDE_RESERVE: CreditDef[] = [
  // The bank reimburses each qualifying travel charge with its own
  // small posting until the $325 cardmember-year allowance is used up
  // (the postings are still named "Annual Travel/dining Credit" from
  // the years when dining was covered too). "Real-time Rewards Credit"
  // postings are points redemptions, NOT this credit — the pattern
  // below never matches them.
  { name: "Travel Credit", amount: 325, period: "annual", anchorMonth: 5, anchorDay: 1, pattern: "travel/dining credit", note: "Current policy: the $325 annual credit covers only travel purchases made through the U.S. Bank Travel Center — dining is no longer eligible. Each qualifying purchase is reimbursed with its own small 'Annual Travel/dining Credit' posting until $325 is used for the cardmember year (the posting name is a leftover from earlier cardmember years, when dining purchases were reimbursed too). If a reimbursed purchase is refunded, the credit for it reverses and the year's room reopens — the year is tracked net. The cycle is the cardmember anniversary year — the May 1 anchor is a placeholder default; set it to the date your $400 annual fee posts" },
];

// ---------------------------------------------------------------------------
// Non-seeded catalog credits: the benefit families the dashboard hides by
// default (ChatGPT Business, Indeed, Adobe, CLEAR+, Equinox, digital
// entertainment, Walmart+). These are real published benefits of the
// products below, but they are deliberately NOT part of the seeded catalogs
// above: import never writes rows for them, so import-time matching can
// never assign a posting to them (there is no row id to point at).
// Instead, computeDashboard synthesizes dashboard instances for them
// at read time (merged with stored rows — a stored row for the same
// account + name wins) and attributes unassigned postings to those
// instances by their match patterns, also at read time. That is what
// lets the exclusion preference name them in "Hidden by preference" and
// un-hide them on ANY deployment —
// including long-running ones whose accounts were imported before these
// families existed and therefore never materialized stored rows.
// ---------------------------------------------------------------------------

const BIZ_PLAT_NON_SEEDED: CreditDef[] = [
  { name: "ChatGPT Business Credit", amount: 300, period: "annual", pattern: "chatgpt", note: "ChatGPT Business subscription credit; each business card enrolls separately", enrollmentRequired: true, enrollmentNote: "Enrollment required: each card must be enrolled in the ChatGPT Business credit separately — a card's credit only pays out after that card is enrolled" },
  { name: "Indeed Credit", amount: 200, period: "annual", pattern: "indeed", note: "U.S. purchases with Indeed", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll the card in the Indeed credit first — Indeed purchases count toward the credit only after enrollment" },
  { name: "Adobe Credit", amount: 150, period: "annual", pattern: "adobe", note: "Adobe Creative Cloud / Acrobat purchases", enrollmentRequired: true, enrollmentNote: "Enrollment required: enroll the card in the Adobe credit first — Adobe purchases count toward the credit only after enrollment" },
];

const BIZ_GOLD_NON_SEEDED: CreditDef[] = [
  { name: "ChatGPT Business Credit", amount: 300, period: "annual", pattern: "chatgpt", note: "ChatGPT Business subscription credit; each business card enrolls separately", enrollmentRequired: true, enrollmentNote: "Enrollment required: each card must be enrolled in the ChatGPT Business credit separately — a card's credit only pays out after that card is enrolled" },
];

const PERSONAL_PLAT_NON_SEEDED: CreditDef[] = [
  { name: "CLEAR+ Credit", amount: 209, period: "annual", pattern: "clear", note: "CLEAR+ membership charges" },
  { name: "Equinox Credit", amount: 300, period: "annual", pattern: "equinox", note: "Equinox club memberships and the Equinox+ app; enrollment required", enrollmentRequired: true },
  { name: "Digital Entertainment Credit", amount: 25, period: "monthly", pattern: "entertainment", note: "Monthly credit across the eligible streaming services; enrollment required", enrollmentRequired: true },
  { name: "Walmart+ Credit", amount: 12.95, period: "monthly", pattern: "walmart", note: "Monthly Walmart+ membership fee; enrollment required", enrollmentRequired: true },
];

/**
 * The non-seeded (synthesis-only) catalog credits for a card product,
 * using the same product detection order as catalogFor. Returns [] for
 * products that carry none of the default-hidden families.
 */
export function nonSeededDefsFor(accountName: string): CreditDef[] {
  const n = accountName.toLowerCase();
  if (n.includes("business platinum")) return BIZ_PLAT_NON_SEEDED;
  if (n.includes("business gold")) return BIZ_GOLD_NON_SEEDED;
  if (n.includes("platinum")) return PERSONAL_PLAT_NON_SEEDED;
  return [];
}

// ---------------------------------------------------------------------------
// Display preferences:
// - Hidden credits: a stored user preference (meta key `excludedCredits`,
//   a JSON list of lowercase name patterns). A credit whose name contains
//   any pattern (case-insensitive substring) is filtered out of the
//   dashboard list and out of every total. Stored rows stay in the DB
//   (their postings stay assigned, so nothing leaks into Unassigned);
//   credits with no stored row are synthesized at read time (see
//   computeDashboard), so un-hiding restores either kind exactly. When
//   the preference has never been set,
//   DEFAULT_EXCLUDED_PATTERNS applies — the built-in list covering
//   ChatGPT Business, Indeed, Adobe, CLEAR+, Equinox, digital
//   entertainment, Walmart+, and Instacart. Once the user saves their own selection
//   (including an empty one = show everything), it is authoritative and
//   the built-in list never applies again.
//   The list is NOT hardcoded: the dashboard page has a Display settings
//   section with a toggle per hideable family (HIDEABLE_FAMILIES), and
//   the user's assistant can also change it from chat. Both paths go
//   through the same getPreferences / setExcludedCredits actions and the
//   same stored preference — there is no second storage path.
// - Always display: Business Gold Flexible Business Credit ($20/mo, office
//   supply) and Business Platinum Wireless Credit ($10/mo, mobile phone
//   bill). These are pinned active in the dashboard view even if an earlier
//   "stop tracking" toggled them off.
// ---------------------------------------------------------------------------

/** Meta key holding the exclusion preference (JSON array of patterns). */
export const EXCLUDED_CREDITS_META_KEY = "excludedCredits";

/** Built-in exclusion list, in force until the user stores a preference. */
export const DEFAULT_EXCLUDED_PATTERNS = [
  "chatgpt",
  "indeed",
  "adobe",
  "clear",
  "equinox",
  "entertainment",
  "walmart",
  "instacart",
];

/**
 * The credit families the user can hide or show: the canonical toggle
 * list behind the dashboard's Display settings section. `pattern` is the
 * exclusion entry toggling the family on writes into the preference;
 * `label` is the human-readable credit name shown next to the toggle.
 * The first eight are the families the built-in defaults hide; the rest
 * start out shown but can be hidden the same way.
 * setExcludedCredits validation accepts an entry when it matches one of
 * these labels (or a catalog / stored credit name).
 */
export const HIDEABLE_FAMILIES: { pattern: string; label: string }[] = [
  { pattern: "chatgpt", label: "ChatGPT Business Credit" },
  { pattern: "indeed", label: "Indeed Credit" },
  { pattern: "adobe", label: "Adobe Credit" },
  { pattern: "clear", label: "CLEAR+ Credit" },
  { pattern: "equinox", label: "Equinox Credit" },
  { pattern: "entertainment", label: "Digital Entertainment Credit" },
  { pattern: "walmart", label: "Walmart+ Credit" },
  { pattern: "instacart", label: "Instacart Credit" },
  { pattern: "global entry", label: "Global Entry Credit" },
  { pattern: "farelock", label: "FareLock Credit" },
];

/** Canonical display names of the hideable families (derived, see above). */
export const HIDEABLE_CREDIT_NAMES = HIDEABLE_FAMILIES.map((f) => f.label);

/** Every credit name in the built-in catalogs (all products). */
const ALL_CATALOG_CREDIT_NAMES: string[] = [
  BIZ_PLAT,
  PERSONAL_PLAT,
  ASPIRE,
  BRILLIANT,
  BIZ_GOLD,
  SAPPHIRE_PREFERRED,
  HYATT_BUSINESS,
  IHG_PREMIER,
  RITZ_CARLTON,
  ALTITUDE_RESERVE,
].flatMap((defs) => defs.map((d) => d.name));

export function isExcludedName(
  name: string,
  patterns: readonly string[] = DEFAULT_EXCLUDED_PATTERNS,
): boolean {
  const n = name.toLowerCase();
  return patterns.some((p) => p !== "" && n.includes(p));
}

/**
 * Parse the stored exclusion preference. Returns null when it was never
 * set (or is unreadable) — the caller then falls back to
 * DEFAULT_EXCLUDED_PATTERNS. A stored empty array is meaningful (the user
 * un-hid everything) and returns [].
 */
export function parseExcludedPatterns(
  raw: string | null | undefined,
): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") return null;
      const p = v.trim().toLowerCase();
      if (p !== "" && !out.includes(p)) out.push(p);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether an exclusion entry is a CANONICAL entry: exactly (modulo case
 * and surrounding whitespace) one of the canonical entries the caller
 * supplies — a hideable family's pattern or label, a full catalog credit
 * name, or a full stored credit name. Fragments are NOT valid entries:
 * the read-time matcher treats entries as substrings of credit names,
 * so a fragment like "credit" or "air" would hide nearly everything;
 * write-time validation is where that is stopped.
 */
export function isKnownExclusionEntry(
  entry: string,
  canonicalEntries: readonly string[],
): boolean {
  const e = entry.trim().toLowerCase();
  if (e === "") return false;
  return canonicalEntries.some((n) => n.trim().toLowerCase() === e);
}

export function isPinnedCredit(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("flexible business") || n.includes("wireless");
}

// ---------------------------------------------------------------------------
// Login ownership: the two Plaid Amex logins are two different master
// accounts (for example, two people in one household). Accounts store an
// owner KEY — "A" for the first login, "B" for the second — never a name.
// The display labels for the keys come from the meta settings `ownerALabel`
// and `ownerBLabel` (defaults "Login 1" / "Login 2"; editable via the
// setOwnerLabels action), so nothing person-specific is baked into the
// code or the database. A stored value that is not a known key is already
// a label and is shown verbatim.
// ---------------------------------------------------------------------------

export const DEFAULT_OWNER_LABELS: [string, string] = ["Login 1", "Login 2"];

export function ownerLabelFor(
  ownerKey: string | null,
  labels: [string, string],
): string | null {
  if (ownerKey == null || ownerKey === "") return null;
  if (ownerKey === "A") return labels[0];
  if (ownerKey === "B") return labels[1];
  return ownerKey;
}

export function catalogFor(accountName: string): CreditDef[] | null {  const n = accountName.toLowerCase();
  // Chase products first: their names never contain the Amex product
  // keywords below, but checking them first keeps the issuers unambiguous.
  if (n.includes("sapphire preferred")) return SAPPHIRE_PREFERRED;
  if (n.includes("world of hyatt") && n.includes("business")) return HYATT_BUSINESS;
  if (n.includes("ihg") && n.includes("premier")) return IHG_PREMIER;
  if (n.includes("ritz-carlton")) return RITZ_CARLTON;
  // U.S. Bank: fires only when the name carries the product — U.S. Bank
  // usually reports a generic name instead (see the catalog section).
  // Matched on "altitude" alone: the product name carries a ® in the
  // middle ("Altitude® Reserve"), so the two-word phrase never matches.
  if (n.includes("altitude")) return ALTITUDE_RESERVE;
  if (n.includes("business platinum")) return BIZ_PLAT;
  if (n.includes("aspire")) return ASPIRE;
  if (n.includes("brilliant")) return BRILLIANT;
  if (n.includes("business gold")) return BIZ_GOLD;
  if (n.includes("platinum")) return PERSONAL_PLAT; // incl. co-branded Platinum variants
  return null;
}

/**
 * The catalog's default display name for a card product: the short label
 * credit rows and the Agent Markdown show for an account when the user
 * has not set a nickname. Detection uses the same name substrings as
 * catalogFor, in the same order.
 *
 * Only Chase and U.S. Bank products are listed: those are the issuers
 * whose aggregator account names routinely come back generic ("CREDIT
 * CARD", a cardholder's name, "Credit Card - 7536"), which is what used
 * to force users to hand-set a nickname for every such card. Amex
 * account names already carry the product, so they return null and the
 * account name stands. A user-set nickname always wins over this
 * default; the default in turn wins over the raw account name.
 */
export function defaultNameFor(accountName: string): string | null {
  const n = accountName.toLowerCase();
  if (n.includes("sapphire preferred")) return "CSP";
  if (n.includes("world of hyatt") && n.includes("business")) return "HyattBus";
  if (n.includes("world of hyatt")) return "Hyatt";
  if (n.includes("ihg") && n.includes("premier")) return "IHG-Premier";
  if (n.includes("ihg") && n.includes("select")) return "IHG-Select";
  if (n.includes("ihg")) return "IHG";
  if (n.includes("ritz")) return "Ritz";
  if (n.includes("boundless")) return "Boundless";
  if (n.includes("bonvoy") && n.includes("business")) return "BonvoyBus";
  if (n.includes("united") && n.includes("business")) return "UABus";
  if (n.includes("united") && n.includes("explorer")) return "UA";
  if (n.includes("aeroplan")) return "Aeroplan";
  if (n.includes("altitude")) return "UAR";
  if (n.includes("triple cash")) return "TripleCash";
  return null;
}

/** Enrollment notice for defs that set enrollmentRequired without their own enrollmentNote. */
export const DEFAULT_ENROLLMENT_NOTE =
  "Enrollment required: enroll this card in the benefit first — the credit only pays out after enrollment.";

/**
 * Catalog enrollment metadata for one credit instance: whether the
 * issuer requires enrolling in the benefit before use, and the notice
 * the expanded detail should show. Resolved from the catalog defs by
 * (account product, credit name) so a stored row and a synthesized
 * instance of the same credit report it identically. A credit whose
 * name matches no def on the account's product (e.g. a user-created
 * row) reports not-required.
 */
export function enrollmentInfoFor(
  accountName: string,
  creditName: string,
): { required: boolean; note: string | null } {
  const key = creditName.trim().toLowerCase();
  const defs = [
    ...(catalogFor(accountName) ?? []),
    ...nonSeededDefsFor(accountName),
  ];
  const def = defs.find((d) => d.name.trim().toLowerCase() === key);
  if (!def?.enrollmentRequired) return { required: false, note: null };
  return { required: true, note: def.enrollmentNote ?? DEFAULT_ENROLLMENT_NOTE };
}

/**
 * Auto-mapping rule for imported postings: the first of the account's
 * credits whose non-empty match pattern is a case-insensitive substring of
 * the posting name wins. Returns undefined when nothing matches (the
 * posting stays unassigned for manual review).
 */
export function matchCreditForPosting<T extends { matchPattern: string }>(
  credits: readonly T[],
  postingName: string,
): T | undefined {
  const lower = postingName.toLowerCase();
  return credits.find(
    (c) => c.matchPattern !== "" && lower.includes(c.matchPattern.toLowerCase()),
  );
}

/** Issuer ("Amex" / "Chase" / "U.S. Bank") for a card, inferred from its product name. */
export function issuerForAccountName(accountName: string): string {
  const n = accountName.toLowerCase();
  if (n.includes("u.s. bank") || n.includes("altitude")) {
    return "U.S. Bank";
  }
  if (
    n.includes("chase") ||
    n.includes("sapphire") ||
    n.includes("ritz-carlton") ||
    n.includes("ihg") ||
    n.includes("world of hyatt")
  ) {
    return "Chase";
  }
  return "Amex";
}

/**
 * Suspected-duplicate detection — a flag for the user to decide on,
 * never an automatic action. Two account records are suspected of being
 * two views of one underlying account (e.g. the primary card and a
 * supplementary-card record seen from both logins) when either:
 *  - the same-ending heuristic fires (computed here, read-time): same
 *    product name + same EFFECTIVE ending (the mask, with the
 *    user-recorded fifth digit counting — two records whose five-digit
 *    endings differ are demonstrably different cards) + the SAME owner.
 *    The heuristic never crosses owners: the owner label already tells
 *    two people's same-ending cards apart, so a spouse's card needs no
 *    marking (and no fifth digit). Unattributed records (owner null)
 *    form one bucket, like any other owner.
 *  - import recorded transaction evidence for the pair (a transaction id
 *    arrived under one record while already stored under the other —
 *    i.e. one record's transactions are a subset of the other's; the
 *    evidence is gathered in importSnapshot, since transaction ids are
 *    globally unique in the store and the subset relation itself can
 *    therefore never be recomputed from stored postings). Evidence is
 *    the stronger signal and applies regardless of owner.
 * Returns, per account id, the ids it is suspected of duplicating.
 * Ignored accounts take no part: an account the user already marked as
 * a duplicate is a settled decision.
 */
export function suspectedDuplicatesFor(
  accounts: readonly {
    id: number;
    name: string;
    mask: string;
    fifthDigit: string;
    owner: string | null;
    ignored: number;
  }[],
  evidencePairs: readonly (readonly [number, number])[],
): Map<number, number[]> {
  const active = accounts.filter((a) => a.ignored === 0);
  const activeIds = new Set(active.map((a) => a.id));
  const result = new Map<number, number[]>();
  const add = (id: number, other: number) => {
    if (id === other || !activeIds.has(id) || !activeIds.has(other)) return;
    const arr = result.get(id) ?? [];
    if (!arr.includes(other)) arr.push(other);
    result.set(id, arr);
  };
  const sameProductEnding = (
    a: (typeof active)[number],
    b: (typeof active)[number],
  ) =>
    a.mask !== "" &&
    (a.owner || null) === (b.owner || null) &&
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    effectiveEnding(a.mask, a.fifthDigit) === effectiveEnding(b.mask, b.fifthDigit);
  for (const a of active) {
    for (const b of active) {
      if (b.id !== a.id && sameProductEnding(a, b)) add(a.id, b.id);
    }
  }
  for (const [x, y] of evidencePairs) {
    add(x, y);
    add(y, x);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Calendar-period math (America/Los_Angeles calendar dates, YYYY-MM-DD).
// ---------------------------------------------------------------------------

/** Meta key holding the user's IANA timezone preference. */
export const TIMEZONE_META_KEY = "timezone";

/**
 * Default timezone for "today" and every period computation. It is the
 * historical behavior of this app; a user in another timezone sets their
 * own via the setTimezone action (stored under TIMEZONE_META_KEY), and
 * every computation follows it — period boundaries are local-midnight
 * boundaries, so the wrong zone shows the wrong period at the edges.
 */
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The stored timezone if it is a real IANA zone, else the default. */
export function resolveTimeZone(raw: string | null | undefined): string {
  return raw != null && raw !== "" && isValidTimeZone(raw) ? raw : DEFAULT_TIMEZONE;
}

/** Calendar date (YYYY-MM-DD) of an instant in the given timezone, or null. */
export function dateInTimeZone(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Today's calendar date (YYYY-MM-DD) in the given timezone. */
export function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The refresh fetch window, as a pure function (the handler supplies
 * the stored state). The FLOOR is Jan 1 of the current year, or the
 * earliest current-period start among the user's anchored credits when
 * earlier: anchored credits' current periods commonly began last year,
 * and a floor of Jan 1 left their prior-year postings unfetched forever,
 * overstating what remained. Bootstrap fetches from the floor until
 * stored coverage reaches it; gap-fill backfills from just before the
 * last successful import but never above the floor.
 */
export function resolveRefreshWindow(input: {
  today: string;
  hasAccounts: boolean;
  hasPostings: boolean;
  lastImportDate: string | null;
  coverageStart: string | null;
  anchoredPeriodStarts: readonly string[];
}): { windowStart: string; mode: string; floorStart: string; windowReason: string } {
  const yearStart = `${input.today.slice(0, 4)}-01-01`;
  let floorStart = yearStart;
  for (const s of input.anchoredPeriodStarts) {
    if (s < floorStart) floorStart = s;
  }
  const thirtyDayStart = addDays(input.today, -29);
  const needsBootstrap =
    !input.hasAccounts ||
    !input.hasPostings ||
    input.lastImportDate == null ||
    input.coverageStart == null ||
    input.coverageStart > floorStart;
  if (needsBootstrap) {
    return {
      windowStart: floorStart,
      mode: "bootstrap-full-coverage",
      floorStart,
      windowReason: `no stored coverage back to ${floorStart} yet, so this run bootstraps from there — anchored credits' current periods can start before Jan 1, and their postings must be covered too`,
    };
  }
  if (input.lastImportDate != null && input.lastImportDate < thirtyDayStart) {
    const backfillStart = addDays(input.lastImportDate, -2);
    return {
      windowStart: backfillStart < floorStart ? floorStart : backfillStart,
      mode: "gap-fill",
      floorStart,
      windowReason: `the last successful import was ${input.lastImportDate}, older than the 30-day window, so this run backfills from just before it to leave no gap`,
    };
  }
  return {
    windowStart: thirtyDayStart,
    mode: "incremental-30d",
    floorStart,
    windowReason: "the regular daily window: the trailing 30 days only",
  };
}

function parseDate(s: string): { y: number; m: number; d: number } {
  const [y = 1970, m = 1, d = 1] = s.split("-").map(Number);
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type Bounds = { start: string; end: string; key: string; label: string };

/** Anniversary anchor (month/day) for an annual credit's cycle. */
export type Anchor = { month: number; day: number };

export function periodBounds(period: Period, dateStr: string, anchor?: Anchor | null): Bounds {
  const { y, m } = parseDate(dateStr);
  if (period === "annual" && anchor) {
    // Anniversary-anchored year: runs from this year's anchor date through
    // the day before next year's anchor date (May 1 2026 – Apr 30 2027).
    const anchorDayThisYear = Math.min(anchor.day, daysInMonth(y, anchor.month));
    const startsThisYear = dateStr >= fmt(y, anchor.month, anchorDayThisYear);
    const startY = startsThisYear ? y : y - 1;
    const start = fmt(startY, anchor.month, Math.min(anchor.day, daysInMonth(startY, anchor.month)));
    const nextAnchor = fmt(
      startY + 1,
      anchor.month,
      Math.min(anchor.day, daysInMonth(startY + 1, anchor.month)),
    );
    const end = addDays(nextAnchor, -1);
    const endParts = parseDate(end);
    return {
      start,
      end,
      key: `${startY}-A${String(anchor.month).padStart(2, "0")}${String(anchor.day).padStart(2, "0")}`,
      label: `${MONTH_NAMES[anchor.month - 1] ?? ""} ${startY} – ${MONTH_NAMES[endParts.m - 1] ?? ""} ${endParts.y}`,
    };
  }
  if (period === "monthly") {
    return {
      start: fmt(y, m, 1),
      end: fmt(y, m, daysInMonth(y, m)),
      key: `${y}-${String(m).padStart(2, "0")}`,
      label: `${MONTH_NAMES[m - 1] ?? ""} ${y}`,
    };
  }
  if (period === "quarterly") {
    const q = Math.floor((m - 1) / 3); // 0..3
    const sm = q * 3 + 1;
    const em = sm + 2;
    return {
      start: fmt(y, sm, 1),
      end: fmt(y, em, daysInMonth(y, em)),
      key: `${y}-Q${q + 1}`,
      label: `Q${q + 1} ${y}`,
    };
  }
  if (period === "semiannual" && anchor) {
    // Cardmember-year halves: the cycle year starts on the anchor date
    // and splits into two 6-month halves (anchor → anchor+6mo → anchor).
    // No catalog credit is seeded with a semiannual anchor (the Aspire
    // resort credit runs on calendar halves — see the ASPIRE catalog
    // entry); this branch serves a semiannual credit whose anchor the
    // user set by hand.
    const anchorDayThisYear = Math.min(anchor.day, daysInMonth(y, anchor.month));
    const startsThisYear = dateStr >= fmt(y, anchor.month, anchorDayThisYear);
    const startY = startsThisYear ? y : y - 1;
    const cycleStart = fmt(
      startY,
      anchor.month,
      Math.min(anchor.day, daysInMonth(startY, anchor.month)),
    );
    const halfStart = addMonths(cycleStart, 6);
    const first = dateStr < halfStart;
    const start = first ? cycleStart : halfStart;
    const end = addDays(addMonths(start, 6), -1);
    const sp = parseDate(start);
    const ep = parseDate(end);
    return {
      start,
      end,
      key: `${startY}-S${String(anchor.month).padStart(2, "0")}${String(anchor.day).padStart(2, "0")}-${first ? 1 : 2}`,
      label:
        `${MONTH_NAMES[sp.m - 1] ?? ""} ${sp.y} – ${MONTH_NAMES[ep.m - 1] ?? ""} ${ep.y}`,
    };
  }
  if (period === "semiannual") {
    const first = m <= 6;
    const sm = first ? 1 : 7;
    const em = first ? 6 : 12;
    return {
      start: fmt(y, sm, 1),
      end: fmt(y, em, daysInMonth(y, em)),
      key: `${y}-H${first ? 1 : 2}`,
      label: first ? `Jan–Jun ${y}` : `Jul–Dec ${y}`,
    };
  }
  return { start: fmt(y, 1, 1), end: fmt(y, 12, 31), key: `${y}`, label: `${y}` };
}

export function daysBetween(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  const ua = Date.UTC(pa.y, pa.m - 1, pa.d);
  const ub = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((ub - ua) / 86400000);
}

export function addDays(dateStr: string, delta: number): string {
  const { y, m, d } = parseDate(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add whole calendar months, clamping the day to the target month's length. */
export function addMonths(dateStr: string, delta: number): string {
  const { y, m, d } = parseDate(dateStr);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/**
 * Strict calendar-date check for imported / manually entered dates: the
 * "YYYY-MM-DD" shape AND a date that actually exists (2026-13-40 and
 * 2026-02-30 are rejected, not silently rolled over by Date math).
 */
export function isValidCalendarDate(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * The date a posting counts toward: its transaction date (Plaid
 * `authorized_date`) when known, otherwise its posted date. Period
 * bucketing ALWAYS uses this — never the raw posted date.
 */
export function transactionDateOf(p: {
  date: string;
  transactionDate?: string | null;
}): string {
  return p.transactionDate ?? p.date;
}

/** LA calendar date (YYYY-MM-DD) of an ISO timestamp, or null if unparseable. */
export function laDateOf(iso: string): string | null {
  return dateInTimeZone(iso, DEFAULT_TIMEZONE);
}

// ---------------------------------------------------------------------------
// Shared zod shapes
// ---------------------------------------------------------------------------

const periodEnum = z.enum(["monthly", "quarterly", "semiannual", "annual"]);

/** A YYYY-MM-DD string that is a REAL calendar date (2026-13-40 is rejected). */
const dateString = z
  .string()
  .refine(isValidCalendarDate, "must be a real calendar date (YYYY-MM-DD)");

const creditView = z.object({
  id: z.number(),
  accountId: z.number(),
  accountName: z.string(),
  /** User-chosen display prefix for the account ("" when unset). */
  accountNickname: z.string(),
  /** Catalog default display name for the account's product ("" when none). */
  accountDefaultName: z.string(),
  mask: z.string(),
  /** Fifth-from-last card digit the user recorded ("" when unset); with the mask it forms the effective ending. */
  fifthDigit: z.string(),
  owner: z.string().nullable(),
  name: z.string(),
  amount: z.number(),
  /** ISO currency code the amounts are in (the account's Plaid currency). */
  currency: z.string(),
  period: periodEnum,
  /** Anniversary anchor for annual credits; null for calendar-cycle credits. */
  anchorMonth: z.number().nullable(),
  anchorDay: z.number().nullable(),
  /**
   * True once a human confirmed the anchor is the card's real
   * anniversary. Catalog-default anchors start unconfirmed and warn.
   */
  anchorConfirmed: z.boolean(),
  /**
   * The user's asserted enrollment state: true / false once the user has
   * marked it, null while UNCONFIRMED. The app cannot observe the issuer's
   * enrollment state, so null must never be rendered as "not enrolled".
   */
  enrolled: z.boolean().nullable(),
  /**
   * Catalog fact: the issuer requires enrolling in this benefit before
   * use. Independent of the row's `enrolled` state above.
   */
  enrollmentRequired: z.boolean(),
  /** Enrollment notice for the expanded detail; null unless enrollmentRequired. */
  enrollmentNote: z.string().nullable(),
  active: z.boolean(),
  note: z.string(),
  matchPattern: z.string(),
  currentUsed: z.number(),
  currentRemaining: z.number(),
  periodLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** First day of the next period — when a used-up credit renews. */
  nextPeriodStart: z.string(),
  daysLeft: z.number(),
  currentPostings: z.array(
    z.object({
      id: z.number(),
      /** Transaction date (authorized_date) — the date the posting counts toward. */
      date: z.string(),
      /** Posted date (when the credit hit the statement); equals `date` unless they differ. */
      postedDate: z.string(),
      name: z.string(),
      amount: z.number(),
      /** Where this posting came from: imported from Plaid, or recorded manually. */
      source: z.enum(["plaid", "manual"]),
    }),
  ),
});

const dashboardResponse = z.object({
  lastImportAt: z.string().nullable(),
  /** Display labels for the two Amex logins (owner keys "A" and "B"). */
  ownerLabels: z.tuple([z.string(), z.string()]),
  /**
   * Effective display-exclusion patterns in force: the stored preference
   * (meta `excludedCredits`) when set, otherwise the built-in defaults.
   */
  excludedPatterns: z.array(z.string()),
  /** Credit rows hidden by the exclusion preference — never counted in any total. */
  hiddenCredits: z.array(
    z.object({
      name: z.string(),
      accountName: z.string(),
      mask: z.string(),
      fifthDigit: z.string(),
      owner: z.string().nullable(),
    }),
  ),
  /**
   * Earliest date the stored postings cumulatively cover (YYYY-MM-DD).
   * Daily refreshes only fetch a trailing 30-day window, but stored data is
   * merge-only, so this stays at Jan 1 of the current year once bootstrapped.
   */
  dataCoverageStart: z.string().nullable(),
  /** Start of the window the most recent refresh fetched (YYYY-MM-DD). */
  lastRefreshWindowStart: z.string().nullable(),
  today: z.string(),
  /** The timezone `today` and every period boundary are computed in. */
  timezone: z.string(),
  accounts: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      /** User-chosen display prefix ("" when unset); never set by Plaid. */
      nickname: z.string(),
      /** Catalog default display name for the product ("" when none). */
      defaultName: z.string(),
      mask: z.string(),
      /** Fifth-from-last card digit the user recorded ("" when unset); never set by Plaid. */
      fifthDigit: z.string(),
      issuer: z.string(),
      /** ISO currency code from Plaid; null when unknown (treated as USD). */
      currency: z.string().nullable(),
      owner: z.string().nullable(),
      balance: z.number().nullable(),
      ignored: z.boolean(),
      hasCatalog: z.boolean(),
      /** Effective credit instances tracked for this account. */
      creditCount: z.number(),
      /**
       * Read-time suspicion that this record duplicates another one
       * (same product + effective ending within one owner, or
       * transaction evidence). A prompt for the user to decide — the
       * account stays active and counted.
       */
      suspectedDuplicate: z.boolean(),
      /** Ids of the accounts this one is suspected of duplicating. */
      duplicateSuspectIds: z.array(z.number()),
      /**
       * Identifying stored transactions for telling same-ending cards
       * apart, present only when another account of the same owner
       * shares this account's product + effective ending (the records
       * a user cannot distinguish at a glance): the latest stored
       * annual/membership-fee posting when one exists, plus the most
       * recent stored postings. Null for every other account.
       */
      disambiguation: z
        .object({
          annualFeePosting: z
            .object({ date: z.string(), name: z.string(), amount: z.number() })
            .nullable(),
          recentPostings: z.array(
            z.object({ date: z.string(), name: z.string(), amount: z.number() }),
          ),
        })
        .nullable(),
    }),
  ),
  credits: z.array(creditView),
  /** Total postings in the Unassigned review list (the list itself is capped). */
  unassignedCount: z.number(),
  unassigned: z.array(
    z.object({
      id: z.number(),
      /** Transaction date (authorized_date) — the date the posting counts toward. */
      date: z.string(),
      /** Posted date; equals `date` unless they differ. */
      postedDate: z.string(),
      name: z.string(),
      amount: z.number(),
      accountId: z.number(),
      accountName: z.string(),
      mask: z.string(),
      fifthDigit: z.string(),
      owner: z.string().nullable(),
      /** ISO currency of the posting's account (USD when unknown). */
      currency: z.string(),
    }),
  ),
  totals: z.object({
    remainingNow: z.number(),
    expiring14: z.number(),
    expiring31: z.number(),
    openCredits: z.number(),
  }),
});

export type DashboardData = z.infer<typeof dashboardResponse>;

const okResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type AccountRow = typeof schema.accounts.$inferSelect;
type CreditRow = typeof schema.credits.$inferSelect;

/**
 * One catalog credit instance that exists only at read time: a def of an
 * account's product for which the account has NO stored row (a stored
 * row — including a deletion tombstone — always wins and suppresses
 * synthesis). `synthId` is the deterministic negative id the instance
 * carries in dashboard payloads; the enumeration order here (accounts
 * in the given order, defs in catalog order) is the single definition
 * of that mapping, shared by computeDashboard and by the write actions
 * that resolve a negative id back to its (account, def) to materialize
 * it (see materializeSynthesizedCredit).
 */
export type SynthesizedInstance = {
  account: AccountRow;
  def: CreditDef;
  defIndex: number;
  synthId: number;
};

export function synthesizedInstances(
  accountRows: readonly AccountRow[],
  creditRows: readonly CreditRow[],
): SynthesizedInstance[] {
  const storedNameByAccount = new Map<number, Set<string>>();
  for (const c of creditRows) {
    const names = storedNameByAccount.get(c.accountId) ?? new Set<string>();
    names.add(c.name.trim().toLowerCase());
    storedNameByAccount.set(c.accountId, names);
  }
  const out: SynthesizedInstance[] = [];
  let synthId = 0;
  for (const acct of accountRows) {
    const defs = [
      ...(catalogFor(acct.name) ?? []),
      ...nonSeededDefsFor(acct.name),
    ];
    if (defs.length === 0) continue;
    const have = storedNameByAccount.get(acct.id) ?? new Set<string>();
    defs.forEach((d, i) => {
      const key = d.name.trim().toLowerCase();
      if (have.has(key)) return;
      have.add(key);
      synthId -= 1;
      out.push({ account: acct, def: d, defIndex: i, synthId });
    });
  }
  return out;
}

/** The row-shaped view of a synthesized instance (never persisted as-is). */
function synthesizedRow(inst: SynthesizedInstance): CreditRow {
  const d = inst.def;
  return {
    id: inst.synthId,
    accountId: inst.account.id,
    name: d.name,
    amount: d.amount,
    period: d.period,
    anchorMonth: d.anchorMonth ?? null,
    anchorDay: d.anchorDay ?? null,
    // Catalog-default anchors start unconfirmed; enrollment-required
    // benefits start UNCONFIRMED (enrolledAsserted 0 — never assume either
    // enrolled or not enrolled).
    anchorConfirmed: d.anchorMonth != null ? 0 : 1,
    deleted: 0,
    matchPattern: d.pattern,
    enrolled: d.enrollmentRequired ? 0 : 1,
    enrolledAsserted: 0,
    active: 1,
    note: d.note ?? "",
    sortOrder: 10000 + inst.defIndex,
  };
}

/**
 * The stored-row values a catalog def materializes with — shared by
 * import-time seeding and by materialize-on-write, so a credit behaves
 * identically however its row came to exist.
 */
function defRowValues(accountId: number, d: CreditDef, sortOrder: number) {
  return {
    accountId,
    name: d.name,
    amount: d.amount,
    period: d.period,
    anchorMonth: d.anchorMonth ?? null,
    anchorDay: d.anchorDay ?? null,
    anchorConfirmed: d.anchorMonth != null ? 0 : 1,
    enrolled: d.enrollmentRequired ? 0 : 1,
    enrolledAsserted: 0,
    matchPattern: d.pattern,
    note: d.note ?? "",
    sortOrder,
  };
}

/**
 * Materialize-on-write: turn a synthesized instance into a real stored
 * row (copying its catalog def), so an edit / enrolled toggle / stop /
 * delete aimed at a negative id STICKS instead of silently no-oping.
 * The account's unassigned postings that the def's pattern claims are
 * persisted onto the new row — exactly the set compute-time attribution
 * was lending the instance — so its usage does not drop to zero the
 * moment it becomes a stored row. Returns the new row.
 */
async function materializeSynthesizedCredit(
  db: SpaceDb<typeof schema>,
  inst: SynthesizedInstance,
): Promise<CreditRow> {
  const inserted = await db
    .insert(schema.credits)
    .values(defRowValues(inst.account.id, inst.def, 10000 + inst.defIndex))
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("materializeSynthesizedCredit: insert returned no rows");
  if (inst.def.pattern !== "") {
    const unassigned = await db
      .select()
      .from(schema.postings)
      .where(isNull(schema.postings.creditId));
    for (const p of unassigned) {
      if (p.accountId !== inst.account.id) continue;
      if (!p.name.toLowerCase().includes(inst.def.pattern.toLowerCase())) continue;
      await db
        .update(schema.postings)
        .set({ creditId: row.id })
        .where(eq(schema.postings.id, p.id));
    }
  }
  return row;
}

/**
 * Resolve a dashboard payload id to a stored credit row. Positive ids
 * are looked up directly (deleted tombstones count as missing — they
 * are gone). Negative ids are synthesized instances: the instance is
 * resolved through the shared enumeration and materialized on the spot,
 * so the caller always ends up acting on a real row.
 */
async function resolveCreditRow(
  db: SpaceDb<typeof schema>,
  id: number,
): Promise<CreditRow | null> {
  if (id > 0) {
    const rows = await db
      .select()
      .from(schema.credits)
      .where(eq(schema.credits.id, id));
    const row = rows[0];
    return row && row.deleted === 0 ? row : null;
  }
  const [accountRows, creditRows] = await Promise.all([
    db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)),
    db.select().from(schema.credits),
  ]);
  const inst = synthesizedInstances(accountRows, creditRows).find(
    (i) => i.synthId === id,
  );
  if (!inst) return null;
  return materializeSynthesizedCredit(db, inst);
}

/**
 * The dashboard aggregation — the single place where current-period usage,
 * remaining amounts, and totals are computed. The getDashboard action (JSON
 * for the UI) and the getAgentMarkdown action (a markdown snapshot an AI
 * assistant can discuss) both read from this, so the two views can never
 * disagree. (Body indentation follows the action handler it came from.)
 */
async function computeDashboard(
  db: SpaceDb<typeof schema>,
): Promise<z.infer<typeof dashboardResponse>> {
      const [accountRows, creditRows, postingRows, metaRows] = await Promise.all([
        db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)),
        db.select().from(schema.credits).orderBy(asc(schema.credits.sortOrder)),
        db.select().from(schema.postings).orderBy(desc(schema.postings.date)),
        db.select().from(schema.meta),
      ]);
      // "Today" — and therefore every period boundary — is computed in
      // the user's stored timezone (default America/Los_Angeles).
      const timezone = resolveTimeZone(
        metaRows.find((r) => r.key === TIMEZONE_META_KEY)?.value,
      );
      const today = todayInTimeZone(timezone);
      const lastImportAt = metaRows.find((r) => r.key === "lastImportAt")?.value ?? null;
      const ownerLabels: [string, string] = [
        metaRows.find((r) => r.key === "ownerALabel")?.value || DEFAULT_OWNER_LABELS[0],
        metaRows.find((r) => r.key === "ownerBLabel")?.value || DEFAULT_OWNER_LABELS[1],
      ];
      const dataCoverageStart =
        metaRows.find((r) => r.key === "dataCoverageStart")?.value ?? null;
      const lastRefreshWindowStart =
        metaRows.find((r) => r.key === "lastRefreshWindowStart")?.value ?? null;
      // Display-exclusion preference: the stored list when the user has
      // set one (Display settings toggles or their assistant in chat),
      // otherwise the built-in defaults.
      const excludedPatterns =
        parseExcludedPatterns(
          metaRows.find((r) => r.key === EXCLUDED_CREDITS_META_KEY)?.value,
        ) ?? DEFAULT_EXCLUDED_PATTERNS;

      const accountById = new Map(accountRows.map((a) => [a.id, a]));
      const postingsByCredit = new Map<number, typeof postingRows>();
      for (const p of postingRows) {
        if (p.creditId == null) continue;
        const arr = postingsByCredit.get(p.creditId) ?? [];
        arr.push(p);
        postingsByCredit.set(p.creditId, arr);
      }

      // Compute-time synthesis of catalog credit instances (NO database
      // writes): for every account in the DB, each credit in the product's
      // full catalog — the seeded defs from catalogFor PLUS the non-seeded
      // families from nonSeededDefsFor — becomes an instance. Instances
      // are keyed by (accountId, credit name): a stored row with that key
      // wins and supplies the persisted state (edited amount / period /
      // active flag, and its postings via postingsByCredit); only defs
      // with no stored row are synthesized, with the catalog amount and
      // cycle. A synthesized instance starts with no postings of its own —
      // the attribution step below lends it the unassigned postings its
      // match pattern claims. This is what makes credits that
      // were never materialized as rows — the default-hidden families on
      // long-running deployments — listable by the exclusion preference
      // below and surfacable again by un-hiding, with no migration.
      // Synthesized instances carry deterministic negative ids so they
      // can never collide with a real row id (postings reference real ids).
      // DELETED rows are tombstones: they suppress synthesis (so a
      // deleted credit never resurrects) but are themselves never shown.
      const synthesizedRows = synthesizedInstances(accountRows, creditRows).map(
        synthesizedRow,
      );
      const liveStoredRows = creditRows.filter((c) => c.deleted === 0);
      const effectiveCreditRows = [...liveStoredRows, ...synthesizedRows];

      // Compute-time attribution for synthesized instances. A stored
      // credit receives its postings persistently: import auto-matches by
      // pattern, and the user can reassign (or deliberately unassign) by
      // hand. A synthesized instance has no row a posting could ever
      // point at — its id is a negative placeholder — so the ONLY way a
      // posting can count toward it is here, at read time: unassigned
      // postings are matched against the account's synthesized instances
      // with the same matchCreditForPosting rule import uses for stored
      // rows. A posting claimed this way counts toward that instance's
      // usage (bucketed by transaction date like any assigned posting)
      // and leaves the Unassigned list. Stored credits never participate:
      // a posting the user unassigned from a stored credit stays
      // unassigned, because persisted assignment is the user's state,
      // not something a read may override. Nothing is written back —
      // attribution is derived fresh on every read, exactly like
      // synthesis itself.
      const synthesizedByAccount = new Map<number, typeof synthesizedRows>();
      for (const row of synthesizedRows) {
        const arr = synthesizedByAccount.get(row.accountId) ?? [];
        arr.push(row);
        synthesizedByAccount.set(row.accountId, arr);
      }
      const effectivePostingsByCredit = new Map(postingsByCredit);
      const computeMatchedPostingIds = new Set<number>();
      for (const p of postingRows) {
        if (p.creditId != null) continue;
        const candidates = synthesizedByAccount.get(p.accountId);
        if (!candidates || candidates.length === 0) continue;
        const match = matchCreditForPosting(candidates, p.name);
        if (!match) continue;
        const arr = effectivePostingsByCredit.get(match.id) ?? [];
        arr.push(p);
        effectivePostingsByCredit.set(match.id, arr);
        computeMatchedPostingIds.add(p.id);
      }

      let remainingNow = 0;
      let expiring14 = 0;
      let expiring31 = 0;
      let openCredits = 0;

      const credits = effectiveCreditRows
        .filter((c) => {
          const acct = accountById.get(c.accountId);
          return acct && acct.ignored === 0 && !isExcludedName(c.name, excludedPatterns);
        })
        .map((c) => {
          const acct = accountById.get(c.accountId)!;
          const enrollment = enrollmentInfoFor(acct.name, c.name);
          const period = c.period as Period;
          const effectiveActive = c.active === 1 || isPinnedCredit(c.name);
          const anchor =
            c.anchorMonth != null && c.anchorDay != null
              ? { month: c.anchorMonth, day: c.anchorDay }
              : null;
          const bounds = periodBounds(period, today, anchor);
          const mine = effectivePostingsByCredit.get(c.id) ?? [];
          // Bucketing is by TRANSACTION date (authorized_date), never the
          // posted date: a credit authorized Sep 30 that posted Oct 2
          // counts in Q3, not Q4.
          const inPeriod = mine.filter((p) => {
            const td = transactionDateOf(p);
            return td >= bounds.start && td <= bounds.end;
          });
          // Amounts are signed: a clawback (negative posting) nets
          // against the credits it reverses, restoring remaining.
          // Remaining is clamped to [0, amount] — a net-negative period
          // (clawback larger than the period's credits) never shows
          // more than the full credit as available.
          const used = inPeriod.reduce((s, p) => s + p.amount, 0);
          const remaining = Math.min(
            c.amount,
            Math.max(0, Math.round((c.amount - used) * 100) / 100),
          );
          const daysLeft = daysBetween(today, bounds.end);

          // Current period only: past periods are gone and are not tallied,
          // surfaced, or held against the user anywhere in this dashboard.
          if (effectiveActive) {
            remainingNow += remaining;
            if (daysLeft <= 14) expiring14 += remaining;
            if (daysLeft <= 31) expiring31 += remaining;
            if (remaining > 0) openCredits += 1;
          }

          return {
            id: c.id,
            accountId: c.accountId,
            accountName: acct.name,
            accountNickname: acct.nickname,
            accountDefaultName: defaultNameFor(acct.name) ?? "",
            mask: acct.mask,
            fifthDigit: acct.fifthDigit,
            owner: ownerLabelFor(acct.owner, ownerLabels),
            name: c.name,
            amount: c.amount,
            currency: acct.currency ?? "USD",
            period,
            anchorMonth: c.anchorMonth,
            anchorDay: c.anchorDay,
            anchorConfirmed: c.anchorConfirmed === 1,
            enrolled: (c.enrolledAsserted ?? 0) === 1 ? c.enrolled === 1 : null,
            enrollmentRequired: enrollment.required,
            enrollmentNote: enrollment.note,
            active: effectiveActive,
            note: c.note,
            matchPattern: c.matchPattern,
            currentUsed: Math.round(used * 100) / 100,
            currentRemaining: remaining,
            periodLabel: bounds.label,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            nextPeriodStart: addDays(bounds.end, 1),
            daysLeft,
            currentPostings: inPeriod.map((p) => ({
              id: p.id,
              date: transactionDateOf(p),
              postedDate: p.date,
              name: p.name,
              amount: p.amount,
              source: p.source,
            })),
          };
        });

      // The Unassigned review list — the one definition of "unassigned"
      // every surface agrees on (the dashboard section, its count, and
      // listUnassignedCount): no credit assigned, not claimed by
      // compute-time attribution, not an exclusion-hidden name, and on
      // an account that is not ignored.
      const unassignedAll = postingRows.filter((p) => {
        if (p.creditId != null) return false;
        // Attributed at compute time to a synthesized instance (see
        // above): it counts as that credit's usage, so it is no longer
        // unassigned even though its stored creditId is still null.
        if (computeMatchedPostingIds.has(p.id)) return false;
        if (isExcludedName(p.name, excludedPatterns)) return false;
        const acct = accountById.get(p.accountId);
        return acct && acct.ignored === 0;
      });
      const unassigned = unassignedAll
        .slice(0, 100)
        .map((p) => {
          const acct = accountById.get(p.accountId)!;
          return {
            id: p.id,
            date: transactionDateOf(p),
            postedDate: p.date,
            name: p.name,
            amount: p.amount,
            accountId: p.accountId,
            accountName: acct.name,
            mask: acct.mask,
            fifthDigit: acct.fifthDigit,
            owner: ownerLabelFor(acct.owner, ownerLabels),
            currency: acct.currency ?? "USD",
          };
        });

      const creditCountByAccount = new Map<number, number>();
      for (const c of effectiveCreditRows) {
        creditCountByAccount.set(c.accountId, (creditCountByAccount.get(c.accountId) ?? 0) + 1);
      }

      // The credits the preference hides: surfaced by name (never tallied)
      // so the Agent Markdown can tell an assistant they exist and can be
      // re-enabled via chat. Drawn from the SAME effective instances as
      // the visible list (stored rows + synthesized catalog instances),
      // so a hidden credit with no stored row is still named — and
      // removing its pattern below surfaces the very same instance.
      const hiddenCredits = effectiveCreditRows
        .filter((c) => {
          const acct = accountById.get(c.accountId);
          return acct && acct.ignored === 0 && isExcludedName(c.name, excludedPatterns);
        })
        .map((c) => {
          const acct = accountById.get(c.accountId)!;
          return {
            name: c.name,
            accountName: acct.name,
            mask: acct.mask,
            fifthDigit: acct.fifthDigit,
            owner: ownerLabelFor(acct.owner, ownerLabels),
          };
        })
        .sort((a, b) =>
          a.name === b.name
            ? a.accountName.localeCompare(b.accountName)
            : a.name.localeCompare(b.name),
        );

      // Suspected duplicates (flag only — see suspectedDuplicatesFor):
      // which records might be two views of one underlying account,
      // for the user to decide on.
      const evidenceRows = await db.select().from(schema.accountDuplicateEvidence);
      const suspected = suspectedDuplicatesFor(
        accountRows,
        evidenceRows.map(
          (r) => [r.accountId, r.otherAccountId] as const,
        ),
      );

      // Disambiguation evidence for same-ending cards: the accounts a
      // user cannot tell apart at a glance are one owner's records
      // sharing a product + effective ending — exactly the heuristic's
      // grouping above. For each such account, surface what its stored
      // postings say (the latest annual/membership-fee posting when one
      // is stored, plus its most recent postings) so the Cards section
      // can show the user which physical card each record is before
      // they record its fifth digit.
      const sameEndingGroups = new Map<string, number[]>();
      for (const a of accountRows) {
        if (a.ignored !== 0 || a.mask === "") continue;
        const key = [
          a.owner ?? "",
          a.name.trim().toLowerCase(),
          effectiveEnding(a.mask, a.fifthDigit),
        ].join("|");
        const arr = sameEndingGroups.get(key) ?? [];
        arr.push(a.id);
        sameEndingGroups.set(key, arr);
      }
      const postingsByAccount = new Map<number, typeof postingRows>();
      for (const p of postingRows) {
        const arr = postingsByAccount.get(p.accountId) ?? [];
        arr.push(p);
        postingsByAccount.set(p.accountId, arr);
      }
      type Disambiguation = {
        annualFeePosting: { date: string; name: string; amount: number } | null;
        recentPostings: { date: string; name: string; amount: number }[];
      };
      const disambiguationByAccount = new Map<number, Disambiguation>();
      for (const ids of sameEndingGroups.values()) {
        if (ids.length < 2) continue;
        for (const id of ids) {
          const mine = [...(postingsByAccount.get(id) ?? [])].sort((x, y) => {
            const dx = transactionDateOf(x);
            const dy = transactionDateOf(y);
            if (dx !== dy) return dx < dy ? 1 : -1;
            if (x.date !== y.date) return x.date < y.date ? 1 : -1;
            return y.id - x.id;
          });
          const fee = mine.find((p) => {
            const n = p.name.toLowerCase();
            return n.includes("membership fee") || n.includes("annual fee");
          });
          disambiguationByAccount.set(id, {
            annualFeePosting: fee
              ? { date: transactionDateOf(fee), name: fee.name, amount: fee.amount }
              : null,
            recentPostings: mine
              .filter((p) => !fee || p.id !== fee.id)
              .slice(0, 3)
              .map((p) => ({
                date: transactionDateOf(p),
                name: p.name,
                amount: p.amount,
              })),
          });
        }
      }

      return {
        lastImportAt,
        ownerLabels,
        excludedPatterns,
        hiddenCredits,
        dataCoverageStart,
        lastRefreshWindowStart,
        today,
        timezone,
        accounts: accountRows.map((a) => ({
          id: a.id,
          name: a.name,
          nickname: a.nickname,
          defaultName: defaultNameFor(a.name) ?? "",
          mask: a.mask,
          fifthDigit: a.fifthDigit,
          issuer: a.issuer,
          currency: a.currency,
          owner: ownerLabelFor(a.owner, ownerLabels),
          balance: a.balance,
          ignored: a.ignored === 1,
          hasCatalog: (creditCountByAccount.get(a.id) ?? 0) > 0,
          creditCount: creditCountByAccount.get(a.id) ?? 0,
          suspectedDuplicate: suspected.has(a.id),
          duplicateSuspectIds: suspected.get(a.id) ?? [],
          disambiguation: disambiguationByAccount.get(a.id) ?? null,
        })),
        credits,
        unassignedCount: unassignedAll.length,
        unassigned,
        totals: {
          remainingNow: Math.round(remainingNow * 100) / 100,
          expiring14: Math.round(expiring14 * 100) / 100,
          expiring31: Math.round(expiring31 * 100) / 100,
          openCredits,
        },
      };
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<z.infer<typeof dashboardResponse>> {
      return computeDashboard(ctx.db<typeof schema>());
    },
  }),

  // Agent-friendly markdown snapshot of the very same aggregated state the
  // dashboard displays (via computeDashboard — no second set of math). The
  // user pastes it to their AI assistant, which can then discuss what to
  // use next with full context: amounts, period windows, usage rules, and
  // where each number came from.
  getAgentMarkdown: defineAction({
    request: z.object({}),
    response: z.object({ markdown: z.string(), generatedAt: z.string() }),
    async handler(ctx) {
      const data = await computeDashboard(ctx.db<typeof schema>());
      const generatedAt = new Date();
      return {
        markdown: renderAgentMarkdown(data, generatedAt),
        generatedAt: generatedAt.toISOString(),
      };
    },
  }),

  // MERGE-ONLY IMPORT — hard guarantee: a refresh fetches
  // only a trailing window (30 days for daily refreshes), yet the stored
  // dataset must keep covering the year from Jan 1. This action therefore
  // NEVER deletes or replaces stored data: accounts are upserted by Plaid
  // account id, postings are inserted only when their Plaid transaction id
  // is new, credits are only seeded for accounts that have none, and manual
  // postings / user edits are never touched. A posting that is absent from
  // the payload (e.g. it falls outside the fetched window) stays stored and
  // keeps counting. There is deliberately no delete/clear path here.
  // One in-place exception: re-importing a known transaction id MAY correct
  // its stored transactionDate (Plaid sometimes finalizes authorized_date
  // after the first read). The correction updates the date in place — it
  // never duplicates the posting and never touches its amount or mapping.
  importSnapshot: defineAction({
    request: z.object({
      /** Start of the window this payload was fetched over (YYYY-MM-DD). */
      windowStart: dateString.optional(),
      /** End of the window this payload was fetched over (YYYY-MM-DD). */
      windowEnd: dateString.optional(),
      /**
       * True only when the source read covered the WHOLE window
       * successfully. Coverage (dataCoverageStart) is claimed from
       * windowStart only for complete fetches: a partial or failed read
       * still merges whatever it got (merge-only makes that safe) but must
       * not certify the window as covered, so the next refresh retries the
       * bootstrap / gap-fill window instead of moving on to 30-day windows.
       */
      complete: z.boolean().optional(),
      accounts: z.array(
        z.object({
          plaidAccountId: z.string().min(1),
          name: z.string().min(1),
          mask: z.string().default(""),
          balance: z.number().nullable().optional(),
          creditLimit: z.number().nullable().optional(),
          /**
           * Which PERSON this account belongs to, as a key: "A" or "B".
           * Sticky: the import only fills it on accounts that have none
           * yet — it never overwrites an existing attribution (a person
           * is corrected through updateAccount, not by a later import).
           */
          owner: z.string().optional(),
          /** Issuer ("Amex" / "Chase" / "U.S. Bank"); inferred from the card name when omitted. */
          issuer: z.string().optional(),
          /** ISO currency code from Plaid (balances.iso_currency_code). */
          currency: z.string().optional(),
          /** Explicit duplicate flag from a curated import. */
          ignored: z.boolean().optional(),
        }),
      ),
      postings: z.array(
        z.object({
          txnId: z.string().min(1),
          accountPlaidId: z.string().min(1),
          /** Posted date (Plaid `date`) — display only. */
          date: dateString,
          /**
           * Transaction date (Plaid `authorized_date`) — the date the
           * posting counts toward. Falls back to the posted date when
           * absent. Re-importing a known txnId with a different
           * transactionDate corrects the stored value in place.
           */
          transactionDate: dateString.optional(),
          name: z.string().min(1),
          /**
           * SIGNED dollars of credit: positive when the issuer paid a
           * credit, negative when the issuer reversed / clawed one back.
           * Usage sums signed amounts, so a clawback nets against the
           * original credit — that is how corrections are represented in
           * a merge-only store that never deletes.
           */
          amount: z.number(),
        }),
      ),
      importedAt: z.string().optional(),
    }),
    response: z.object({
      accountsAdded: z.number(),
      postingsAdded: z.number(),
      postingsSkipped: z.number(),
      /** Known postings whose stored transactionDate was corrected in place. */
      postingsCorrected: z.number(),
      /** Postings already stored before this import — all of them are kept. */
      existingPostingsPreserved: z.number(),
      /** Earliest date the stored postings now cumulatively cover. */
      dataCoverageStart: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Strict calendar dates, enforced in the handler (not only in
      // the request schema): an impossible date like 2026-13-40 must
      // never reach storage, where string-ordered bucketing would
      // silently misfile it.
      for (const [field, value] of [
        ["windowStart", args.windowStart],
        ["windowEnd", args.windowEnd],
      ] as const) {
        if (value !== undefined && !isValidCalendarDate(value)) {
          throw new Error(`importSnapshot: ${field} is not a real calendar date: ${value}`);
        }
      }
      for (const p of args.postings) {
        if (!isValidCalendarDate(p.date)) {
          throw new Error(`importSnapshot: posting ${p.txnId} has an impossible date: ${p.date}`);
        }
        if (p.transactionDate !== undefined && !isValidCalendarDate(p.transactionDate)) {
          throw new Error(
            `importSnapshot: posting ${p.txnId} has an impossible transactionDate: ${p.transactionDate}`,
          );
        }
      }
      const existingPostingsCount = (
        await db.select({ id: schema.postings.id }).from(schema.postings)
      ).length;
      const existingAccounts = await db.select().from(schema.accounts);
      const byPlaidId = new Map(existingAccounts.map((a) => [a.plaidAccountId, a]));

      // Duplicate handling is the USER's decision, never an import-time
      // guess: import NEVER auto-ignores an account. Two records that
      // look like the same underlying account (same product + mask, or
      // one whose transactions are a subset of the other's) are flagged
      // `suspectedDuplicate` at read time in computeDashboard and listed
      // in the Cards section and the Agent Markdown warnings; both stay
      // active and counted until the user marks one ignored via
      // setAccountIgnored. (An explicit `ignored` in the payload — a
      // curated import carrying the user's own decision — is honored.)
      let accountsAdded = 0;
      for (const a of args.accounts) {
        const owner = a.owner ?? null;
        const issuer = a.issuer ?? issuerForAccountName(a.name);
        const known = byPlaidId.get(a.plaidAccountId);
        if (known) {
          await db
            .update(schema.accounts)
            .set({
              balance: a.balance ?? known.balance,
              name: a.name,
              mask: a.mask,
              ...(a.issuer ? { issuer: a.issuer } : {}),
              ...(a.currency ? { currency: a.currency } : {}),
              // Owner is STICKY: an import fills it only when the stored
              // account has none yet. It never overwrites an existing
              // attribution — the person keys are the user's state, and
              // a refresh that re-derives them differently must not
              // silently swap two people's cards.
              ...(known.owner == null && owner ? { owner } : {}),
              // An import may record a curated ignore decision, but it
              // must NEVER un-ignore: a stored ignored=1 is the user's
              // (or a legacy import's) settled state, and only an
              // explicit setAccountIgnored from the user reverses it.
              ...(a.ignored === true ? { ignored: 1 } : {}),
            })
            .where(eq(schema.accounts.id, known.id));
          continue;
        }
        const ignored = a.ignored ? 1 : 0;
        const inserted = await db
          .insert(schema.accounts)
          .values({
            plaidAccountId: a.plaidAccountId,
            name: a.name,
            mask: a.mask,
            balance: a.balance ?? null,
            creditLimit: a.creditLimit ?? null,
            issuer,
            owner,
            currency: a.currency ?? null,
            ignored,
          })
          .returning({ id: schema.accounts.id });
        const row = inserted[0];
        if (!row) continue;
        accountsAdded++;
        const fresh = {
          id: row.id,
          plaidAccountId: a.plaidAccountId,
          name: a.name,
          mask: a.mask,
          balance: a.balance ?? null,
          creditLimit: a.creditLimit ?? null,
          issuer,
          owner,
          nickname: "",
          fifthDigit: "",
          currency: a.currency ?? null,
          ignored,
          createdAt: new Date(),
        };
        byPlaidId.set(a.plaidAccountId, fresh);
      }

      // Seed catalog credits for any account that has none yet.
      const allAccounts = await db.select().from(schema.accounts);
      const allCredits = await db.select().from(schema.credits);
      const creditsByAccount = new Map<number, typeof allCredits>();
      for (const c of allCredits) {
        const arr = creditsByAccount.get(c.accountId) ?? [];
        arr.push(c);
        creditsByAccount.set(c.accountId, arr);
      }
      for (const acct of allAccounts) {
        if ((creditsByAccount.get(acct.id) ?? []).length > 0) continue;
        const defs = catalogFor(acct.name);
        if (!defs) continue;
        // Seeded rows start truthful: catalog-default anchors are
        // UNCONFIRMED placeholders, and enrollment-required benefits
        // start enrollment-UNCONFIRMED (defRowValues carries both rules).
        const rows: (typeof schema.credits.$inferInsert)[] = defs.map((d, i) =>
          defRowValues(acct.id, d, i),
        );
        const insertedCredits = await db
          .insert(schema.credits)
          .values(rows)
          .returning();
        creditsByAccount.set(acct.id, insertedCredits);
      }

      // Import postings, deduped by Plaid transaction id, auto-mapped by
      // the account's catalog match patterns.
      const existingByTxn = new Map(
        (
          await db
            .select({
              id: schema.postings.id,
              txnId: schema.postings.txnId,
              accountId: schema.postings.accountId,
              date: schema.postings.date,
              transactionDate: schema.postings.transactionDate,
            })
            .from(schema.postings)
        )
          .filter((r): r is typeof r & { txnId: string } => r.txnId != null)
          .map((r) => [r.txnId, r] as const),
      );
      let postingsAdded = 0;
      let postingsSkipped = 0;
      let postingsCorrected = 0;
      for (const p of args.postings) {
        const knownPosting = existingByTxn.get(p.txnId);
        if (knownPosting) {
          // Duplicate-evidence: this transaction id arrived under a
          // DIFFERENT account record than the one it is stored under —
          // the two records saw the same transaction, the signature of
          // a primary account and its supplementary view. Record the
          // pair as evidence for the read-time suspectedDuplicate flag
          // (the user decides; nothing is auto-ignored).
          const payloadAccount = byPlaidId.get(p.accountPlaidId);
          if (payloadAccount && payloadAccount.id !== knownPosting.accountId) {
            await db
              .insert(schema.accountDuplicateEvidence)
              .values({
                accountId: payloadAccount.id,
                otherAccountId: knownPosting.accountId,
              })
              .onConflictDoNothing();
          }
          // Already stored: never duplicate. The one allowed in-place fix
          // is the transaction date — if this read carries a different
          // authorized_date, correct the stored value so the posting moves
          // to the right period bucket.
          if (
            p.transactionDate !== undefined &&
            p.transactionDate !== transactionDateOf(knownPosting)
          ) {
            await db
              .update(schema.postings)
              .set({ transactionDate: p.transactionDate })
              .where(eq(schema.postings.id, knownPosting.id));
            postingsCorrected++;
          } else {
            postingsSkipped++;
          }
          continue;
        }
        const acct = byPlaidId.get(p.accountPlaidId);
        if (!acct) {
          postingsSkipped++;
          continue;
        }
        // Deleted (tombstoned) credits never attract postings.
        const liveCredits = (creditsByAccount.get(acct.id) ?? []).filter(
          (c) => c.deleted === 0,
        );
        const match = matchCreditForPosting(liveCredits, p.name);
        const insertedPosting = await db
          .insert(schema.postings)
          .values({
            txnId: p.txnId,
            accountId: acct.id,
            creditId: match?.id ?? null,
            date: p.date,
            transactionDate: p.transactionDate ?? null,
            name: p.name,
            amount: p.amount,
            source: "plaid",
          })
          .returning({ id: schema.postings.id });
        const newRow = insertedPosting[0];
        if (newRow) {
          existingByTxn.set(p.txnId, {
            id: newRow.id,
            txnId: p.txnId,
            accountId: acct.id,
            date: p.date,
            transactionDate: p.transactionDate ?? null,
          });
        }
        postingsAdded++;
      }

      // lastImportAt marks the last COMPLETE import. A windowed import that
      // did not complete (complete !== true) still merges its postings, but
      // must not move this marker: refreshCredits derives bootstrap /
      // gap-fill windows from it, and a partial read has to be retried, not
      // treated as done. Window-less imports (legacy/manual) keep the old
      // behavior of always marking.
      const certifiesComplete = args.windowStart == null || args.complete === true;
      if (certifiesComplete) {
        const importedAt = args.importedAt ?? new Date().toISOString();
        await db
          .insert(schema.meta)
          .values({ key: "lastImportAt", value: importedAt })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: importedAt },
          });
      }

      // Coverage bookkeeping: the stored dataset cumulatively covers from
      // the earliest window ever imported. An incremental (30-day) import
      // must never move this forward — it can only stay or extend backwards
      // (e.g. a bootstrap import whose window starts Jan 1).
      const metaRows = await db.select().from(schema.meta);
      const prevCoverage =
        metaRows.find((r) => r.key === "dataCoverageStart")?.value ?? null;
      const earliestPayloadPosting = args.postings.reduce<string | null>((min, p) => {
        const eff = p.transactionDate ?? p.date;
        return min == null || eff < min ? eff : min;
      }, null);
      // Coverage is certified ONLY by a completed fetch: from its
      // windowStart (or, for a completed window-less import, its earliest
      // posting). A windowed import that did not complete certifies
      // NOTHING — not even its earliest delivered posting — so a truncated
      // bootstrap can never masquerade as year coverage; the stored
      // coverage marker stays untouched and a later refresh retries the
      // bootstrap / gap-fill window. Window-less imports (legacy/manual,
      // no window claimed) keep certifying from their earliest posting.
      const thisCoverage =
        args.complete === true
          ? (args.windowStart ?? earliestPayloadPosting)
          : args.windowStart == null
            ? earliestPayloadPosting
            : null;
      const dataCoverageStart =
        prevCoverage == null
          ? thisCoverage
          : thisCoverage == null || prevCoverage <= thisCoverage
            ? prevCoverage
            : thisCoverage;
      if (dataCoverageStart != null && dataCoverageStart !== prevCoverage) {
        await db
          .insert(schema.meta)
          .values({ key: "dataCoverageStart", value: dataCoverageStart })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: dataCoverageStart },
          });
      }
      if (args.complete === true && args.windowStart) {
        await db
          .insert(schema.meta)
          .values({ key: "lastRefreshWindowStart", value: args.windowStart })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: args.windowStart },
          });
      }
      if (args.complete === true && args.windowEnd) {
        await db
          .insert(schema.meta)
          .values({ key: "lastRefreshWindowEnd", value: args.windowEnd })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: args.windowEnd },
          });
      }
      ctx.invalidateQueries();
      return {
        accountsAdded,
        postingsAdded,
        postingsSkipped,
        postingsCorrected,
        existingPostingsPreserved: existingPostingsCount,
        dataCoverageStart,
      };
    },
  }),

  refreshCredits: defineAction({
    request: z.object({}),
    response: z.object({
      started: z.boolean(),
      taskId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [metaRows, accountRows, postingRows, creditRowList] = await Promise.all([
        db.select().from(schema.meta),
        db.select().from(schema.accounts),
        db.select({ id: schema.postings.id }).from(schema.postings),
        db.select().from(schema.credits),
      ]);
      const timezone = resolveTimeZone(
        metaRows.find((r) => r.key === TIMEZONE_META_KEY)?.value,
      );
      const today = todayInTimeZone(timezone);
      const lastImportAt = metaRows.find((r) => r.key === "lastImportAt")?.value ?? null;
      const coverageStart = metaRows.find((r) => r.key === "dataCoverageStart")?.value ?? null;
      const lastImportDate = lastImportAt ? dateInTimeZone(lastImportAt, timezone) : null;
      // The fetch floor (see resolveRefreshWindow): Jan 1, or the start
      // of the earliest current period among the anchored credits the
      // user holds, when that is earlier — an anniversary-year credit
      // whose period began last November is useless if the bootstrap
      // never fetches November.
      const anchoredPeriodStarts: string[] = [];
      const collectAnchor = (period: Period, anchorMonth: number | null, anchorDay: number | null) => {
        if (anchorMonth == null || anchorDay == null) return;
        anchoredPeriodStarts.push(
          periodBounds(period, today, { month: anchorMonth, day: anchorDay }).start,
        );
      };
      for (const c of creditRowList) {
        if (c.deleted === 0) collectAnchor(c.period, c.anchorMonth, c.anchorDay);
      }
      for (const a of accountRows) {
        for (const d of [
          ...(catalogFor(a.name) ?? []),
          ...nonSeededDefsFor(a.name),
        ]) {
          collectAnchor(d.period, d.anchorMonth ?? null, d.anchorDay ?? null);
        }
      }
      const { windowStart, mode, floorStart, windowReason } = resolveRefreshWindow({
        today,
        hasAccounts: accountRows.length > 0,
        hasPostings: postingRows.length > 0,
        lastImportDate,
        coverageStart,
        anchoredPeriodStarts,
      });
      const message = [
        "Refresh the Credit Card Coupon Book Dashboard data from Plaid.",
        "",
        "Steps:",
        "1. Run `/opt/hatch/bin/plaid accounts` and collect every account: plaidAccountId = account_id, name, mask, balance = balances.current, creditLimit = balances.limit, currency = balances.iso_currency_code. The output groups accounts by login under `institutions` — each institution entry is ONE login, but owners are PEOPLE, not logins: one person can hold several logins (e.g. their Amex login and their Chase login), and this household has up to two people. Attribute accounts to people: set owner = \"A\" for the first person and owner = \"B\" for the second, deciding from the account evidence — the cardholder names on the accounts and which products each login holds — so that ALL of one person's accounts, across every one of their logins, carry that person's key. If you cannot tell which person a login's accounts belong to, OMIT owner for those accounts entirely: the dashboard lists them under 'login not identified yet' for the user to resolve. Never guess an owner from a grouping's position in the output. (Owner is sticky in storage — the import only fills accounts that have none yet and never overwrites an existing attribution — so a careful read matters most on the first refresh.)",
        `2. Run \`/opt/hatch/bin/plaid transactions-get --start-date ${windowStart} --end-date ${today}\` (dates are ${timezone} calendar dates). Fetch ONLY this window — ${windowReason}. Do not widen it. Keep only statement-credit postings: not pending, and the transaction name contains 'credit' or 'reimbursement' (case-insensitive) or is exactly 'Hilton'. (Amex pays some credits as a 'Reimbursement' with no 'credit' in the name — e.g. the Platinum airline fee credit posts as 'AMEX Airline Fee Reimbursement'; keep those too.) Postings run in BOTH directions: a credit the issuer PAID (Plaid amount < 0) and a REVERSAL / clawback of an earlier credit (Plaid amount > 0 under a credit name — the issuer took the credit back). Keep both. For each kept transaction produce: txnId = transaction_id, accountPlaidId = account_id, date = the transaction's posted date (its \`date\` field), transactionDate = its authorized_date — pass authorized_date as transactionDate for EVERY posting (when Plaid gives no authorized_date, set transactionDate to the posted date). Credits count toward the period of the TRANSACTION date, not the posting date; the posted date is kept for display only. name, amount = the NEGATION of Plaid's amount: positive dollars when the issuer paid a credit, NEGATIVE dollars when the issuer reversed or clawed one back. Signed amounts are how corrections are represented — the store never deletes, so a clawback must arrive as a negative posting that nets against the original credit; never drop a reversal and never flip its sign.`,
        `3. Call this artifact's \`importSnapshot\` action with { accounts, postings, windowStart: "${windowStart}", windowEnd: "${today}", complete } exactly in that shape. Set complete to true ONLY if the Plaid accounts and transactions reads both succeeded for the entire window; if any read failed, was cut off, or returned partial data, set complete to false — the import then still merges what you read but does NOT certify the window as covered, so the next refresh retries this window instead of assuming coverage. The import is MERGE-ONLY: it inserts postings whose transaction id is new and never deletes, clears, or replaces stored data, so postings from earlier (back to ${floorStart}) that fall outside this fetched window are preserved and keep counting — do not try to re-send or 'restore' them, and never pass an empty snapshot to reset anything. (One exception: if a re-fetched posting's authorized_date differs from what was stored, the import corrects its transactionDate in place — that is expected; always send both dates exactly as Plaid reports them.) Call importSnapshot even if the window contains zero new postings (accounts plus an empty postings array, complete: true when the empty result is a successful read), so the refresh is recorded. Do not invent, rename, or round any values; copy names and amounts from the Plaid output verbatim. If Plaid reports not connected or a read fails, still call importSnapshot with whatever complete data you could read and complete: false, and say what was missing in your final message.`,
      ].join("\n");
      const res = await ctx.agent.spawnTask(message, {
        expectsAction: "importSnapshot",
        dedupeKey: "plaid-credits-refresh",
      });
      if (!res.ok) {
        return { started: false, taskId: null, error: res.error };
      }
      await db
        .insert(schema.meta)
        .values({ key: "refreshTaskId", value: res.taskId })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: res.taskId } });
      await db
        .insert(schema.meta)
        .values({ key: "lastRefreshMode", value: mode })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: mode } });
      await db
        .insert(schema.meta)
        .values({ key: "lastRefreshWindowStart", value: windowStart })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: windowStart } });
      await db
        .insert(schema.meta)
        .values({ key: "lastRefreshWindowEnd", value: today })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: today } });
      return { started: true, taskId: res.taskId, error: null };
    },
  }),

  refreshStatus: defineAction({
    request: z.object({}),
    response: z.object({
      status: z.enum(["none", "queued", "running", "completed", "failed", "not_found"]),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.meta)
        .where(eq(schema.meta.key, "refreshTaskId"));
      const taskId = rows[0]?.value;
      if (!taskId) return { status: "none" as const };
      const s = await ctx.agent.status(taskId);
      return { status: s.status };
    },
  }),

  // Display labels for the two Amex logins (owner keys "A" / "B"). Stored in
  // the meta table; getDashboard falls back to "Login 1" / "Login 2" when a
  // label has never been set.
  setOwnerLabels: defineAction({
    request: z.object({
      aLabel: z.string().trim().min(1).max(40).optional(),
      bLabel: z.string().trim().min(1).max(40).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const writes: [string, string][] = [];
      if (args.aLabel !== undefined) writes.push(["ownerALabel", args.aLabel]);
      if (args.bLabel !== undefined) writes.push(["ownerBLabel", args.bLabel]);
      for (const [key, value] of writes) {
        await db
          .insert(schema.meta)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.meta.key, set: { value } });
      }
      if (writes.length > 0) ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Display-exclusion preference: which credits the dashboard hides.
  // Stored in meta as JSON under `excludedCredits`; when it has never been
  // set, the built-in DEFAULT_EXCLUDED_PATTERNS applies, and once the user
  // stores a selection it is authoritative (an empty list shows
  // everything). Two writers, one storage path: the dashboard's Display
  // settings section (a toggle per hideable family) and the user's
  // assistant in chat both read / rewrite the preference through these
  // two actions. Hidden credits stay out of the dashboard list and every
  // total, and are named in the Agent Markdown so an assistant knows they
  // exist.
  getPreferences: defineAction({
    request: z.object({}),
    response: z.object({
      /** The effective exclusion list in force (stored, or the defaults). */
      excludedCredits: z.array(z.string()),
      /**
       * Every hideable family with its label and whether the effective
       * list currently hides it — the read the Display settings toggles
       * render from. `hidden` uses the same substring matching as the
       * dashboard filter, so a family stored under its full credit name
       * (not the short pattern) still reports hidden.
       */
      hideableFamilies: z.array(
        z.object({
          pattern: z.string(),
          label: z.string(),
          hidden: z.boolean(),
        }),
      ),
      /** The timezone "today" and all period boundaries are computed in. */
      timezone: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.meta);
      const excludedCredits =
        parseExcludedPatterns(
          rows.find((r) => r.key === EXCLUDED_CREDITS_META_KEY)?.value,
        ) ?? [...DEFAULT_EXCLUDED_PATTERNS];
      return {
        excludedCredits,
        hideableFamilies: HIDEABLE_FAMILIES.map((f) => ({
          ...f,
          hidden: isExcludedName(f.label, excludedCredits),
        })),
        timezone: resolveTimeZone(
          rows.find((r) => r.key === TIMEZONE_META_KEY)?.value,
        ),
      };
    },
  }),

  // The user's timezone: "today" and every period boundary are computed
  // in it. Stored in meta; America/Los_Angeles until set.
  setTimezone: defineAction({
    request: z.object({
      timezone: z
        .string()
        .refine(isValidTimeZone, "must be a valid IANA timezone name"),
    }),
    response: z.object({ timezone: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (!isValidTimeZone(args.timezone)) {
        throw new Error(`setTimezone: not a valid IANA timezone name: ${args.timezone}`);
      }
      await db
        .insert(schema.meta)
        .values({ key: TIMEZONE_META_KEY, value: args.timezone })
        .onConflictDoUpdate({
          target: schema.meta.key,
          set: { value: args.timezone },
        });
      ctx.invalidateQueries();
      return { timezone: args.timezone };
    },
  }),

  setExcludedCredits: defineAction({
    request: z.object({
      /** The COMPLETE new exclusion list — it replaces the stored one. */
      excludedCredits: z.array(z.string().min(1).max(80)).max(50),
    }),
    response: z.object({ excludedCredits: z.array(z.string()) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const normalized: string[] = [];
      for (const raw of args.excludedCredits) {
        const p = raw.trim().toLowerCase();
        if (p !== "" && !normalized.includes(p)) normalized.push(p);
      }
      // Validation is CANONICAL, not fuzzy: an entry is accepted only
      // when it is exactly a hideable family's pattern or label, a full
      // catalog credit name, or a full stored credit name. Fragments
      // like "credit" or "air" — which the read-time substring matcher
      // would expand to nearly every credit on the dashboard — are
      // rejected with a clear error instead of hiding the world.
      const storedNames = (
        await db.select({ name: schema.credits.name }).from(schema.credits)
      ).map((r) => r.name);
      const canonicalEntries = [
        ...HIDEABLE_FAMILIES.map((f) => f.pattern),
        ...HIDEABLE_CREDIT_NAMES,
        ...ALL_CATALOG_CREDIT_NAMES,
        ...storedNames,
      ];
      const unknown = normalized.filter(
        (p) => !isKnownExclusionEntry(p, canonicalEntries),
      );
      if (unknown.length > 0) {
        throw new Error(
          `setExcludedCredits: unknown credit name(s): ${unknown.join(", ")} — ` +
            "each entry must be a hideable family pattern or the full name of a credit from the catalog or the stored credits (fragments are not accepted)",
        );
      }
      const value = JSON.stringify(normalized);
      await db
        .insert(schema.meta)
        .values({ key: EXCLUDED_CREDITS_META_KEY, value })
        .onConflictDoUpdate({
          target: schema.meta.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { excludedCredits: normalized };
    },
  }),

  updateCredit: defineAction({
    request: z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      amount: z.number().nonnegative().optional(),
      period: periodEnum.optional(),
      /** Anniversary anchor for annual credits; pass null to clear back to calendar-year. */
      anchorMonth: z.number().int().min(1).max(12).nullable().optional(),
      anchorDay: z.number().int().min(1).max(31).nullable().optional(),
      /** Mark the anchor confirmed (or back to unconfirmed) without changing it. */
      anchorConfirmed: z.boolean().optional(),
      /** Assert enrollment (true/false), or null to clear back to unconfirmed. */
      enrolled: z.boolean().nullable().optional(),
      active: z.boolean().optional(),
      note: z.string().optional(),
      matchPattern: z.string().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      // Materialize-on-write: a negative id is a synthesized instance —
      // acting on it first creates its stored row, so the edit sticks
      // instead of silently no-oping against a nonexistent row.
      const row = await resolveCreditRow(db, args.id);
      if (!row) throw new Error(`updateCredit: credit ${args.id} not found`);
      const patch: Partial<typeof schema.credits.$inferInsert> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.amount !== undefined) patch.amount = args.amount;
      if (args.period !== undefined) patch.period = args.period;
      // The anchor is a PAIR: month and day are set together or cleared
      // together. A half-set anchor is rejected loudly — silently
      // falling back to the calendar year while the user believes they
      // set an anniversary cycle is how wrong periods happen.
      if (args.anchorMonth !== undefined || args.anchorDay !== undefined) {
        const nextMonth =
          args.anchorMonth !== undefined ? args.anchorMonth : row.anchorMonth;
        const nextDay =
          args.anchorDay !== undefined ? args.anchorDay : row.anchorDay;
        if ((nextMonth == null) !== (nextDay == null)) {
          throw new Error(
            "updateCredit: anchorMonth and anchorDay must be set together (or both cleared) — a half-set anchor is not a valid anniversary anchor",
          );
        }
        patch.anchorMonth = nextMonth;
        patch.anchorDay = nextDay;
        // Setting (or clearing) the anchor IS the user deciding it:
        // the result counts as confirmed.
        patch.anchorConfirmed = 1;
      }
      if (args.anchorConfirmed !== undefined) {
        patch.anchorConfirmed = args.anchorConfirmed ? 1 : 0;
      }
      if (args.enrolled !== undefined) {
        if (args.enrolled === null) {
          // Clearing the assertion returns the row to UNCONFIRMED — the app
          // never claims an enrollment state the user did not assert.
          patch.enrolledAsserted = 0;
        } else {
          patch.enrolled = args.enrolled ? 1 : 0;
          patch.enrolledAsserted = 1;
        }
      }
      if (args.active !== undefined) patch.active = args.active ? 1 : 0;
      if (args.note !== undefined) patch.note = args.note;
      if (args.matchPattern !== undefined) patch.matchPattern = args.matchPattern;
      if (Object.keys(patch).length > 0) {
        await db.update(schema.credits).set(patch).where(eq(schema.credits.id, row.id));
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  addCredit: defineAction({
    request: z.object({
      accountId: z.number(),
      name: z.string().min(1),
      amount: z.number().positive(),
      period: periodEnum,
      anchorMonth: z.number().int().min(1).max(12).optional(),
      anchorDay: z.number().int().min(1).max(31).optional(),
      note: z.string().default(""),
      matchPattern: z.string().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // The anchor is a pair — both fields or neither (see updateCredit).
      if ((args.anchorMonth == null) !== (args.anchorDay == null)) {
        throw new Error(
          "addCredit: anchorMonth and anchorDay must be set together (or both omitted)",
        );
      }
      const accountRows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.accountId));
      const account = accountRows[0];
      if (!account) throw new Error("addCredit: account not found");
      // Never assume enrollment for a benefit that requires it.
      const enrollment = enrollmentInfoFor(account.name, args.name);
      const values = {
        accountId: args.accountId,
        name: args.name,
        amount: args.amount,
        period: args.period,
        anchorMonth: args.anchorMonth ?? null,
        anchorDay: args.anchorDay ?? null,
        // An anchor the user typed in themselves is confirmed by definition.
        anchorConfirmed: 1,
        enrolled: enrollment.required ? 0 : 1,
        enrolledAsserted: 0,
        note: args.note,
        matchPattern: args.matchPattern,
        sortOrder: 100,
      };
      // Re-adding a credit the user once deleted REVIVES its tombstone
      // instead of inserting a duplicate row beside it.
      const existing = await db.select().from(schema.credits);
      const tombstone = existing.find(
        (c) =>
          c.accountId === args.accountId &&
          c.deleted === 1 &&
          c.name.trim().toLowerCase() === args.name.trim().toLowerCase(),
      );
      if (tombstone) {
        await db
          .update(schema.credits)
          .set({ ...values, deleted: 0, active: 1 })
          .where(eq(schema.credits.id, tombstone.id));
        ctx.invalidateQueries();
        return { id: tombstone.id };
      }
      const inserted = await db
        .insert(schema.credits)
        .values(values)
        .returning({ id: schema.credits.id });
      const row = inserted[0];
      if (!row) throw new Error("addCredit: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteCredit: defineAction({
    request: z.object({ id: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      // Materialize-on-write applies to deletion too: deleting a
      // synthesized instance materializes its row and tombstones it, so
      // the deletion persists. Deleting a stored row is likewise a
      // TOMBSTONE (deleted = 1), never a hard delete — otherwise
      // compute-time synthesis would resurrect the credit on the next
      // read with catalog defaults, silently undoing the user.
      const row = await resolveCreditRow(db, args.id);
      if (!row) throw new Error(`deleteCredit: credit ${args.id} not found`);
      await db
        .update(schema.postings)
        .set({ creditId: null })
        .where(eq(schema.postings.creditId, row.id));
      await db
        .update(schema.credits)
        .set({ deleted: 1, active: 0 })
        .where(eq(schema.credits.id, row.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  addManualPosting: defineAction({
    request: z.object({
      creditId: z.number(),
      date: dateString,
      /**
       * SIGNED amount: positive = credit received, negative = a
       * clawback / reversal recorded by hand. Zero is meaningless and
       * rejected.
       */
      amount: z.number().refine((v) => v !== 0, "amount must be non-zero"),
      note: z.string().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (!isValidCalendarDate(args.date)) {
        throw new Error(`addManualPosting: not a real calendar date: ${args.date}`);
      }
      // A negative creditId is a synthesized instance: materialize it
      // first so the manual posting has a real row to land on.
      const credit = await resolveCreditRow(db, args.creditId);
      if (!credit) throw new Error("addManualPosting: credit not found");
      const inserted = await db
        .insert(schema.postings)
        .values({
          txnId: null,
          accountId: credit.accountId,
          creditId: credit.id,
          date: args.date,
          name: args.note !== "" ? args.note : "Manual entry",
          amount: args.amount,
          source: "manual",
        })
        .returning({ id: schema.postings.id });
      const row = inserted[0];
      if (!row) throw new Error("addManualPosting: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deletePosting: defineAction({
    request: z.object({ id: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.postings).where(eq(schema.postings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  assignPosting: defineAction({
    request: z.object({ postingId: z.number(), creditId: z.number().nullable() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const postingRows = await db
        .select()
        .from(schema.postings)
        .where(eq(schema.postings.id, args.postingId));
      const posting = postingRows[0];
      if (!posting) throw new Error(`assignPosting: posting ${args.postingId} not found`);
      let creditId: number | null = null;
      if (args.creditId != null) {
        // The target must be a real credit ON THE POSTING'S OWN ACCOUNT:
        // a positive id must exist (and not be a tombstone); a negative
        // id names a synthesized instance, which is materialized so the
        // assignment persists. Anything else is an error — a dangling
        // reference would make the posting vanish from every view.
        const credit = await resolveCreditRow(db, args.creditId);
        if (!credit) {
          throw new Error(`assignPosting: credit ${args.creditId} not found`);
        }
        if (credit.accountId !== posting.accountId) {
          throw new Error(
            "assignPosting: the credit belongs to a different account than the posting",
          );
        }
        creditId = credit.id;
      }
      await db
        .update(schema.postings)
        .set({ creditId })
        .where(eq(schema.postings.id, args.postingId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setAccountIgnored: defineAction({
    request: z.object({ accountId: z.number(), ignored: z.boolean() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.accounts)
        .set({ ignored: args.ignored ? 1 : 0 })
        .where(eq(schema.accounts.id, args.accountId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Per-account user settings that Plaid must never overwrite: the
  // display nickname (prefix), the fifth digit that tells same-ending
  // cards apart, and — as an explicit user correction, in contrast to
  // imports, which only ever fill an unset owner — the owner person key.
  updateAccount: defineAction({
    request: z.object({
      accountId: z.number(),
      /** Display prefix for the account; "" clears it. */
      nickname: z.string().trim().max(24).optional(),
      /**
       * Fifth-from-last card digit (a single character 0-9) distinguishing
       * this card from a same-ending one; "" clears it. Validated in the
       * handler, not only here — see below.
       */
      fifthDigit: z.string().optional(),
      /** Owner person key ("A" / "B"); null un-attributes the account. */
      owner: z.string().trim().min(1).max(8).nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.accountId));
      if (!rows[0]) throw new Error(`updateAccount: account ${args.accountId} not found`);
      const patch: Partial<typeof schema.accounts.$inferInsert> = {};
      if (args.nickname !== undefined) patch.nickname = args.nickname;
      if (args.fifthDigit !== undefined) {
        // Handler-enforced, like the import date rule: the request
        // schema is not the only way in, and a malformed value must
        // never reach storage, where effective-ending comparisons
        // would read it as a real distinguishing digit.
        const d = args.fifthDigit.trim();
        if (!/^[0-9]?$/.test(d)) {
          throw new Error(
            "updateAccount: fifthDigit must be a single digit 0-9, or empty to clear",
          );
        }
        patch.fifthDigit = d;
      }
      if (args.owner !== undefined) patch.owner = args.owner;
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.accounts)
          .set(patch)
          .where(eq(schema.accounts.id, args.accountId));
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  listUnassignedCount: defineAction({
    request: z.object({}),
    response: z.object({ count: z.number() }),
    async handler(ctx) {
      // The count IS the dashboard's Unassigned list length — same
      // filters (ignored accounts, compute-time attribution, exclusion
      // names), computed by the same function, so the two can never
      // disagree the way a raw creditId-null count did.
      const data = await computeDashboard(ctx.db<typeof schema>());
      return { count: data.unassignedCount };
    },
  }),
} satisfies ActionsModule;
