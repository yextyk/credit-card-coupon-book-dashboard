import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { addDays, Actions, periodBounds } from "../server/src/actions";
import * as schema from "../server/src/schema";
import { createTestDb, fakeCtx, todayLA } from "./helpers";
import { ALEX_ASPIRE, ALEX_BIZ_PLAT, ALEX_IHG_PREMIER, ALEX_SAPPHIRE, JANUARY_SNAPSHOT, SAM_MS_PLATINUM } from "./fixtures/sample";

async function importJanuary(db: ReturnType<typeof createTestDb>) {
  return Actions.importSnapshot.handler(fakeCtx(db), structuredClone(JANUARY_SNAPSHOT) as any);
}

describe("importSnapshot — merge-only import", () => {
  test("first import adds accounts, seeds the catalog, and auto-maps postings", async () => {
    const db = createTestDb();
    const res: any = await importJanuary(db);
    expect(res.accountsAdded).toBe(2);
    expect(res.postingsAdded).toBe(4);
    expect(res.postingsSkipped).toBe(0);
    expect(res.existingPostingsPreserved).toBe(0);
    expect(res.dataCoverageStart).toBe("2026-01-01");

    // Catalog seeded from the card product: Aspire 2 credits, Business Platinum 5.
    const credits = await db.select().from(schema.credits);
    expect(credits).toHaveLength(7);

    // Postings auto-mapped by name pattern; the unrecognized one stays unassigned.
    const postings = await db
      .select()
      .from(schema.postings)
      .orderBy(asc(schema.postings.id));
    const creditName = new Map(credits.map((c) => [c.id, c.name]));
    const mapped = postings.map((p) => ({
      name: p.name,
      credit: p.creditId == null ? null : creditName.get(p.creditId),
    }));
    expect(mapped).toEqual([
      { name: "AMEX Flight Credit", credit: "Flight Credit" },
      { name: "Hilton", credit: "Hilton Resort Credit" },
      { name: "AMEX Airline Fee Reimbursement", credit: "Airline Fee Credit" },
      { name: "Mystery Statement Credit", credit: null },
    ]);
  });

  test("re-importing the identical snapshot adds nothing (dedup by transaction id)", async () => {
    const db = createTestDb();
    await importJanuary(db);
    const res: any = await importJanuary(db);
    expect(res.accountsAdded).toBe(0);
    expect(res.postingsAdded).toBe(0);
    expect(res.postingsSkipped).toBe(4);
    expect(res.existingPostingsPreserved).toBe(4);
    expect(res.dataCoverageStart).toBe("2026-01-01");

    const postings = await db.select().from(schema.postings);
    expect(postings).toHaveLength(4);
  });

  test("a later incremental import merges new postings and never moves coverage forward", async () => {
    const db = createTestDb();
    await importJanuary(db);
    const res: any = await Actions.importSnapshot.handler(fakeCtx(db), {
      windowStart: "2026-02-01",
      windowEnd: "2026-02-28",
      complete: true,
      accounts: [],
      postings: [
        {
          txnId: "fake-txn-flight-2",
          accountPlaidId: ALEX_ASPIRE.plaidAccountId,
          date: "2026-02-10",
          name: "AMEX Flight Credit",
          amount: 50,
        },
      ],
    });
    expect(res.postingsAdded).toBe(1);
    expect(res.existingPostingsPreserved).toBe(4);
    expect(res.dataCoverageStart).toBe("2026-01-01");
  });

  test("an incomplete import merges its postings but certifies NO coverage and does not mark lastImportAt", async () => {
    const db = createTestDb();
    await importJanuary(db);
    const before: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    expect(before.lastImportAt).not.toBeNull();

    const res: any = await Actions.importSnapshot.handler(fakeCtx(db), {
      windowStart: "2025-07-01",
      windowEnd: "2025-07-31",
      complete: false, // truncated read: merges, but must not certify the window
      accounts: [],
      postings: [
        {
          txnId: "fake-txn-old-1",
          accountPlaidId: ALEX_ASPIRE.plaidAccountId,
          date: "2025-07-04",
          name: "AMEX Flight Credit",
          amount: 50,
        },
      ],
    });
    expect(res.postingsAdded).toBe(1);
    // Coverage stays at the certified Jan 1 even though the merged posting is older.
    expect(res.dataCoverageStart).toBe("2026-01-01");

    const after: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    expect(after.lastImportAt).toBe(before.lastImportAt);
    expect(after.dataCoverageStart).toBe("2026-01-01");
  });

  test("a complete import over an earlier window extends coverage backwards", async () => {
    const db = createTestDb();
    await importJanuary(db);
    const res: any = await Actions.importSnapshot.handler(fakeCtx(db), {
      windowStart: "2025-01-01",
      windowEnd: "2025-12-31",
      complete: true,
      accounts: [],
      postings: [],
    });
    expect(res.dataCoverageStart).toBe("2025-01-01");
  });

  test("postings for unknown accounts are skipped, not stored", async () => {
    const db = createTestDb();
    const res: any = await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [],
      postings: [
        {
          txnId: "fake-txn-ghost",
          accountPlaidId: "fake-no-such-account",
          date: "2026-01-05",
          name: "AMEX Flight Credit",
          amount: 50,
        },
      ],
    });
    expect(res.postingsAdded).toBe(0);
    expect(res.postingsSkipped).toBe(1);
  });
});

describe("importSnapshot — duplicate account records are the user's decision", () => {
  // SEMANTICS CHANGED (fix package): import used to GUESS duplicates
  // (same name + balance + limit) and start the second record ignored.
  // That guess is gone: import NEVER auto-ignores. Lookalike records
  // are flagged `suspectedDuplicate` on the dashboard instead, stay
  // active and counted, and the user resolves them via setAccountIgnored.
  const aspire = (plaidAccountId: string, extra: Record<string, unknown> = {}) => ({
    plaidAccountId,
    name: "Hilton Honors Aspire Card",
    mask: "1111",
    balance: 300,
    creditLimit: 5000,
    owner: "A",
    ...extra,
  });

  async function importOne(db: ReturnType<typeof createTestDb>, account: unknown) {
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [account],
      postings: [],
    } as any);
    const rows = await db.select().from(schema.accounts);
    return rows.find((r) => r.plaidAccountId === (account as any).plaidAccountId)!;
  }

  test("a second record with the same name + balance + limit is NOT ignored — it is suspected on the dashboard", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    const first = await importOne(db, aspire("fake-dup-1"));
    const second = await importOne(db, aspire("fake-dup-2"));
    expect(first.ignored).toBe(0);
    expect(second.ignored).toBe(0); // never auto-ignored anymore

    const dash: any = await Actions.getDashboard.handler(ctx, {});
    const a1 = dash.accounts.find((a: any) => a.id === first.id);
    const a2 = dash.accounts.find((a: any) => a.id === second.id);
    // Same product + mask → both records are flagged as suspecting each
    // other, and both stay counted until the user decides.
    expect(a1.suspectedDuplicate).toBe(true);
    expect(a2.suspectedDuplicate).toBe(true);
    expect(a1.duplicateSuspectIds).toEqual([second.id]);
    expect(a2.duplicateSuspectIds).toEqual([first.id]);
    expect(dash.credits.filter((c: any) => c.name === "Flight Credit")).toHaveLength(2);
  });

  test("duplicates arriving in the SAME snapshot are not ignored either", async () => {
    const db = createTestDb();
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [aspire("fake-dup-a"), aspire("fake-dup-b")],
      postings: [],
    } as any);
    const rows = await db.select().from(schema.accounts).orderBy(asc(schema.accounts.id));
    expect(rows.map((r) => r.ignored)).toEqual([0, 0]);
  });

  test("balance and limit play no part: different balances are still only suspected, never ignored", async () => {
    const db = createTestDb();
    await importOne(db, aspire("fake-dup-1"));
    const diffBalance = await importOne(db, aspire("fake-dup-3", { balance: 301 }));
    expect(diffBalance.ignored).toBe(0);
    const diffLimit = await importOne(db, aspire("fake-dup-4", { creditLimit: 6000 }));
    expect(diffLimit.ignored).toBe(0);
  });

  test("a different mask is not suspected (two people can hold the same product)", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    await importOne(db, aspire("fake-mask-1"));
    await importOne(db, aspire("fake-mask-2", { mask: "2222" }));
    const dash: any = await Actions.getDashboard.handler(ctx, {});
    expect(dash.accounts.every((a: any) => a.suspectedDuplicate === false)).toBe(true);
  });

  test("a zero-balance twin is suspected by product + mask, still never ignored", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    await importOne(db, aspire("fake-zero-1", { balance: 0 }));
    const twin = await importOne(db, aspire("fake-zero-2", { balance: 0 }));
    expect(twin.ignored).toBe(0);
    const dash: any = await Actions.getDashboard.handler(ctx, {});
    expect(
      dash.accounts.find((a: any) => a.id === twin.id).suspectedDuplicate,
    ).toBe(true);
  });

  test("transaction evidence: the same txn id arriving under two records flags both as suspected", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    // The primary record under one login, then a supplementary view of
    // it under another login (different mask): the second snapshot
    // re-delivers a transaction id that is already stored under the
    // primary. That cross-account sighting is the transaction-subset
    // signature — one record's transactions are a subset of the
    // other's — and import records it as evidence (txn ids are globally
    // unique in the store, so the relation can only be observed here,
    // at import time, never recomputed from stored postings).
    await Actions.importSnapshot.handler(ctx, {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [aspire("fake-sub-primary")],
      postings: [
        { txnId: "fake-sub-t1", accountPlaidId: "fake-sub-primary", date: "2026-01-05", name: "AMEX Flight Credit", amount: 50 },
        { txnId: "fake-sub-t2", accountPlaidId: "fake-sub-primary", date: "2026-01-06", name: "AMEX Flight Credit", amount: 50 },
      ],
    } as any);
    await Actions.importSnapshot.handler(ctx, {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [aspire("fake-sub-au", { mask: "9999", owner: "B" })],
      postings: [
        { txnId: "fake-sub-t1", accountPlaidId: "fake-sub-au", date: "2026-01-05", name: "AMEX Flight Credit", amount: 50 },
      ],
    } as any);

    const evidence = await db.select().from(schema.accountDuplicateEvidence);
    expect(evidence).toHaveLength(1);
    const dash: any = await Actions.getDashboard.handler(ctx, {});
    const primary = dash.accounts.find((a: any) => a.mask === "1111");
    const au = dash.accounts.find((a: any) => a.mask === "9999");
    expect(primary.suspectedDuplicate).toBe(true);
    expect(au.suspectedDuplicate).toBe(true);
    expect(primary.duplicateSuspectIds).toEqual([au.id]);
    expect(au.duplicateSuspectIds).toEqual([primary.id]);
    // The evidence changes nothing by itself: both stay active/counted.
    expect(dash.accounts.every((a: any) => !a.ignored)).toBe(true);
  });

  test("an explicit ignored flag in the payload is honored (a curated user decision)", async () => {
    const db = createTestDb();
    const row = await importOne(db, aspire("fake-explicit-1", { balance: 999, ignored: true }));
    expect(row.ignored).toBe(1);
  });

  test("an account the user marked ignored is never un-ignored or flagged by later imports", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    const first = await importOne(db, aspire("fake-keep-1"));
    const second = await importOne(db, aspire("fake-keep-2"));
    await Actions.setAccountIgnored.handler(ctx, { accountId: second.id, ignored: true });
    // A later import of the same record must not resurrect it — not
    // even when the payload explicitly carries ignored: false (imports
    // may record an ignore, never lift one).
    await importOne(db, aspire("fake-keep-2", { ignored: false }));
    const rows = await db.select().from(schema.accounts);
    expect(rows.find((r) => r.id === second.id)!.ignored).toBe(1);
    // And with the pair resolved, the survivor is no longer suspected.
    const dash: any = await Actions.getDashboard.handler(ctx, {});
    expect(
      dash.accounts.find((a: any) => a.id === first.id).suspectedDuplicate,
    ).toBe(false);
  });
});

describe("importSnapshot — owner attribution is sticky", () => {
  const acct = (owner?: string) => ({
    plaidAccountId: "fake-sticky-1",
    name: "Hilton Honors Aspire Card",
    mask: "1111",
    balance: 10,
    creditLimit: 5000,
    ...(owner !== undefined ? { owner } : {}),
  });

  async function importAcct(db: ReturnType<typeof createTestDb>, account: unknown) {
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [account],
      postings: [],
    } as any);
    return (await db.select().from(schema.accounts))[0]!;
  }

  test("a later import never overwrites an existing owner", async () => {
    const db = createTestDb();
    await importAcct(db, acct("A"));
    // The refresh re-derives attribution differently (or wrongly): the
    // stored person must NOT flip.
    const after = await importAcct(db, acct("B"));
    expect(after.owner).toBe("A");
  });

  test("an import fills the owner only when the account has none yet", async () => {
    const db = createTestDb();
    const unset = await importAcct(db, acct());
    expect(unset.owner).toBeNull();
    const filled = await importAcct(db, acct("B"));
    expect(filled.owner).toBe("B");
  });
});

describe("importSnapshot — signed amounts (clawbacks) and strict dates", () => {
  // The two clawback cases below are the owner's REAL posting records
  // (Morgan Stanley Platinum), used at the owner's direction as the
  // clawback fixtures: real posting names, amounts, and date sequences
  // on a fictional account identity (SAM_MS_PLATINUM). Plaid's sign
  // convention is negative = credit received, positive = debit; the
  // amounts passed to importSnapshot are the Plaid-negated values the
  // refresh produces (positive = credit received, negative = clawback).
  test("Case A: credit → clawback → same-day re-credit nets to exactly the original $300", async () => {
    // Real records, Oct 2026:
    //   posted 2026-10-11 (auth 2026-10-10)  "Platinum Hotel Credit"  −300.00 Plaid (credit received)
    //   posted 2026-10-12 (auth 2026-10-11)  "Platinum Hotel Credit"  +213.98 Plaid (CLAWBACK)
    //   posted 2026-10-12 (auth 2026-10-11)  "Platinum Hotel Credit"  −213.98 Plaid (re-issued)
    // Net usage for the semiannual period is $300.00. The pre-fix
    // ledger filtered the clawback debit out and counted 300 + 213.98
    // = $513.98 of usage — the bug the signed-posting model fixes.
    // The sequence is transposed into the current semiannual period
    // (repo convention for dashboard-level tests), preserving the
    // names, amounts, signs, day offsets, and auth = posted − 1 day.
    const db = createTestDb();
    const ctx = fakeCtx(db);
    const today = todayLA();
    const half = periodBounds("semiannual", today);
    const postedCredit = addDays(half.start, 10);
    const postedPair = addDays(half.start, 11);
    await Actions.importSnapshot.handler(ctx, {
      complete: true,
      windowStart: half.start,
      windowEnd: today,
      accounts: [SAM_MS_PLATINUM],
      postings: [
        { txnId: "fake-clawA-credit", accountPlaidId: SAM_MS_PLATINUM.plaidAccountId, date: postedCredit, transactionDate: addDays(postedCredit, -1), name: "Platinum Hotel Credit", amount: 300 },
        { txnId: "fake-clawA-clawback", accountPlaidId: SAM_MS_PLATINUM.plaidAccountId, date: postedPair, transactionDate: addDays(postedPair, -1), name: "Platinum Hotel Credit", amount: -213.98 },
        { txnId: "fake-clawA-recredit", accountPlaidId: SAM_MS_PLATINUM.plaidAccountId, date: postedPair, transactionDate: addDays(postedPair, -1), name: "Platinum Hotel Credit", amount: 213.98 },
      ],
    } as any);
    const stored = await db.select().from(schema.postings);
    expect(stored.map((p) => p.amount).sort()).toEqual([-213.98, 213.98, 300]);
    // All three matched the same seeded Hotel Credit row by name.
    expect(stored.every((p) => p.creditId != null)).toBe(true);
    expect(new Set(stored.map((p) => p.creditId)).size).toBe(1);

    const dash: any = await Actions.getDashboard.handler(ctx, {});
    const hotel = dash.credits.find((c: any) => c.name === "Hotel Credit (FHR / Hotel Collection)");
    expect(hotel.currentPostings).toHaveLength(3);
    // Exactly $300.00 of net usage — not the $513.98 the old
    // positive-only filter produced.
    expect(Math.round(hotel.currentUsed * 100)).toBe(30000);
    expect(hotel.currentRemaining).toBe(0);
  });

  test("Case B: a partial clawback at an adjusted amount nets to $1.11 of usage", async () => {
    // Real records, Jan 2025 — the old $200 semiannual FHR era:
    //   posted 2025-01-15 (auth 2025-01-12)  "Platinum Hotel Credit"  −200.00 Plaid (credit received)
    //   posted 2025-01-27 (auth 2025-01-26)  "Platinum Hotel Credit"  +198.89 Plaid (clawback, adjusted — not the full $200)
    // Jan 2025 is never the dashboard's current period, so this case is
    // pinned at the ledger level: both postings stored signed and
    // matched to the same credit, and their signed sum over the
    // H1 2025 semiannual window (by transaction date) is $1.11.
    const db = createTestDb();
    const ctx = fakeCtx(db);
    await Actions.importSnapshot.handler(ctx, {
      complete: false,
      windowStart: "2025-01-01",
      windowEnd: "2025-01-31",
      accounts: [SAM_MS_PLATINUM],
      postings: [
        { txnId: "fake-clawB-credit", accountPlaidId: SAM_MS_PLATINUM.plaidAccountId, date: "2025-01-15", transactionDate: "2025-01-12", name: "Platinum Hotel Credit", amount: 200 },
        { txnId: "fake-clawB-clawback", accountPlaidId: SAM_MS_PLATINUM.plaidAccountId, date: "2025-01-27", transactionDate: "2025-01-26", name: "Platinum Hotel Credit", amount: -198.89 },
      ],
    } as any);
    const stored = await db.select().from(schema.postings);
    expect(stored.map((p) => p.amount).sort()).toEqual([-198.89, 200]);
    expect(stored.every((p) => p.creditId != null)).toBe(true);
    expect(stored[0]!.creditId).toBe(stored[1]!.creditId);

    const win = periodBounds("semiannual", "2025-01-15");
    expect(win.start).toBe("2025-01-01");
    expect(win.end).toBe("2025-06-30");
    const net = stored
      .filter((p) => {
        const eff = p.transactionDate ?? p.date;
        return eff >= win.start && eff <= win.end;
      })
      .reduce((s, p) => s + p.amount, 0);
    expect(Math.round(net * 100)).toBe(111);
  });

  test("impossible calendar dates are rejected, not rolled over", async () => {
    const db = createTestDb();
    await expect(
      Actions.importSnapshot.handler(fakeCtx(db), {
        complete: true,
        windowStart: "2026-01-01",
        windowEnd: "2026-01-31",
        accounts: [ALEX_ASPIRE],
        postings: [
          { txnId: "fake-bad-date", accountPlaidId: ALEX_ASPIRE.plaidAccountId, date: "2026-13-40", name: "AMEX Flight Credit", amount: 50 },
        ],
      } as any),
    ).rejects.toThrow();
    await expect(
      Actions.importSnapshot.handler(fakeCtx(db), {
        complete: true,
        windowStart: "2026-02-30",
        windowEnd: "2026-03-01",
        accounts: [],
        postings: [],
      } as any),
    ).rejects.toThrow();
    expect(await db.select().from(schema.postings)).toHaveLength(0);
  });

  test("the account's Plaid currency is stored on insert", async () => {
    const db = createTestDb();
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [{ ...ALEX_ASPIRE, currency: "USD" }],
      postings: [],
    } as any);
    const rows = await db.select().from(schema.accounts);
    expect(rows[0]!.currency).toBe("USD");
  });
});

describe("importSnapshot — seeded defaults are truthful, never assumed", () => {
  test("enrollment-required credits seed UNCONFIRMED (never asserted either way)", async () => {
    const db = createTestDb();
    await Actions.importSnapshot.handler(fakeCtx(db), JANUARY_SNAPSHOT as any);
    const credits = await db.select().from(schema.credits);
    // Business Platinum's Hilton Credit requires Hilton for Business
    // enrollment. The app cannot observe that state: the seed must be
    // UNCONFIRMED (enrolledAsserted 0) so nothing downstream can render
    // it as "not enrolled" — nor as enrolled.
    const hilton = credits.find((c) => c.name === "Hilton Credit")!;
    expect(hilton.enrolled).toBe(0);
    expect(hilton.enrolledAsserted).toBe(0);
    // Airline Fee Credit is also enrollment-gated (airline selection).
    const airline = credits.find((c) => c.name === "Airline Fee Credit")!;
    expect(airline.enrolled).toBe(0);
    expect(airline.enrolledAsserted).toBe(0);
    // Automatic credits keep the historical default value (their
    // enrolled state is meaningless and likewise unasserted).
    const flight = credits.find((c) => c.name === "Flight Credit")!;
    expect(flight.enrolled).toBe(1);
    expect(flight.enrolledAsserted).toBe(0);
    // The dashboard DTO exposes the unconfirmed state as null.
    const dash: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    const hiltonDto = dash.credits.find((c: any) => c.name === "Hilton Credit");
    expect(hiltonDto.enrolled).toBeNull();
  });

  test("a catalog-default anchor seeds UNCONFIRMED; anchorless credits seed confirmed", async () => {
    const db = createTestDb();
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: "2026-01-01",
      windowEnd: "2026-01-31",
      accounts: [ALEX_SAPPHIRE],
      postings: [],
    } as any);
    await Actions.importSnapshot.handler(fakeCtx(db), JANUARY_SNAPSHOT as any);
    const credits = await db.select().from(schema.credits);
    // The Sapphire Preferred hotel credit carries the placeholder May 1 anchor.
    const hotel = credits.find((c) => c.name === "Annual Hotel Credit")!;
    expect(hotel.anchorMonth).toBe(5);
    expect(hotel.anchorConfirmed).toBe(0);
    // The Aspire Resort Credit carries NO anchor (Amex runs it on
    // calendar halves), so it seeds confirmed like the other
    // anchorless credits.
    const resort = credits.find((c) => c.name === "Hilton Resort Credit")!;
    expect(resort.anchorMonth).toBeNull();
    expect(resort.anchorConfirmed).toBe(1);
    const flight = credits.find((c) => c.name === "Flight Credit")!;
    expect(flight.anchorMonth).toBeNull();
    expect(flight.anchorConfirmed).toBe(1);
  });
});

describe("match pattern inheritance — addCredit default and import self-heal", () => {
  async function seedIhg(db: ReturnType<typeof createTestDb>) {
    const today = todayLA();
    await Actions.importSnapshot.handler(fakeCtx(db), {
      complete: true,
      windowStart: periodBounds("annual", today).start,
      windowEnd: today,
      accounts: [ALEX_IHG_PREMIER],
      postings: [],
    } as any);
    const account = (await db.select().from(schema.accounts))[0]!;
    return { account, today };
  }

  test("addCredit without a matchPattern inherits the catalog pattern; an explicit one is kept", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    const { account } = await seedIhg(db);
    const seeded = (
      await db.select().from(schema.credits).where(eq(schema.credits.accountId, account.id))
    )[0]!;
    expect(seeded.name).toBe("Airline Credit");
    expect(seeded.matchPattern).toBe("airline credit");

    // Delete the seeded row, then re-add it by hand WITHOUT a
    // matchPattern (the old manual flow that produced patternless
    // rows): the tombstone revive must carry the catalog pattern,
    // not the old empty default.
    await Actions.deleteCredit.handler(ctx, { id: seeded.id });
    const revived: any = await Actions.addCredit.handler(ctx, {
      accountId: account.id,
      name: "Airline Credit",
      amount: 100,
      period: "annual",
      note: "",
    });
    expect(revived.id).toBe(seeded.id);
    const byId = new Map(
      (await db.select().from(schema.credits)).map((c) => [c.id, c]),
    );
    expect(byId.get(revived.id)!.matchPattern).toBe("airline credit");

    // An explicitly passed pattern is the caller's choice and is never
    // overridden, and a name with no catalog def inherits nothing.
    const custom: any = await Actions.addCredit.handler(ctx, {
      accountId: account.id,
      name: "Made-Up Credit",
      amount: 10,
      period: "annual",
      note: "",
      matchPattern: "custom",
    });
    const plain: any = await Actions.addCredit.handler(ctx, {
      accountId: account.id,
      name: "Another Made-Up Credit",
      amount: 10,
      period: "annual",
      note: "",
    });
    const after = new Map(
      (await db.select().from(schema.credits)).map((c) => [c.id, c]),
    );
    expect(after.get(custom.id)!.matchPattern).toBe("custom");
    expect(after.get(plain.id)!.matchPattern).toBe("");
  });

  test("importSnapshot heals an existing patternless row and the posting then auto-matches", async () => {
    const db = createTestDb();
    const ctx = fakeCtx(db);
    const { account, today } = await seedIhg(db);

    // Simulate the legacy broken state: the stored Airline Credit row
    // with its match pattern blanked, so nothing can auto-match it.
    await db
      .update(schema.credits)
      .set({ matchPattern: "" })
      .where(eq(schema.credits.accountId, account.id));
    // A user pattern on the same account must survive the heal.
    const custom: any = await Actions.addCredit.handler(ctx, {
      accountId: account.id,
      name: "Made-Up Credit",
      amount: 10,
      period: "annual",
      note: "",
      matchPattern: "custom",
    });

    const res: any = await Actions.importSnapshot.handler(ctx, {
      complete: true,
      windowStart: periodBounds("annual", today).start,
      windowEnd: today,
      accounts: [ALEX_IHG_PREMIER],
      postings: [
        {
          txnId: "fake-txn-ihg-airline-credit",
          accountPlaidId: ALEX_IHG_PREMIER.plaidAccountId,
          date: today,
          name: "AIRLINE CREDIT",
          amount: 100,
        },
      ],
    } as any);
    expect(res.patternsHealed).toBe(1);

    const credits = await db.select().from(schema.credits);
    const airline = credits.find((c) => c.name === "Airline Credit")!;
    expect(airline.matchPattern).toBe("airline credit");
    expect(credits.find((c) => c.id === custom.id)!.matchPattern).toBe("custom");

    // The heal took effect in the same import: the posting is
    // auto-classified onto the healed credit, not left unassigned.
    const posting = (await db.select().from(schema.postings))[0]!;
    expect(posting.creditId).toBe(airline.id);
  });
});
