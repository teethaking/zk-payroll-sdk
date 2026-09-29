/**
 * Payroll Calendar Overlap Detection Module
 *
 * Provides robust validation and detection of overlapping payroll cycles,
 * duplicate periods, and malformed scheduling intervals within the SDK layer.
 * Ensures operational integrity and prevents double-disbursements or conflicting
 * accounting windows across organization schedules.
 *
 * ## Privacy & Security Guarantees
 * - Period and scope identifiers are redacted by default in user-facing messages.
 * - Error messages never leak employee counts, amounts, or payroll secrets.
 * - Consistent, stable violation codes and actionable remediation guidance.
 */

import { ZkPayrollError, type ErrorContext } from "../core/errors";
import type {
  NormalizedPayrollSchedule,
  RawPayrollScheduleInput,
} from "../schedules/scheduleNormalizer";

/**
 * Standard violation codes for payroll calendar validation.
 */
export type PayrollCalendarOverlapViolationCode =
  | "OVERLAPPING_PERIOD"
  | "CONTAINED_PERIOD"
  | "IDENTICAL_PERIOD_RANGE"
  | "DUPLICATE_PERIOD_ID"
  | "INVALID_DATE_RANGE"
  | "INVALID_PERIOD_ID"
  | "INVALID_DATE_FORMAT";

/**
 * Input definition for a payroll calendar period.
 */
export interface PayrollCalendarPeriodInput {
  /** Unique period identifier (e.g. "period-2026-01", "2026-Q1", "sep-2026") */
  periodId: string;
  /** Start of the payroll cycle (ISO string, epoch ms timestamp, or Date) */
  startDate: string | number | Date;
  /** End of the payroll cycle (ISO string, epoch ms timestamp, or Date) */
  endDate: string | number | Date;
  /** Optional execution or payout date */
  executionDate?: string | number | Date;
  /** Optional submission cutoff timestamp */
  cutoffDate?: string | number | Date;
  /** Optional schedule cadence / frequency */
  frequency?: string;
  /** Optional scope identifier, e.g. employer, organization, or department ID */
  scopeId?: string;
  /** Optional payroll status (e.g. "draft", "locked", "settled", "archived", "cancelled") */
  status?: string;
  /** Optional arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Fully normalized, canonical payroll calendar period.
 */
export interface NormalizedCalendarPeriod {
  /** Unique period identifier */
  periodId: string;
  /** Start of cycle in Unix epoch milliseconds */
  startMs: number;
  /** End of cycle in Unix epoch milliseconds */
  endMs: number;
  /** Start date in UTC ISO 8601 string */
  startDateIso: string;
  /** End date in UTC ISO 8601 string */
  endDateIso: string;
  /** Duration of the cycle in milliseconds */
  durationMs: number;
  /** Optional execution timestamp in Unix epoch milliseconds */
  executionMs?: number;
  /** Optional cutoff timestamp in Unix epoch milliseconds */
  cutoffMs?: number;
  /** Schedule cadence / frequency */
  frequency?: string;
  /** Organization or employer scope identifier */
  scopeId?: string;
  /** Lifecycle status */
  status?: string;
  /** Original input reference */
  raw: PayrollCalendarPeriodInput;
}

/**
 * Structured violation descriptor detailing a calendar scheduling issue.
 */
export interface PayrollCalendarOverlapViolation {
  /** Machine-readable violation code */
  code: PayrollCalendarOverlapViolationCode;
  /** Primary offending period identifier */
  periodId: string;
  /** Redacted period identifier for privacy-safe logs */
  redactedPeriodId: string;
  /** Conflicting period identifier (if collision occurred with another period) */
  conflictingPeriodId?: string;
  /** Redacted conflicting period identifier */
  redactedConflictingPeriodId?: string;
  /** Scope identifier where collision occurred (if applicable) */
  scopeId?: string;
  /** Overlap start timestamp in milliseconds (if applicable) */
  overlapStartMs?: number;
  /** Overlap end timestamp in milliseconds (if applicable) */
  overlapEndMs?: number;
  /** Overlap duration in milliseconds (if applicable) */
  overlapDurationMs?: number;
  /** Detailed error message */
  message: string;
  /** Sanitized error message safe for public UI */
  redactedMessage: string;
  /** Actionable remediation recommendation */
  suggestedFix: string;
}

/**
 * Configuration options for overlap detection.
 */
export interface PayrollCalendarOverlapOptions {
  /**
   * Whether adjacent period boundaries are considered non-overlapping.
   * If true (default), endA === startB is valid (contiguous/abutting).
   * If false, sharing an exact boundary timestamp is flagged as an overlap.
   */
  allowAdjacentBoundaries?: boolean;
  /**
   * Only detect overlaps between periods sharing the same scopeId.
   * If false (default), periods are compared globally.
   * If true, periods with different non-empty scopeIds will not conflict.
   */
  groupByScope?: boolean;
  /**
   * Statuses to ignore during overlap detection (e.g. ['cancelled']).
   * Defaults to ['cancelled'].
   */
  ignoreStatuses?: string[];
  /**
   * Mask period and scope identifiers in messages for privacy.
   * Defaults to true.
   */
  redactIdentifiers?: boolean;
  /**
   * Minimum duration in milliseconds for a valid period (defaults to 1).
   */
  minPeriodDurationMs?: number;
  /**
   * Allow zero-duration periods (startMs === endMs).
   * Defaults to false.
   */
  allowZeroDuration?: boolean;
}

/**
 * Report generated by calendar overlap analysis.
 */
export interface PayrollCalendarOverlapReport {
  /** Whether the calendar is completely valid with zero overlaps or invalid periods */
  isValid: boolean;
  /** List of detected violations */
  violations: PayrollCalendarOverlapViolation[];
  /** Successfully normalized periods */
  normalizedPeriods: NormalizedCalendarPeriod[];
  /** Summary metrics */
  summary: {
    totalPeriods: number;
    validCount: number;
    violationCount: number;
    overlapCount: number;
    duplicateIdCount: number;
    invalidDateCount: number;
    hasOverlaps: boolean;
  };
}

/**
 * Typed error thrown when payroll calendar overlap or scheduling violation is detected.
 */
export class PayrollCalendarOverlapError extends ZkPayrollError {
  public readonly violations: readonly PayrollCalendarOverlapViolation[];
  public readonly suggestedFix: string;

  constructor(
    message: string,
    violations: PayrollCalendarOverlapViolation[] = [],
    context: ErrorContext = {}
  ) {
    super(message, "PAYROLL_CALENDAR_OVERLAP", context);
    this.name = "PayrollCalendarOverlapError";
    this.violations = Object.freeze([...violations]);
    this.suggestedFix =
      violations[0]?.suggestedFix ?? "Adjust payroll period dates so cycles do not overlap.";
    Object.setPrototypeOf(this, PayrollCalendarOverlapError.prototype);
  }
}

/**
 * Redacts a period ID for privacy-preserving logs and UI previews.
 */
export function redactPeriodId(id?: string): string {
  if (!id || typeof id !== "string") {
    return "[ANONYMOUS_PERIOD]";
  }
  const clean = id.trim();
  if (clean.length === 0) {
    return "[ANONYMOUS_PERIOD]";
  }
  if (clean.length <= 4) {
    return "[PERIOD_REDACTED]";
  }
  if (clean.length <= 8) {
    return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  }
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

/**
 * Redacts an organization/employer scope ID.
 */
export function redactScopeId(scopeId?: string): string {
  if (!scopeId || typeof scopeId !== "string") {
    return "[DEFAULT_SCOPE]";
  }
  const clean = scopeId.trim();
  if (clean.length === 0) {
    return "[DEFAULT_SCOPE]";
  }
  if (clean.length <= 4) {
    return "[SCOPE_REDACTED]";
  }
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

/**
 * Parses arbitrary date input into Unix epoch milliseconds.
 * Returns null if input is invalid or missing.
 */
export function parseCalendarTimestamp(val: unknown): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val === "number") {
    if (isNaN(val) || !isFinite(val)) {
      return null;
    }
    return val;
  }
  if (val instanceof Date) {
    const time = val.getTime();
    return isNaN(time) ? null : time;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      return parsed;
    }
    const num = Number(trimmed);
    if (!isNaN(num) && isFinite(num)) {
      return num;
    }
  }
  return null;
}

/**
 * Normalizes and validates a single calendar period input.
 */
export function normalizeCalendarPeriod(
  input: PayrollCalendarPeriodInput,
  options: PayrollCalendarOverlapOptions = {}
): {
  period?: NormalizedCalendarPeriod;
  violation?: PayrollCalendarOverlapViolation;
} {
  const redact = options.redactIdentifiers !== false;
  const allowZeroDuration = options.allowZeroDuration === true;
  const minDuration = options.minPeriodDurationMs ?? (allowZeroDuration ? 0 : 1);

  const rawId = input?.periodId;
  const periodId = typeof rawId === "string" ? rawId.trim() : "";
  const displayId = redact ? redactPeriodId(periodId) : periodId || "[UNKNOWN]";

  // 1. Validate period identifier
  if (!periodId) {
    return {
      violation: {
        code: "INVALID_PERIOD_ID",
        periodId: "",
        redactedPeriodId: "[ANONYMOUS_PERIOD]",
        message: "Payroll calendar period identifier is required and must not be empty.",
        redactedMessage: "Period identifier is required.",
        suggestedFix: "Assign a unique non-empty string identifier (e.g. '2026-01') to the period.",
      },
    };
  }

  // 2. Validate start and end dates
  const startMs = parseCalendarTimestamp(input.startDate);
  const endMs = parseCalendarTimestamp(input.endDate);

  if (startMs === null) {
    return {
      violation: {
        code: "INVALID_DATE_FORMAT",
        periodId,
        redactedPeriodId: displayId,
        message: `Period '${displayId}' has an invalid or missing start date: ${String(input.startDate)}.`,
        redactedMessage: `Period has an invalid start date.`,
        suggestedFix:
          "Provide a valid ISO date string, epoch millisecond timestamp, or Date object for startDate.",
      },
    };
  }

  if (endMs === null) {
    return {
      violation: {
        code: "INVALID_DATE_FORMAT",
        periodId,
        redactedPeriodId: displayId,
        message: `Period '${displayId}' has an invalid or missing end date: ${String(input.endDate)}.`,
        redactedMessage: `Period has an invalid end date.`,
        suggestedFix:
          "Provide a valid ISO date string, epoch millisecond timestamp, or Date object for endDate.",
      },
    };
  }

  // 3. Validate date interval ordering and duration
  const durationMs = endMs - startMs;
  if (durationMs < minDuration) {
    const errorMsg =
      startMs > endMs
        ? `Period '${displayId}' has start date (${new Date(startMs).toISOString()}) after end date (${new Date(endMs).toISOString()}).`
        : `Period '${displayId}' duration (${durationMs}ms) is less than minimum required duration (${minDuration}ms).`;

    return {
      violation: {
        code: "INVALID_DATE_RANGE",
        periodId,
        redactedPeriodId: displayId,
        message: errorMsg,
        redactedMessage: `Period date range is inverted or insufficient.`,
        suggestedFix:
          "Ensure startDate strictly precedes endDate by the minimum required cycle duration.",
      },
    };
  }

  const executionMs = parseCalendarTimestamp(input.executionDate) ?? undefined;
  const cutoffMs = parseCalendarTimestamp(input.cutoffDate) ?? undefined;

  return {
    period: {
      periodId,
      startMs,
      endMs,
      startDateIso: new Date(startMs).toISOString(),
      endDateIso: new Date(endMs).toISOString(),
      durationMs,
      executionMs,
      cutoffMs,
      frequency: input.frequency,
      scopeId: input.scopeId?.trim() || undefined,
      status: input.status?.trim().toLowerCase() || undefined,
      raw: input,
    },
  };
}

/**
 * Checks whether two calendar periods overlap in time.
 *
 * @param periodA - First period
 * @param periodB - Second period
 * @param options - Overlap configuration
 * @returns `true` if periods overlap, `false` otherwise
 */
export function isPayrollPeriodOverlapping(
  periodA: PayrollCalendarPeriodInput | NormalizedCalendarPeriod,
  periodB: PayrollCalendarPeriodInput | NormalizedCalendarPeriod,
  options: PayrollCalendarOverlapOptions = {}
): boolean {
  const normA = "startMs" in periodA ? periodA : normalizeCalendarPeriod(periodA, options).period;
  const normB = "startMs" in periodB ? periodB : normalizeCalendarPeriod(periodB, options).period;

  if (!normA || !normB) {
    return false;
  }

  // Check scope if groupByScope enabled
  if (options.groupByScope) {
    const scopeA = normA.scopeId ?? "";
    const scopeB = normB.scopeId ?? "";
    if (scopeA !== scopeB) {
      return false;
    }
  }

  // Check ignored statuses
  const ignoreStatuses = (options.ignoreStatuses ?? ["cancelled"]).map((s) => s.toLowerCase());
  if (normA.status && ignoreStatuses.includes(normA.status)) return false;
  if (normB.status && ignoreStatuses.includes(normB.status)) return false;

  const allowAdjacent = options.allowAdjacentBoundaries !== false;

  if (allowAdjacent) {
    // Overlap occurs strictly when intervals share more than an instantaneous boundary
    return normA.startMs < normB.endMs && normB.startMs < normA.endMs;
  } else {
    // Inclusive boundary: touching at boundary is considered overlap
    return normA.startMs <= normB.endMs && normB.startMs <= normA.endMs;
  }
}

/**
 * Detects all overlaps, invalid intervals, and identifier collisions in a payroll calendar.
 *
 * @param periods - Array of payroll calendar periods to validate
 * @param options - Overlap detection options
 * @returns Comprehensive validation report
 */
export function detectPayrollCalendarOverlaps(
  periods: PayrollCalendarPeriodInput[] = [],
  options: PayrollCalendarOverlapOptions = {}
): PayrollCalendarOverlapReport {
  const violations: PayrollCalendarOverlapViolation[] = [];
  const normalizedPeriods: NormalizedCalendarPeriod[] = [];
  const redact = options.redactIdentifiers !== false;
  const ignoreStatuses = (options.ignoreStatuses ?? ["cancelled"]).map((s) => s.toLowerCase());
  const allowAdjacent = options.allowAdjacentBoundaries !== false;
  const groupByScope = options.groupByScope === true;

  let duplicateIdCount = 0;
  let invalidDateCount = 0;
  let overlapCount = 0;

  // Track seen period IDs
  const seenIds = new Map<string, number>();

  // 1. Normalize and validate individual periods
  for (let i = 0; i < periods.length; i++) {
    const raw = periods[i];
    const { period, violation } = normalizeCalendarPeriod(raw, options);

    if (violation) {
      violations.push(violation);
      if (violation.code === "INVALID_DATE_FORMAT" || violation.code === "INVALID_DATE_RANGE") {
        invalidDateCount++;
      }
      continue;
    }

    if (!period) continue;

    // Check duplicate ID
    const key = groupByScope ? `${period.scopeId ?? ""}:${period.periodId}` : period.periodId;
    if (seenIds.has(key)) {
      duplicateIdCount++;
      const firstIndex = seenIds.get(key)!;
      const displayId = redact ? redactPeriodId(period.periodId) : period.periodId;
      violations.push({
        code: "DUPLICATE_PERIOD_ID",
        periodId: period.periodId,
        redactedPeriodId: displayId,
        conflictingPeriodId: periods[firstIndex].periodId,
        redactedConflictingPeriodId: redact
          ? redactPeriodId(periods[firstIndex].periodId)
          : periods[firstIndex].periodId,
        scopeId: period.scopeId,
        message: `Duplicate period identifier detected: '${displayId}'. Each calendar period must have a unique identifier.`,
        redactedMessage: `Duplicate period identifier detected in calendar.`,
        suggestedFix: "Ensure all payroll periods have distinct periodId values.",
      });
    } else {
      seenIds.set(key, i);
    }

    normalizedPeriods.push(period);
  }

  // 2. Pairwise overlap detection across valid active periods
  // Filter out ignored statuses
  const activePeriods = normalizedPeriods.filter(
    (p) => !p.status || !ignoreStatuses.includes(p.status)
  );

  for (let i = 0; i < activePeriods.length; i++) {
    for (let j = i + 1; j < activePeriods.length; j++) {
      const a = activePeriods[i];
      const b = activePeriods[j];

      // If scope partitioning enabled, skip different scopes
      if (groupByScope && (a.scopeId ?? "") !== (b.scopeId ?? "")) {
        continue;
      }

      // Check if intervals overlap
      const hasOverlap = allowAdjacent
        ? a.startMs < b.endMs && b.startMs < a.endMs
        : a.startMs <= b.endMs && b.startMs <= a.endMs;

      if (!hasOverlap) {
        continue;
      }

      overlapCount++;

      const overlapStartMs = Math.max(a.startMs, b.startMs);
      const overlapEndMs = Math.min(a.endMs, b.endMs);
      const overlapDurationMs = Math.max(0, overlapEndMs - overlapStartMs);

      const displayA = redact ? redactPeriodId(a.periodId) : a.periodId;
      const displayB = redact ? redactPeriodId(b.periodId) : b.periodId;
      const displayScope = a.scopeId ? (redact ? redactScopeId(a.scopeId) : a.scopeId) : undefined;

      // Classify violation subtype
      let code: PayrollCalendarOverlapViolationCode = "OVERLAPPING_PERIOD";
      let details = `overlaps with period '${displayB}'`;

      if (a.startMs === b.startMs && a.endMs === b.endMs) {
        code = "IDENTICAL_PERIOD_RANGE";
        details = `shares the identical date interval with period '${displayB}'`;
      } else if (
        (a.startMs <= b.startMs && a.endMs >= b.endMs) ||
        (b.startMs <= a.startMs && b.endMs >= a.endMs)
      ) {
        code = "CONTAINED_PERIOD";
        const contained = a.startMs >= b.startMs && a.endMs <= b.endMs ? displayA : displayB;
        const container = contained === displayA ? displayB : displayA;
        details = `is completely contained within period '${container}'`;
      }

      const scopePart = displayScope ? ` in scope '${displayScope}'` : "";
      const overlapStartIso = new Date(overlapStartMs).toISOString();
      const overlapEndIso = new Date(overlapEndMs).toISOString();

      violations.push({
        code,
        periodId: a.periodId,
        redactedPeriodId: displayA,
        conflictingPeriodId: b.periodId,
        redactedConflictingPeriodId: displayB,
        scopeId: a.scopeId,
        overlapStartMs,
        overlapEndMs,
        overlapDurationMs,
        message: `Payroll calendar period '${displayA}' ${details}${scopePart} from ${overlapStartIso} to ${overlapEndIso} (${overlapDurationMs}ms overlap).`,
        redactedMessage: `Calendar period overlap detected between '${displayA}' and '${displayB}'.`,
        suggestedFix: `Adjust the schedule boundaries for '${displayA}' or '${displayB}' so their cycles do not intersect.`,
      });
    }
  }

  const validCount = periods.length - violations.length;

  return {
    isValid: violations.length === 0,
    violations,
    normalizedPeriods,
    summary: {
      totalPeriods: periods.length,
      validCount: Math.max(0, validCount),
      violationCount: violations.length,
      overlapCount,
      duplicateIdCount,
      invalidDateCount,
      hasOverlaps: overlapCount > 0,
    },
  };
}

/**
 * Asserts that a collection of payroll calendar periods contains no overlaps or invalid configurations.
 * Throws a typed `PayrollCalendarOverlapError` if any violation is found.
 *
 * @param periods - Array of payroll calendar periods
 * @param options - Configuration options
 * @throws {PayrollCalendarOverlapError} When overlap or invalid period is detected
 */
export function assertNoPayrollCalendarOverlap(
  periods: PayrollCalendarPeriodInput[] = [],
  options: PayrollCalendarOverlapOptions = {}
): void {
  const report = detectPayrollCalendarOverlaps(periods, options);
  if (!report.isValid) {
    const firstViolation = report.violations[0];
    const message = `Payroll calendar validation failed with ${report.violations.length} violation(s). First violation: ${firstViolation.message}`;
    throw new PayrollCalendarOverlapError(message, report.violations, {
      violationCount: report.violations.length,
      firstViolationCode: firstViolation.code,
      periodId: firstViolation.periodId,
      conflictingPeriodId: firstViolation.conflictingPeriodId,
    });
  }
}

/**
 * Checks a candidate period against a list of existing calendar periods and
 * returns any conflicting overlap violations.
 *
 * @param candidate - Candidate period to test
 * @param existingPeriods - Currently scheduled periods
 * @param options - Validation options
 * @returns Array of violations conflicting with the candidate
 */
export function findOverlappingPeriods(
  candidate: PayrollCalendarPeriodInput,
  existingPeriods: PayrollCalendarPeriodInput[] = [],
  options: PayrollCalendarOverlapOptions = {}
): PayrollCalendarOverlapViolation[] {
  // Check candidate validity first
  const { period: normCandidate, violation: candidateViolation } = normalizeCalendarPeriod(
    candidate,
    options
  );
  if (candidateViolation) {
    return [candidateViolation];
  }

  if (!normCandidate) {
    return [];
  }

  const report = detectPayrollCalendarOverlaps([...existingPeriods, candidate], options);
  return report.violations.filter(
    (v) => v.periodId === candidate.periodId || v.conflictingPeriodId === candidate.periodId
  );
}

/**
 * Filters a list of calendar periods, partitioning them into valid non-overlapping periods
 * and conflicting periods.
 *
 * @param periods - Calendar periods to evaluate
 * @param options - Overlap detection options
 * @returns Partitioned valid and conflicting periods
 */
export function filterNonOverlappingPeriods(
  periods: PayrollCalendarPeriodInput[] = [],
  options: PayrollCalendarOverlapOptions = {}
): {
  validPeriods: PayrollCalendarPeriodInput[];
  conflictingPeriods: PayrollCalendarPeriodInput[];
  report: PayrollCalendarOverlapReport;
} {
  const report = detectPayrollCalendarOverlaps(periods, options);
  if (report.isValid) {
    return {
      validPeriods: [...periods],
      conflictingPeriods: [],
      report,
    };
  }

  const conflictingIds = new Set<string>();
  for (const v of report.violations) {
    if (v.periodId) conflictingIds.add(v.periodId);
    if (v.conflictingPeriodId) conflictingIds.add(v.conflictingPeriodId);
  }

  const validPeriods = periods.filter((p) => !conflictingIds.has(p.periodId));
  const conflictingPeriods = periods.filter((p) => conflictingIds.has(p.periodId));

  return {
    validPeriods,
    conflictingPeriods,
    report,
  };
}

/**
 * Converts a `NormalizedPayrollSchedule` or `RawPayrollScheduleInput` into a `PayrollCalendarPeriodInput`.
 *
 * @param schedule - Normalized or raw schedule object
 * @param fallbackPeriodId - Fallback period identifier if not specified in schedule
 * @returns Formatted calendar period input
 */
export function scheduleToCalendarPeriod(
  schedule: NormalizedPayrollSchedule | RawPayrollScheduleInput,
  fallbackPeriodId?: string
): PayrollCalendarPeriodInput {
  if ("cycleStartDate" in schedule && "cycleEndDate" in schedule) {
    // NormalizedPayrollSchedule
    return {
      periodId:
        schedule.period || fallbackPeriodId || `period-${schedule.cycleStartDate.slice(0, 10)}`,
      startDate: schedule.cycleStartDate,
      endDate: schedule.cycleEndDate,
      executionDate: schedule.executionTimestamp,
      cutoffDate: schedule.cutoffTimestamp,
      frequency: schedule.frequency,
      metadata: {
        displayLabel: schedule.displayLabel,
        timezone: schedule.timezone,
      },
    };
  }

  // RawPayrollScheduleInput
  const periodId =
    schedule.periodLabel ||
    fallbackPeriodId ||
    `period-${schedule.date ? String(schedule.date).slice(0, 10) : Date.now()}`;

  return {
    periodId,
    startDate: schedule.date ?? Date.now(),
    endDate: schedule.cutoffTimestamp ?? Date.now(),
    frequency: schedule.frequency,
  };
}
