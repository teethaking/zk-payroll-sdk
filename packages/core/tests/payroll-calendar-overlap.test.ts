import {
  detectPayrollCalendarOverlaps,
  assertNoPayrollCalendarOverlap,
  isPayrollPeriodOverlapping,
  findOverlappingPeriods,
  filterNonOverlappingPeriods,
  normalizeCalendarPeriod,
  scheduleToCalendarPeriod,
  redactPeriodId,
  redactScopeId,
  PayrollCalendarOverlapError,
  type PayrollCalendarPeriodInput,
} from "../src/payroll/calendarOverlap";
import { normalizePayrollSchedule } from "../src/schedules/scheduleNormalizer";

describe("Payroll Calendar Overlap Detection", () => {
  // Helper to create valid sample periods
  const createPeriod = (
    periodId: string,
    startDate: string | number | Date,
    endDate: string | number | Date,
    overrides: Partial<PayrollCalendarPeriodInput> = {}
  ): PayrollCalendarPeriodInput => ({
    periodId,
    startDate,
    endDate,
    ...overrides,
  });

  describe("detectPayrollCalendarOverlaps - Success Cases", () => {
    it("returns valid report for empty period list", () => {
      const report = detectPayrollCalendarOverlaps([]);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(report.summary.totalPeriods).toBe(0);
      expect(report.summary.hasOverlaps).toBe(false);
    });

    it("returns valid report for a single valid period", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
      ];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(report.summary.validCount).toBe(1);
      expect(report.normalizedPeriods).toHaveLength(1);
      expect(report.normalizedPeriods[0].periodId).toBe("2026-01");
    });

    it("validates multiple chronological non-overlapping periods", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
        createPeriod("2026-02", "2026-02-01T00:00:00.000Z", "2026-02-28T23:59:59.999Z"),
        createPeriod("2026-03", "2026-03-01T00:00:00.000Z", "2026-03-31T23:59:59.999Z"),
      ];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(report.summary.overlapCount).toBe(0);
      expect(report.summary.validCount).toBe(3);
    });

    it("permits contiguous/adjacent period boundaries by default", () => {
      // Period 1 ends exactly when Period 2 starts
      const t1 = Date.parse("2026-01-01T00:00:00.000Z");
      const t2 = Date.parse("2026-01-15T00:00:00.000Z");
      const t3 = Date.parse("2026-02-01T00:00:00.000Z");

      const periods = [createPeriod("2026-01A", t1, t2), createPeriod("2026-01B", t2, t3)];

      const report = detectPayrollCalendarOverlaps(periods, { allowAdjacentBoundaries: true });
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("supports Date objects and epoch millisecond numbers seamlessly", () => {
      const start = new Date("2026-04-01T00:00:00.000Z");
      const end = new Date("2026-04-30T23:59:59.999Z");
      const periods = [
        createPeriod("2026-04", start, end),
        createPeriod("2026-05", end.getTime() + 1000, end.getTime() + 86400000),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(true);
      expect(report.summary.validCount).toBe(2);
    });

    it("ignores overlapping periods with cancelled status by default", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z", {
          status: "settled",
        }),
        createPeriod("2026-01-dup", "2026-01-10T00:00:00.000Z", "2026-01-20T00:00:00.000Z", {
          status: "cancelled",
        }),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("allows overlapping periods across different scopes when groupByScope is true", () => {
      const periods = [
        createPeriod("2026-01-US", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z", {
          scopeId: "org-us",
        }),
        createPeriod("2026-01-EU", "2026-01-15T00:00:00.000Z", "2026-02-15T23:59:59.999Z", {
          scopeId: "org-eu",
        }),
      ];

      const report = detectPayrollCalendarOverlaps(periods, { groupByScope: true });
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("allows zero duration period when allowZeroDuration is enabled", () => {
      const timestamp = "2026-06-01T00:00:00.000Z";
      const periods = [createPeriod("2026-instant", timestamp, timestamp)];

      const report = detectPayrollCalendarOverlaps(periods, { allowZeroDuration: true });
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });
  });

  describe("detectPayrollCalendarOverlaps - Overlap Detection", () => {
    it("detects partial overlap between consecutive periods", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
        createPeriod("2026-02", "2026-01-15T00:00:00.000Z", "2026-02-05T00:00:00.000Z"),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);

      const violation = report.violations[0];
      expect(violation.code).toBe("OVERLAPPING_PERIOD");
      expect(violation.periodId).toBe("2026-01");
      expect(violation.conflictingPeriodId).toBe("2026-02");
      expect(violation.overlapDurationMs).toBe(5 * 24 * 60 * 60 * 1000); // 5 days
      expect(violation.suggestedFix).toContain("boundaries");
    });

    it("detects completely contained period (one period inside another)", () => {
      const periods = [
        createPeriod("2026-Q1", "2026-01-01T00:00:00.000Z", "2026-03-31T23:59:59.999Z"),
        createPeriod("2026-FEB", "2026-02-01T00:00:00.000Z", "2026-02-28T23:59:59.999Z"),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);

      const violation = report.violations[0];
      expect(violation.code).toBe("CONTAINED_PERIOD");
      expect(violation.message).toContain("contained within");
    });

    it("detects identical period range collision", () => {
      const start = "2026-07-01T00:00:00.000Z";
      const end = "2026-07-31T23:59:59.999Z";
      const periods = [
        createPeriod("2026-07-A", start, end),
        createPeriod("2026-07-B", start, end),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);

      const violation = report.violations[0];
      expect(violation.code).toBe("IDENTICAL_PERIOD_RANGE");
      expect(violation.message).toContain("identical date interval");
    });

    it("flags touching boundaries as overlap when allowAdjacentBoundaries is false", () => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-01-15T00:00:00.000Z";
      const t3 = "2026-02-01T00:00:00.000Z";

      const periods = [createPeriod("2026-A", t1, t2), createPeriod("2026-B", t2, t3)];

      const report = detectPayrollCalendarOverlaps(periods, {
        allowAdjacentBoundaries: false,
      });
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].code).toBe("OVERLAPPING_PERIOD");
    });

    it("detects multiple overlaps in complex calendars", () => {
      const periods = [
        createPeriod("P1", "2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
        createPeriod("P2", "2026-01-10T00:00:00.000Z", "2026-01-25T00:00:00.000Z"),
        createPeriod("P3", "2026-01-18T00:00:00.000Z", "2026-02-05T00:00:00.000Z"),
      ];

      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      // P1 overlaps P2, P1 overlaps P3, P2 overlaps P3
      expect(report.summary.overlapCount).toBe(3);
    });
  });

  describe("detectPayrollCalendarOverlaps - Input Validation & Errors", () => {
    it("flags missing or empty period identifier", () => {
      const periods = [createPeriod("", "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations[0].code).toBe("INVALID_PERIOD_ID");
    });

    it("flags duplicate period identifiers", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-15T00:00:00.000Z"),
        createPeriod("2026-01", "2026-02-01T00:00:00.000Z", "2026-02-15T00:00:00.000Z"),
      ];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations.some((v) => v.code === "DUPLICATE_PERIOD_ID")).toBe(true);
      expect(report.summary.duplicateIdCount).toBe(1);
    });

    it("flags invalid unparseable start and end dates", () => {
      const periods = [
        createPeriod("2026-bad-start", "invalid-date", "2026-01-31T00:00:00.000Z"),
        createPeriod("2026-bad-end", "2026-02-01T00:00:00.000Z", "not-a-date"),
      ];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(2);
      expect(report.violations[0].code).toBe("INVALID_DATE_FORMAT");
      expect(report.violations[1].code).toBe("INVALID_DATE_FORMAT");
    });

    it("flags inverted date ranges where startDate > endDate", () => {
      const periods = [
        createPeriod("2026-inverted", "2026-02-15T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
      ];
      const report = detectPayrollCalendarOverlaps(periods);
      expect(report.isValid).toBe(false);
      expect(report.violations[0].code).toBe("INVALID_DATE_RANGE");
    });

    it("flags zero duration when allowZeroDuration is false", () => {
      const timestamp = "2026-03-01T00:00:00.000Z";
      const periods = [createPeriod("2026-zero", timestamp, timestamp)];
      const report = detectPayrollCalendarOverlaps(periods, { allowZeroDuration: false });
      expect(report.isValid).toBe(false);
      expect(report.violations[0].code).toBe("INVALID_DATE_RANGE");
    });
  });

  describe("assertNoPayrollCalendarOverlap", () => {
    it("does not throw on clean non-overlapping calendar", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"),
        createPeriod("2026-02", "2026-02-01T00:00:00.000Z", "2026-02-28T00:00:00.000Z"),
      ];
      expect(() => assertNoPayrollCalendarOverlap(periods)).not.toThrow();
    });

    it("throws PayrollCalendarOverlapError with actionable details when overlap exists", () => {
      const periods = [
        createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
        createPeriod("2026-02", "2026-01-15T00:00:00.000Z", "2026-02-15T00:00:00.000Z"),
      ];

      expect(() => assertNoPayrollCalendarOverlap(periods)).toThrow(PayrollCalendarOverlapError);

      try {
        assertNoPayrollCalendarOverlap(periods);
      } catch (err) {
        expect(err).toBeInstanceOf(PayrollCalendarOverlapError);
        const overlapErr = err as PayrollCalendarOverlapError;
        expect(overlapErr.code).toBe("PAYROLL_CALENDAR_OVERLAP");
        expect(overlapErr.violations).toHaveLength(1);
        expect(overlapErr.suggestedFix).toBeDefined();
        expect(overlapErr.context).toBeDefined();
      }
    });
  });

  describe("isPayrollPeriodOverlapping helper", () => {
    it("returns true when two periods overlap", () => {
      const p1 = createPeriod("p1", "2026-05-01T00:00:00.000Z", "2026-05-20T00:00:00.000Z");
      const p2 = createPeriod("p2", "2026-05-10T00:00:00.000Z", "2026-05-30T00:00:00.000Z");
      expect(isPayrollPeriodOverlapping(p1, p2)).toBe(true);
    });

    it("returns false when two periods do not overlap", () => {
      const p1 = createPeriod("p1", "2026-05-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z");
      const p2 = createPeriod("p2", "2026-05-20T00:00:00.000Z", "2026-05-31T00:00:00.000Z");
      expect(isPayrollPeriodOverlapping(p1, p2)).toBe(false);
    });

    it("returns false for adjacent boundaries by default", () => {
      const p1 = createPeriod("p1", "2026-05-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z");
      const p2 = createPeriod("p2", "2026-05-15T00:00:00.000Z", "2026-05-31T00:00:00.000Z");
      expect(isPayrollPeriodOverlapping(p1, p2)).toBe(false);
    });
  });

  describe("findOverlappingPeriods helper", () => {
    const existing = [
      createPeriod("2026-01", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
      createPeriod("2026-03", "2026-03-01T00:00:00.000Z", "2026-03-31T23:59:59.999Z"),
    ];

    it("returns empty array when candidate does not conflict with existing calendar", () => {
      const candidate = createPeriod(
        "2026-02",
        "2026-02-01T00:00:00.000Z",
        "2026-02-28T23:59:59.999Z"
      );
      const conflicts = findOverlappingPeriods(candidate, existing);
      expect(conflicts).toHaveLength(0);
    });

    it("returns conflicting violation when candidate overlaps an existing period", () => {
      const candidate = createPeriod(
        "2026-mid",
        "2026-01-20T00:00:00.000Z",
        "2026-02-10T00:00:00.000Z"
      );
      const conflicts = findOverlappingPeriods(candidate, existing);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].code).toBe("OVERLAPPING_PERIOD");
    });
  });

  describe("filterNonOverlappingPeriods helper", () => {
    it("partitions periods into clean and conflicting sets", () => {
      const periods = [
        createPeriod("CLEAN-1", "2026-01-01T00:00:00.000Z", "2026-01-10T00:00:00.000Z"),
        createPeriod("CONFLICT-A", "2026-02-01T00:00:00.000Z", "2026-02-20T00:00:00.000Z"),
        createPeriod("CONFLICT-B", "2026-02-15T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
        createPeriod("CLEAN-2", "2026-04-01T00:00:00.000Z", "2026-04-30T00:00:00.000Z"),
      ];

      const { validPeriods, conflictingPeriods, report } = filterNonOverlappingPeriods(periods);
      expect(report.isValid).toBe(false);
      expect(validPeriods.map((p) => p.periodId)).toEqual(["CLEAN-1", "CLEAN-2"]);
      expect(conflictingPeriods.map((p) => p.periodId)).toEqual(["CONFLICT-A", "CONFLICT-B"]);
    });
  });

  describe("scheduleToCalendarPeriod adapter", () => {
    it("converts a NormalizedPayrollSchedule into a valid PayrollCalendarPeriodInput", () => {
      const schedule = normalizePayrollSchedule({
        date: "2026-09-15T00:00:00.000Z",
        periodLabel: "2026-09",
        frequency: "monthly",
      });

      const calendarPeriod = scheduleToCalendarPeriod(schedule);
      expect(calendarPeriod.periodId).toBe("2026-09");
      expect(calendarPeriod.startDate).toBe(schedule.cycleStartDate);
      expect(calendarPeriod.endDate).toBe(schedule.cycleEndDate);
      expect(calendarPeriod.frequency).toBe("monthly");

      const normResult = normalizeCalendarPeriod(calendarPeriod);
      expect(normResult.period).toBeDefined();
      expect(normResult.violation).toBeUndefined();
    });

    it("converts raw schedule inputs cleanly", () => {
      const raw = {
        date: 1789430400000,
        cutoffTimestamp: 1789516800000,
        periodLabel: "raw-sched",
      };
      const converted = scheduleToCalendarPeriod(raw);
      expect(converted.periodId).toBe("raw-sched");
      expect(converted.startDate).toBe(1789430400000);
      expect(converted.endDate).toBe(1789516800000);
    });
  });

  describe("Privacy & Redaction Guarantees", () => {
    it("masks period identifiers correctly", () => {
      expect(redactPeriodId("period-2026-long-id")).toBe("per***-id");
      expect(redactPeriodId("p1")).toBe("[PERIOD_REDACTED]");
      expect(redactPeriodId("")).toBe("[ANONYMOUS_PERIOD]");
      expect(redactPeriodId(undefined)).toBe("[ANONYMOUS_PERIOD]");
    });

    it("masks scope identifiers correctly", () => {
      expect(redactScopeId("organization-corp-1")).toBe("org***p-1");
      expect(redactScopeId("us")).toBe("[SCOPE_REDACTED]");
      expect(redactScopeId("")).toBe("[DEFAULT_SCOPE]");
      expect(redactScopeId(undefined)).toBe("[DEFAULT_SCOPE]");
    });

    it("outputs redacted messages by default without exposing internal details", () => {
      const periods = [
        createPeriod("secret-id-001", "2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
        createPeriod("secret-id-002", "2026-01-15T00:00:00.000Z", "2026-02-05T00:00:00.000Z"),
      ];

      const report = detectPayrollCalendarOverlaps(periods, { redactIdentifiers: true });
      expect(report.violations[0].redactedPeriodId).not.toBe("secret-id-001");
      expect(report.violations[0].redactedMessage).not.toContain("secret-id-001");
    });
  });
});
