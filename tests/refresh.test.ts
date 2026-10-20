import { describe, expect, test } from "bun:test";
import { addDays, Actions, periodBounds, resolveRefreshWindow } from "../server/src/actions";
import * as schema from "../server/src/schema";
import { createTestDb, fakeCtx, todayLA } from "./helpers";
import { ALEX_SAPPHIRE } from "./fixtures/sample";

/**
 * refreshCredits previously had zero test coverage. These tests pin:
 *  - the fetch FLOOR: Jan 1, or the earliest current-period start among
 *    held anchored credits when that is earlier (an anniversary-year
 *    credit whose period began last year must have its postings
 *    fetched — a Jan-1 floor overstated its remaining forever);
 *  - bootstrap until stored coverage reaches the floor;
 *  - gap-fill clamped at the floor;
 *  - the spawned agent prompt: owner attribution by PERSON (never by
 *    grouping position, omitted when ambiguous), signed amounts with
 *    clawbacks kept, and the account currency collected.
 */

describe("resolveRefreshWindow — the fetch floor follows anchored periods", () => {
  const base = {
    today: "2026-02-10",
    hasAccounts: true,
    hasPostings: true,
    lastImportDate: "2026-02-09",
    coverageStart: "2026-01-01",
    anchoredPeriodStarts: [] as string[],
  };

  test("no anchored credits: floor is Jan 1 and a covered store refreshes incrementally", () => {
    const w = resolveRefreshWindow(base);
    expect(w.floorStart).toBe("2026-01-01");
    expect(w.mode).toBe("incremental-30d");
    expect(w.windowStart).toBe("2026-01-12"); // today - 29 days
  });

  test("an anchored period that began last year pulls the floor back — and forces bootstrap until coverage reaches it", () => {
    const w = resolveRefreshWindow({ ...base, anchoredPeriodStarts: ["2025-05-01"] });
    expect(w.floorStart).toBe("2025-05-01");
    // Coverage only reaches 2026-01-01 — short of the floor — so this
    // run bootstraps from the floor instead of refreshing 30 days.
    expect(w.mode).toBe("bootstrap-full-coverage");
    expect(w.windowStart).toBe("2025-05-01");
  });

  test("once coverage reaches the anchored floor, refreshes go back to incremental", () => {
    const w = resolveRefreshWindow({
      ...base,
      coverageStart: "2025-05-01",
      anchoredPeriodStarts: ["2025-05-01"],
    });
    expect(w.mode).toBe("incremental-30d");
    expect(w.windowStart).toBe("2026-01-12");
  });

  test("gap-fill backfills from just before the last import", () => {
    const w = resolveRefreshWindow({
      ...base,
      coverageStart: "2025-05-01",
      anchoredPeriodStarts: ["2025-05-01"],
      lastImportDate: "2025-12-01",
    });
    expect(w.mode).toBe("gap-fill");
    expect(w.windowStart).toBe("2025-11-29");
  });

  test("gap-fill is clamped at the floor, never above it", () => {
    const w = resolveRefreshWindow({
      ...base,
      coverageStart: "2025-05-01",
      anchoredPeriodStarts: ["2025-05-01"],
      lastImportDate: "2025-05-02",
    });
    expect(w.mode).toBe("gap-fill");
    expect(w.windowStart).toBe("2025-05-01"); // lastImport - 2d would be 2025-04-30
  });

  test("an empty store bootstraps from the floor", () => {
    const w = resolveRefreshWindow({
      ...base,
      hasAccounts: false,
      hasPostings: false,
      lastImportDate: null,
      coverageStart: null,
    });
    expect(w.mode).toBe("bootstrap-full-coverage");
    expect(w.windowStart).toBe("2026-01-01");
  });
});

/** A ctx whose agent captures the spawned refresh prompt instead of running it. */
function capturingCtx(db: ReturnType<typeof createTestDb>) {
  const ctx = fakeCtx(db);
  const captured: { message: string; opts: unknown } = { message: "", opts: null };
  ctx.agent = {
    spawnTask: async (message: string, opts: unknown) => {
      captured.message = message;
      captured.opts = opts;
      return { ok: true, taskId: "fake-refresh-task" };
    },
    status: async () => ({ status: "none" }),
  };
  return { ctx, captured };
}

describe("refreshCredits — the spawned task", () => {
  test("a fresh store bootstraps from Jan 1 and the prompt carries the new rules", async () => {
    const db = createTestDb();
    const { ctx, captured } = capturingCtx(db);
    const res: any = await Actions.refreshCredits.handler(ctx, {});
    expect(res.started).toBe(true);

    const today = todayLA();
    const yearStart = `${today.slice(0, 4)}-01-01`;
    expect(captured.message).toContain(
      `--start-date ${yearStart} --end-date ${today}`,
    );
    // Owner attribution is by PERSON, across logins, omitted when unsure.
    expect(captured.message).toContain("owners are PEOPLE, not logins");
    expect(captured.message).toContain("OMIT owner");
    expect(captured.message).toContain("Never guess an owner from a grouping's position");
    // Signed amounts: clawbacks arrive as negative postings.
    expect(captured.message).toContain("clawback");
    // The keep filter must also admit payout names with no 'credit' in
    // them — Amex pays the Platinum airline fee credit as
    // 'AMEX Airline Fee Reimbursement', which a 'credit'-only filter
    // silently drops before import.
    expect(captured.message).toContain("'credit' or 'reimbursement'");
    expect(captured.message).toContain("NEGATIVE dollars");
    // Currency is collected from Plaid.
    expect(captured.message).toContain("iso_currency_code");
    // Institution-neutral copy.
    expect(captured.message).not.toContain("Amex Credits Dashboard");
    expect((captured.opts as any).dedupeKey).toBe("plaid-credits-refresh");

    const meta = await db.select().from(schema.meta);
    expect(meta.find((r) => r.key === "lastRefreshMode")?.value).toBe(
      "bootstrap-full-coverage",
    );
    expect(meta.find((r) => r.key === "lastRefreshWindowStart")?.value).toBe(yearStart);
  });

  test("a covered store with an anchored (Sapphire) credit refreshes incrementally over 30 days", async () => {
    const db = createTestDb();
    const setupCtx = fakeCtx(db);
    const today = todayLA();
    // Import the Sapphire account with coverage certified back to the
    // FLOOR — Jan 1, or the current anniversary-period start when that
    // is earlier (Jan–Apr for a May anchor) — so no bootstrap is owed.
    const anchorStart = periodBounds("annual", today, { month: 5, day: 1 }).start;
    const floor = [anchorStart, `${today.slice(0, 4)}-01-01`].sort()[0]!;
    await Actions.importSnapshot.handler(setupCtx, {
      complete: true,
      windowStart: floor,
      windowEnd: today,
      importedAt: new Date().toISOString(),
      accounts: [ALEX_SAPPHIRE],
      postings: [
        {
          txnId: "fake-refresh-hotel",
          accountPlaidId: ALEX_SAPPHIRE.plaidAccountId,
          date: anchorStart,
          name: "Chase Travel Hotel Credit",
          amount: 50,
        },
      ],
    } as any);

    const { ctx, captured } = capturingCtx(db);
    const res: any = await Actions.refreshCredits.handler(ctx, {});
    expect(res.started).toBe(true);
    expect(captured.message).toContain(
      `--start-date ${addDays(today, -29)} --end-date ${today}`,
    );
    const meta = await db.select().from(schema.meta);
    expect(meta.find((r) => r.key === "lastRefreshMode")?.value).toBe("incremental-30d");
  });

  test("coverage that stops at Jan 1 while an anchored period began earlier triggers a floor bootstrap", async () => {
    const db = createTestDb();
    const setupCtx = fakeCtx(db);
    const today = todayLA();
    const anchorStart = periodBounds("annual", today, { month: 5, day: 1 }).start;
    // Only meaningful when the anchored period actually began before
    // Jan 1 (Jan–Apr for a May anchor); skip otherwise.
    if (anchorStart >= `${today.slice(0, 4)}-01-01`) return;
    // Certify coverage only back to Jan 1 — short of the floor.
    await Actions.importSnapshot.handler(setupCtx, {
      complete: true,
      windowStart: `${today.slice(0, 4)}-01-01`,
      windowEnd: today,
      importedAt: new Date().toISOString(),
      accounts: [ALEX_SAPPHIRE],
      postings: [
        {
          txnId: "fake-refresh-hotel-2",
          accountPlaidId: ALEX_SAPPHIRE.plaidAccountId,
          date: today,
          name: "Chase Travel Hotel Credit",
          amount: 50,
        },
      ],
    } as any);

    const { ctx, captured } = capturingCtx(db);
    await Actions.refreshCredits.handler(ctx, {});
    expect(captured.message).toContain(`--start-date ${anchorStart} --end-date ${today}`);
    const meta = await db.select().from(schema.meta);
    expect(meta.find((r) => r.key === "lastRefreshMode")?.value).toBe(
      "bootstrap-full-coverage",
    );
  });
});
