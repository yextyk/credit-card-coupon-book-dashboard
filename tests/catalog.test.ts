import { describe, expect, test } from "bun:test";
import {
  catalogFor,
  catalogPatternFor,
  defaultNameFor,
  DEFAULT_ENROLLMENT_NOTE,
  DEFAULT_OWNER_LABELS,
  enrollmentInfoFor,
  isExcludedName,
  isPinnedCredit,
  issuerForAccountName,
  nonSeededDefsFor,
  ownerLabelFor,
} from "../server/src/actions";

describe("catalogFor — product detection", () => {
  test("Business Platinum gets the business catalog (checked before generic Platinum)", () => {
    const defs = catalogFor("Business Platinum Card®");
    expect(defs).not.toBeNull();
    const names = defs!.map((d) => d.name);
    expect(names).toContain("Dell Credit");
    expect(names).toContain("Wireless Credit");
    expect(names).not.toContain("Resy Credit");
  });

  test("Aspire gets flight + resort credits", () => {
    const defs = catalogFor("Hilton Honors Aspire Card")!;
    expect(defs).toEqual([
      expect.objectContaining({ name: "Flight Credit", amount: 50, period: "quarterly" }),
      expect.objectContaining({ name: "Hilton Resort Credit", amount: 200, period: "semiannual" }),
    ]);
  });

  test("Aspire resort credit carries no anniversary anchor (calendar halves)", () => {
    // Amex's benefit terms run the resort credit January–June and
    // July–December, independent of the account anniversary. An anchor
    // here would silently shift every cardholder's periods, so the
    // catalog must not seed one.
    const resort = catalogFor("Hilton Honors Aspire Card")!.find(
      (d) => d.name === "Hilton Resort Credit",
    )!;
    expect(resort.anchorMonth).toBeUndefined();
    expect(resort.anchorDay).toBeUndefined();
  });

  test("Brilliant gets the monthly dining credit", () => {
    const defs = catalogFor("Marriott Bonvoy Brilliant® American Express® Card")!;
    expect(defs[0]).toEqual(
      expect.objectContaining({ name: "Dining Credit", amount: 25, period: "monthly" }),
    );
  });

  test("Business Gold gets the flexible business credit", () => {
    const defs = catalogFor("Business Gold Card")!;
    expect(defs).toEqual([
      expect.objectContaining({ name: "Flexible Business Credit", amount: 20, period: "monthly" }),
    ]);
  });

  test("co-branded Platinum variants fall through to the personal Platinum catalog", () => {
    const defs = catalogFor("Morgan Stanley Platinum Card®")!;
    const names = defs.map((d) => d.name);
    expect(names).toContain("Resy Credit");
    expect(names).toContain("Lululemon Credit");
    expect(names).not.toContain("Dell Credit");
  });

  test("cards without a coupon-book catalog return null", () => {
    expect(catalogFor("Blue Business Plus Card")).toBeNull();
    expect(catalogFor("Generic Store Card")).toBeNull();
    expect(catalogFor("Amex EveryDay® Card")).toBeNull();
  });

  test("matching is case-insensitive", () => {
    expect(catalogFor("hilton honors aspire card")).not.toBeNull();
    expect(catalogFor("BUSINESS GOLD CARD")).not.toBeNull();
  });
});

describe("catalogFor — Chase products", () => {
  test("Sapphire Preferred gets the $100 hotel credit on a May 1 anniversary anchor", () => {
    const defs = catalogFor("Chase Sapphire Preferred®")!;
    expect(defs).toEqual([
      expect.objectContaining({
        name: "Annual Hotel Credit",
        amount: 100,
        period: "annual",
        anchorMonth: 5,
        anchorDay: 1,
        pattern: "annual hotel credit",
      }),
    ]);
  });

  test("World of Hyatt Business gets the $100 credit (2 x $50) on a May 1 anchor", () => {
    const defs = catalogFor("World of Hyatt Business Credit Card")!;
    expect(defs).toEqual([
      expect.objectContaining({
        name: "Hyatt Credit",
        amount: 100,
        period: "annual",
        anchorMonth: 5,
        anchorDay: 1,
        pattern: "credit adjustment",
      }),
    ]);
  });

  test("the personal World of Hyatt card (no 'Business') has no catalog", () => {
    expect(catalogFor("World of Hyatt Credit Card")).toBeNull();
  });

  test("IHG Premier gets only the $100 airline credit", () => {
    // The card's United TravelBank benefit is NOT a statement credit (Chase
    // deposits cash into the holder's TravelBank account), so it is
    // deliberately absent from the catalog.
    const defs = catalogFor("IHG One Rewards Premier Credit Card")!;
    expect(defs).toEqual([
      expect.objectContaining({ name: "Airline Credit", amount: 100, period: "annual" }),
    ]);
  });

  test("the non-Premier IHG card has no catalog", () => {
    expect(catalogFor("IHG One Rewards Traveler Credit Card")).toBeNull();
  });

  test("Ritz-Carlton gets the $300 travel credit (manual request, calendar year)", () => {
    const defs = catalogFor("The Ritz-Carlton® Credit Card")!;
    expect(defs).toEqual([
      expect.objectContaining({
        name: "Travel Credit",
        amount: 300,
        period: "annual",
        pattern: "travel credit",
      }),
    ]);
    expect(defs[0]!.anchorMonth).toBeUndefined();
  });
});

describe("issuerForAccountName", () => {
  test("Chase products are Chase", () => {
    for (const name of [
      "Chase Sapphire Preferred®",
      "World of Hyatt Business Credit Card",
      "IHG One Rewards Premier Credit Card",
      "The Ritz-Carlton® Credit Card",
    ]) {
      expect(issuerForAccountName(name)).toBe("Chase");
    }
  });

  test("Amex products (and anything unrecognized) default to Amex", () => {
    expect(issuerForAccountName("Hilton Honors Aspire Card")).toBe("Amex");
    expect(issuerForAccountName("Business Platinum Card®")).toBe("Amex");
    expect(issuerForAccountName("Generic Store Card")).toBe("Amex");
  });
});

describe("isExcludedName — display exclusion list", () => {
  test("excludes the seven hidden benefit families", () => {
    for (const name of [
      "ChatGPT Business Credit",
      "AMEX Indeed Credit",
      "Adobe Acrobat Credit",
      "CLEAR+ Credit",
      "Equinox Credit",
      "Digital Entertainment Credit",
      "Walmart+ Credit",
    ]) {
      expect(isExcludedName(name)).toBe(true);
    }
  });

  test("matching is case-insensitive substring matching", () => {
    expect(isExcludedName("amex chatgpt business credit")).toBe(true);
    expect(isExcludedName("ENTERTAINMENT CREDIT")).toBe(true);
  });

  test("ordinary credits are not excluded", () => {
    for (const name of [
      "Flight Credit",
      "Hilton Resort Credit",
      "Dining Credit",
      "Wireless Credit",
      "Flexible Business Credit",
      "Airline Fee Credit",
    ]) {
      expect(isExcludedName(name)).toBe(false);
    }
  });
});

describe("isPinnedCredit — always-displayed credits", () => {
  test("flexible business and wireless credits are pinned", () => {
    expect(isPinnedCredit("Flexible Business Credit")).toBe(true);
    expect(isPinnedCredit("AMEX Wireless Credit")).toBe(true);
  });

  test("other credits are not pinned", () => {
    expect(isPinnedCredit("Dining Credit")).toBe(false);
    expect(isPinnedCredit("Flight Credit")).toBe(false);
  });
});

describe("enrollmentRequired — catalog metadata", () => {
  // One representative account name per supported product.
  const PRODUCTS = [
    "Business Platinum Card®",
    "Business Gold Card",
    "The Platinum Card®",
    "Hilton Honors Aspire Card",
    "Marriott Bonvoy Brilliant® American Express® Card",
    "Chase Sapphire Preferred®",
    "World of Hyatt Business Credit Card",
    "IHG One Rewards Premier Credit Card",
    "The Ritz-Carlton® Credit Card",
  ];

  test("exactly the enrollment-based benefits are marked — no more, no fewer", () => {
    const marked: string[] = [];
    for (const product of PRODUCTS) {
      const defs = [...(catalogFor(product) ?? []), ...nonSeededDefsFor(product)];
      for (const d of defs) {
        if (d.enrollmentRequired) marked.push(`${product} :: ${d.name}`);
      }
    }
    expect(marked.sort()).toEqual(
      [
        // Business Platinum: the Hilton credit is gated on Hilton for
        // Business enrollment.
        "Business Platinum Card® :: Hilton Credit",
        // ChatGPT Business: verified per-card enrollment on both
        // business products that carry it.
        "Business Platinum Card® :: ChatGPT Business Credit",
        "Business Gold Card :: ChatGPT Business Credit",
        // Business Platinum benefits Amex enrolls before purchases
        // count (Dell, and the default-hidden Indeed / Adobe).
        "Business Platinum Card® :: Dell Credit",
        "Business Platinum Card® :: Indeed Credit",
        "Business Platinum Card® :: Adobe Credit",
        // The airline fee credit is enroll-and-select on both
        // Platinum products: one airline must be chosen, and only
        // that airline's charges count.
        "Business Platinum Card® :: Airline Fee Credit",
        "The Platinum Card® :: Airline Fee Credit",
        // Personal Platinum benefits whose terms require enrollment
        // (their catalog notes already said so).
        "The Platinum Card® :: Resy Credit",
        "The Platinum Card® :: Equinox Credit",
        "The Platinum Card® :: Digital Entertainment Credit",
        "The Platinum Card® :: Walmart+ Credit",
      ].sort(),
    );
  });

  test("automatic statement credits are not marked", () => {
    for (const [product, credit] of [
      ["Hilton Honors Aspire Card", "Flight Credit"],
      ["Hilton Honors Aspire Card", "Hilton Resort Credit"],
      ["Chase Sapphire Preferred®", "Annual Hotel Credit"],
      ["Business Platinum Card®", "Wireless Credit"],
      ["Business Gold Card", "Flexible Business Credit"],
      ["Marriott Bonvoy Brilliant® American Express® Card", "Dining Credit"],
      // The IHG airline credit is automatic — no enrollment step.
      ["IHG One Rewards Premier Credit Card", "Airline Credit"],
      // The Ritz travel credit is a manual claim, not an enrollment.
      ["The Ritz-Carlton® Credit Card", "Travel Credit"],
    ] as const) {
      expect(enrollmentInfoFor(product, credit)).toEqual({ required: false, note: null });
    }
  });

  test("enrollmentInfoFor resolves per-def notes and the generic fallback", () => {
    const chatgpt = enrollmentInfoFor("Business Gold Card", "ChatGPT Business Credit");
    expect(chatgpt.required).toBe(true);
    expect(chatgpt.note).toContain("enrolled in the ChatGPT Business credit separately");
    // Resy sets the flag without its own note → the generic notice.
    expect(enrollmentInfoFor("The Platinum Card®", "Resy Credit")).toEqual({
      required: true,
      note: DEFAULT_ENROLLMENT_NOTE,
    });
    // The airline fee credit is enroll-and-select on both Platinum
    // products, and its note carries all three facts.
    const airline = enrollmentInfoFor("Business Platinum Card®", "Airline Fee Credit");
    expect(airline.required).toBe(true);
    expect(airline.note).toContain("select a single qualifying airline");
    expect(airline.note).toContain("only that airline's incidental charges count");
    expect(airline.note).toContain("changed each January");
    expect(enrollmentInfoFor("The Platinum Card®", "Airline Fee Credit")).toEqual(airline);
    // A name no catalog def carries is not an enrollment benefit.
    expect(enrollmentInfoFor("Business Gold Card", "Made-Up Credit")).toEqual({
      required: false,
      note: null,
    });
  });
});

describe("catalog defs — match patterns are never empty", () => {
  // One representative account name per supported product (seeded and
  // non-seeded defs alike).
  const PRODUCTS = [
    "Business Platinum Card®",
    "Business Gold Card",
    "The Platinum Card®",
    "Morgan Stanley Platinum Card®",
    "Hilton Honors Aspire Card",
    "Marriott Bonvoy Brilliant® American Express® Card",
    "Chase Sapphire Preferred®",
    "World of Hyatt Business Credit Card",
    "IHG One Rewards Premier Credit Card",
    "The Ritz-Carlton® Credit Card",
    "Marriott Bonvoy Boundless® Credit Card",
    "United℠ Explorer Card",
    "United℠ Business Card",
    "Aeroplan® Credit Card",
    "U.S. Bank Altitude® Reserve Visa Infinite® Card",
    "U.S. Bank Triple Cash Rewards Visa® Business Card",
  ];

  test("every catalog def carries a non-empty match pattern", () => {
    // A def with an empty pattern can never auto-match a posting: its
    // credits would silently pile up in Unassigned.
    for (const product of PRODUCTS) {
      const defs = [...(catalogFor(product) ?? []), ...nonSeededDefsFor(product)];
      for (const d of defs) {
        expect(d.pattern).not.toBe("");
      }
    }
  });

  test("catalogPatternFor resolves a def's pattern by product and credit name", () => {
    expect(catalogPatternFor("IHG One Rewards Premier Credit Card", "Airline Credit")).toBe(
      "airline credit",
    );
    expect(catalogPatternFor("Hilton Honors Aspire Card", "Flight Credit")).toBe(
      "flight credit|hilton",
    );
    // Matching is by trimmed, case-insensitive exact name.
    expect(catalogPatternFor("IHG One Rewards Premier Credit Card", " airline credit ")).toBe(
      "airline credit",
    );
    // No def by that name on the product → no pattern to inherit.
    expect(catalogPatternFor("IHG One Rewards Premier Credit Card", "Made-Up Credit")).toBe("");
    expect(catalogPatternFor("Generic Store Card", "Airline Credit")).toBe("");
  });
});

describe("ownerLabelFor — login label resolution", () => {
  const labels: [string, string] = ["Alex", "Sam"];

  test("keys A and B resolve to the configured labels", () => {
    expect(ownerLabelFor("A", labels)).toBe("Alex");
    expect(ownerLabelFor("B", labels)).toBe("Sam");
  });

  test("missing owner stays null", () => {
    expect(ownerLabelFor(null, labels)).toBeNull();
    expect(ownerLabelFor("", labels)).toBeNull();
  });

  test("a stored value that is not a key passes through verbatim (it is already a label)", () => {
    expect(ownerLabelFor("Alex", labels)).toBe("Alex");
  });

  test("defaults are neutral login names", () => {
    expect(DEFAULT_OWNER_LABELS).toEqual(["Login 1", "Login 2"]);
    expect(ownerLabelFor("A", DEFAULT_OWNER_LABELS)).toBe("Login 1");
  });
});

describe("defaultNameFor — catalog default display names", () => {
  test("Chase and U.S. Bank products get their short default names", () => {
    expect(defaultNameFor("Chase Sapphire Preferred®")).toBe("CSP");
    expect(defaultNameFor("World of Hyatt Business Credit Card")).toBe("HyattBus");
    expect(defaultNameFor("World of Hyatt Credit Card")).toBe("Hyatt");
    expect(defaultNameFor("IHG One Rewards Premier Credit Card")).toBe("IHG-Premier");
    expect(defaultNameFor("IHG One Rewards Select Credit Card")).toBe("IHG-Select");
    expect(defaultNameFor("IHG One Rewards Traveler Credit Card")).toBe("IHG");
    expect(defaultNameFor("The Ritz-Carlton® Credit Card")).toBe("Ritz");
    expect(defaultNameFor("Marriott Bonvoy Boundless® Credit Card")).toBe("Boundless");
    expect(defaultNameFor("Marriott Bonvoy® Business American Express® Card")).toBe("BonvoyBus");
    expect(defaultNameFor("United℠ Business Card")).toBe("UABus");
    expect(defaultNameFor("United℠ Explorer Card")).toBe("UA");
    expect(defaultNameFor("Aeroplan® Credit Card")).toBe("Aeroplan");
    expect(defaultNameFor("U.S. Bank Altitude® Reserve Visa Infinite® Card")).toBe("UAR");
    expect(defaultNameFor("U.S. Bank Triple Cash Rewards Visa® Business Card")).toBe("TripleCash");
  });

  test("detection order keeps the specific product ahead of the generic one", () => {
    // Business variants must win over their personal counterparts.
    expect(defaultNameFor("World of Hyatt Business Credit Card")).not.toBe("Hyatt");
    expect(defaultNameFor("United℠ Business Card")).not.toBe("UA");
    // Premier and Select must win over the bare IHG fallback.
    expect(defaultNameFor("IHG One Rewards Premier Credit Card")).not.toBe("IHG");
  });

  test("products whose names already carry the product get no default", () => {
    expect(defaultNameFor("Hilton Honors Aspire Card")).toBeNull();
    expect(defaultNameFor("Business Platinum Card®")).toBeNull();
    expect(defaultNameFor("Marriott Bonvoy Brilliant® American Express® Card")).toBeNull();
    // A generically named account identifies no product at all.
    expect(defaultNameFor("CREDIT CARD")).toBeNull();
    expect(defaultNameFor("Credit Card - 7536")).toBeNull();
  });
});
