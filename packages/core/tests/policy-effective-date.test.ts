import { compilePayrollPolicy, compilePayrollPolicyOrThrow } from "../src/policy/compiler";
import {
  PolicyCompileError,
  PolicyCompileErrorCode,
  type PayrollPolicyInput,
} from "../src/policy/types";
import { MINIMAL_POLICY_FIXTURE } from "../src/policy/fixtures";

/**
 * Fixed reference clock so the "not in the past" rule is deterministic.
 * All dates in this suite are interpreted against this instant.
 */
const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const FUTURE_ISO = "2026-10-01T00:00:00.000Z";
const LATER_ISO = "2027-10-01T00:00:00.000Z";

function compileWithDates(dates: Partial<Pick<PayrollPolicyInput, "effectiveDate" | "endDate">>) {
  return compilePayrollPolicy({ ...MINIMAL_POLICY_FIXTURE, ...dates }, { now: NOW });
}

function expectSingleDateError(
  result: ReturnType<typeof compileWithDates>,
  field: "effectiveDate" | "endDate"
): PolicyCompileError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected compile failure");
  const dateErrors = result.errors.filter(
    (e) => e.code === PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE && e.field === field
  );
  expect(dateErrors).toHaveLength(1);
  return dateErrors[0];
}

describe("compilePayrollPolicy — effective-date success paths", () => {
  it("compiles with an effectiveDate only and emits effectiveDateMs", () => {
    const result = compileWithDates({ effectiveDate: FUTURE_ISO });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveDateMs).toBe(Date.parse(FUTURE_ISO));
      expect(result.value.endDateMs).toBeUndefined();
    }
  });

  it("compiles with both dates and emits both epoch-ms fields", () => {
    const result = compileWithDates({ effectiveDate: FUTURE_ISO, endDate: LATER_ISO });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveDateMs).toBe(Date.parse(FUTURE_ISO));
      expect(result.value.endDateMs).toBe(Date.parse(LATER_ISO));
    }
  });

  it("accepts epoch-millisecond inputs as well as ISO strings", () => {
    const result = compileWithDates({
      effectiveDate: Date.parse(FUTURE_ISO),
      endDate: Date.parse(LATER_ISO),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveDateMs).toBe(Date.parse(FUTURE_ISO));
      expect(result.value.endDateMs).toBe(Date.parse(LATER_ISO));
    }
  });

  it("accepts an effectiveDate exactly at the reference time (inclusive boundary)", () => {
    const result = compileWithDates({ effectiveDate: NOW });
    expect(result.ok).toBe(true);
  });

  it("omits date fields entirely when no dates are provided (backward compatible)", () => {
    const result = compilePayrollPolicy(MINIMAL_POLICY_FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("effectiveDateMs" in result.value).toBe(false);
      expect("endDateMs" in result.value).toBe(false);
    }
  });
});

describe("compilePayrollPolicy — effective-date failure paths", () => {
  it("rejects a past effectiveDate with an actionable message and context", () => {
    const result = compileWithDates({ effectiveDate: "2026-09-14T00:00:00.000Z" });
    const error = expectSingleDateError(result, "effectiveDate");
    expect(error.message).toContain("must not be in the past");
    expect(error.context.effectiveDateMs).toBe(Date.parse("2026-09-14T00:00:00.000Z"));
    expect(error.context.nowMs).toBe(NOW);
  });

  it("rejects an unparseable effectiveDate", () => {
    const result = compileWithDates({ effectiveDate: "not-a-date" });
    const error = expectSingleDateError(result, "effectiveDate");
    expect(error.message).toContain("valid date");
    expect(error.context.effectiveDate).toBe("not-a-date");
  });

  it("rejects an endDate before the effectiveDate", () => {
    const result = compileWithDates({
      effectiveDate: FUTURE_ISO,
      endDate: "2026-09-30T00:00:00.000Z",
    });
    const error = expectSingleDateError(result, "endDate");
    expect(error.message).toContain("must be after effectiveDate");
  });

  it("rejects an endDate equal to the effectiveDate (strictly-after rule)", () => {
    const result = compileWithDates({
      effectiveDate: "2026-10-01T00:00:00.000Z",
      endDate: "2026-10-01T00:00:00.000Z",
    });
    expectSingleDateError(result, "endDate");
  });

  it("rejects an unparseable endDate", () => {
    const result = compileWithDates({ effectiveDate: FUTURE_ISO, endDate: "" });
    const error = expectSingleDateError(result, "endDate");
    expect(error.message).toContain("valid date");
  });

  it("rejects an endDate provided without an effectiveDate", () => {
    const result = compileWithDates({ endDate: LATER_ISO });
    const error = expectSingleDateError(result, "endDate");
    expect(error.message).toContain("requires effectiveDate");
  });
});

describe("compilePayrollPolicy — reference clock injection", () => {
  it("uses options.now instead of the wall clock for the past-date check", () => {
    const input: PayrollPolicyInput = {
      ...MINIMAL_POLICY_FIXTURE,
      effectiveDate: "2020-01-01T00:00:00.000Z", // long before the real wall clock
    };
    const result = compilePayrollPolicy(input, { now: Date.parse("2019-06-01T00:00:00.000Z") });
    expect(result.ok).toBe(true);
  });

  it("still compiles deterministically for identical input and options", () => {
    const dates = { effectiveDate: FUTURE_ISO, endDate: LATER_ISO };
    const a = compileWithDates(dates);
    const b = compileWithDates(dates);
    expect(a).toEqual(b);
  });
});

describe("compilePayrollPolicyOrThrow — effective-date errors", () => {
  it("throws a PolicyCompileError with code INVALID_EFFECTIVE_DATE and allErrors context", () => {
    const input: PayrollPolicyInput = {
      ...MINIMAL_POLICY_FIXTURE,
      effectiveDate: "2026-09-01T00:00:00.000Z",
    };
    expect(() => compilePayrollPolicyOrThrow(input, { now: NOW })).toThrow(PolicyCompileError);
    try {
      compilePayrollPolicyOrThrow(input, { now: NOW });
      fail("expected throw");
    } catch (err) {
      const policyError = err as PolicyCompileError;
      expect(policyError.code).toBe(PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE);
      expect(policyError.field).toBe("effectiveDate");
      expect(Array.isArray(policyError.context.allErrors)).toBe(true);
    }
  });
});
