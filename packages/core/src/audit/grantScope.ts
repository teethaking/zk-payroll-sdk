/**
 * Audit Grant Scope Reader
 *
 * Reads the **effective** audit access scope for a grantee by folding every
 * persisted grant into a single, typed answer: the widest scope currently in
 * force plus the lifecycle state that produced it.
 *
 * Why this matters
 * ----------------
 * An auditor usually accumulates several grants over time — a short-lived
 * `read-only` window, a later `full-audit` grant, an older grant that quietly
 * expired, one that an admin revoked. Reading a single stored record tells you
 * what *was* granted, not what is *usable right now*. A payroll integration
 * that gates on the wrong record can either over-block a legitimate auditor or
 * hand departmental breakdowns to a stale grant.
 *
 * Contract alignment
 * ------------------
 * - `scope` maps directly to the contract's `ViewKeyScope` enum
 *   (`read_view_key` / `grant_view_key`).
 * - The effective scope is the **widest scope among grants that are active at
 *   the reference time** — the reader never escalates past what was actually
 *   granted, and never reports a scope wider than the widest live grant.
 *
 * Privacy
 * -------
 * The reader is deliberately metadata-only. It reports grant identifiers,
 * scopes, lifecycle states, and timestamps — never view-key tokens, secret
 * keys, salaries, or employee records. Every human-readable `message` masks
 * grantee and granting-admin addresses via `redactAuditorId` so reports are
 * safe to log verbatim.
 *
 * @example
 * ```ts
 * const report = readEffectiveAuditGrantScope(grants);
 * const auditor = report.grantees[0];
 *
 * auditor.scope;   // "full-audit" — widest live grant, or null when none is live
 * auditor.state;   // "active" | "expired" | "revoked" | "none"
 * console.log(auditor.message); // "Auditor GAB***WXY: full-audit via 2 active grant(s)"
 * ```
 *
 * @module
 */

import { ValidationError } from "../core/errors";
import { formatDurationMs } from "../utils/date";
import { redactAuditorId } from "./accessExpiry";
import type { ViewKeyScope } from "./viewKeyHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every scope the contract accepts, ordered from narrowest to widest.
 * Index in this tuple is the scope's privilege rank.
 */
export const AUDIT_GRANT_SCOPES = ["read-only", "full-audit"] as const;

/** Widest-first ranking of audit scopes; used to pick the effective scope. */
const SCOPE_RANK: Readonly<Record<ViewKeyScope, number>> = {
  "read-only": 0,
  "full-audit": 1,
};

/**
 * A single persisted audit grant, as recorded by the integration that called
 * `grant_view_key` on the contract.
 *
 * Grants are plain metadata: nothing here is a secret, but callers should
 * still avoid logging `grantee`/`grantedBy` unmasked outside the SDK (use
 * {@link redactAuditorId}).
 */
export interface AuditGrantRecord {
  /** Stable grant identifier, unique across the supplied set. */
  grantId: string;
  /** Auditor the access was granted to (Stellar public key or auditor id). */
  grantee: string;
  /** Scope requested at grant time — the contract's `ViewKeyScope` enum. */
  scope: ViewKeyScope;
  /** Stellar public key of the admin that issued the grant. */
  grantedBy: string;
  /** ISO-8601 timestamp the grant was issued. */
  grantedAt: string;
  /** ISO-8601 timestamp the grant stops being usable. */
  expiresAt: string;
  /** ISO-8601 timestamp of an explicit revocation; absent when never revoked. */
  revokedAt?: string | null;
}

/** Lifecycle state of one grant at a reference time. */
export type AuditGrantState = "active" | "expired" | "revoked";

/**
 * Lifecycle state of a grantee's *effective* access.
 *
 * - `"active"` — at least one grant is live and a scope is in force.
 * - `"expired"` — no live grant remains, but at least one lapsed by time.
 * - `"revoked"` — no live grant remains and every past grant was revoked.
 * - `"none"` — no grant was ever supplied for this grantee.
 */
export type AuditGrantLifecycleState = "active" | "expired" | "revoked" | "none";

/** A single grant with its lifecycle state resolved at a reference time. */
export interface ResolvedAuditGrant {
  grantId: string;
  /** Scope exactly as granted — never widened by this reader. */
  scope: ViewKeyScope;
  state: AuditGrantState;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** Privilege rank of `scope`; higher means broader. */
  scopeRank: number;
  /** Milliseconds until expiry; negative once elapsed. `null` when revoked. */
  remainingMs: number | null;
}

/** Effective audit access for a single grantee. */
export interface EffectiveAuditGrant {
  /** Grantee the entry describes (unmasked; mask before logging). */
  grantee: string;
  /** Masked grantee, safe for logs, UI, and telemetry. */
  redactedGrantee: string;
  /**
   * Widest scope among grants that are active at the reference time, or
   * `null` when no grant is live. Never `null` while `state` is `"active"`.
   */
  scope: ViewKeyScope | null;
  /** Effective lifecycle state for this grantee. */
  state: AuditGrantLifecycleState;
  /** Every supplied grant for this grantee, ordered by `grantedAt` ascending. */
  grants: ResolvedAuditGrant[];
  /** Ids of the grants that produced `scope`. */
  activeGrantIds: string[];
  /** Total grants supplied for this grantee, including lapsed ones. */
  grantCount: number;
  /** Timestamp of the most recent lifecycle change, or `null` if never granted. */
  latestChangeAt: string | null;
  /** Privacy-safe single-line summary; addresses are masked. */
  message: string;
}

/** Effective audit access across every grantee present in the grant set. */
export interface AuditGrantScopeReport {
  /** True only when **every** grantee has at least one active grant. */
  allGranteesActive: boolean;
  /** Per-grantee entries, deterministically sorted by grantee. */
  grantees: EffectiveAuditGrant[];
  /** Grantees whose `state` is `"active"`, in report order. */
  activeGrantees: EffectiveAuditGrant[];
  /** Grantees with no live grant, in report order. */
  inactiveGrantees: EffectiveAuditGrant[];
  /** Privacy-safe summary naming every grantee without live access. */
  message: string;
}

/** Stable codes for audit grant scope reader input validation failures. */
export type AuditGrantScopeErrorCode =
  | "AUDIT_GRANTS_INVALID"
  | "AUDIT_GRANT_INVALID"
  | "AUDIT_GRANT_ID_REQUIRED"
  | "AUDIT_GRANT_ID_DUPLICATE"
  | "AUDIT_GRANTEE_REQUIRED"
  | "AUDIT_GRANT_SCOPE_INVALID"
  | "AUDIT_GRANT_TIMESTAMP_INVALID"
  | "AUDIT_GRANT_EXPIRY_INVALID"
  | "AUDIT_GRANT_LIFECYCLE_INVALID";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the lifecycle state of a single grant at a reference time.
 *
 * Precedence is `"revoked"` → `"expired"` → `"active"`: a deliberate
 * revocation always wins over time-based expiry, because a revoked grant must
 * never look merely "lapsed" to a caller deciding whether to re-issue it.
 *
 * @param grant - Grant to resolve. Not validated — use
 *   {@link readEffectiveAuditGrantScope} for validated input.
 * @param now  - Optional reference time; defaults to the current time.
 *
 * @example
 * ```ts
 * resolveAuditGrantState(grant, new Date("2026-01-01T00:00:00Z")); // "active"
 * ```
 */
export function resolveAuditGrantState(
  grant: AuditGrantRecord,
  now: Date = new Date()
): AuditGrantState {
  if (grant.revokedAt) {
    return "revoked";
  }
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now.getTime()) {
    return "expired";
  }
  return "active";
}

/**
 * Returns the widest scope in a collection, or `null` when the collection is
 * empty.
 *
 * @param scopes - Scopes to rank. Unrecognised values are ignored so a
 *   partially-decoded record cannot widen the result.
 */
export function selectWidestAuditScope(scopes: readonly ViewKeyScope[]): ViewKeyScope | null {
  let widest: ViewKeyScope | null = null;
  for (const scope of scopes) {
    if (!isAuditGrantScope(scope)) {
      continue;
    }
    if (widest === null || SCOPE_RANK[scope] > SCOPE_RANK[widest]) {
      widest = scope;
    }
  }
  return widest;
}

/**
 * Checks whether an effective scope satisfies a required scope.
 *
 * With `null` scope (no live grant) this is always `false` — a lapsed or
 * revoked grant never satisfies a requirement.
 *
 * @param effectiveScope - Scope in force, or `null` when nothing is live.
 * @param requiredScope  - Minimum scope the caller needs.
 */
export function auditScopeSatisfies(
  effectiveScope: ViewKeyScope | null,
  requiredScope: ViewKeyScope
): boolean {
  if (effectiveScope === null || !isAuditGrantScope(effectiveScope)) {
    return false;
  }
  return SCOPE_RANK[effectiveScope] >= SCOPE_RANK[requiredScope];
}

/**
 * Reads the effective audit grant scope and lifecycle state for every grantee
 * in a grant set.
 *
 * Grants are validated up front and grouped by grantee. For each grantee the
 * reader reports the widest scope among grants that are **active** at the
 * reference time, alongside every grant's resolved state so callers can explain
 * *why* a scope is (or is not) in force.
 *
 * @param grants - Persisted grants. May contain grants for several grantees.
 * @param now    - Optional reference time; defaults to the current time.
 * @returns A deterministic, per-grantee report.
 * @throws {ValidationError} If any grant is malformed — missing or duplicate
 *   `grantId`, unknown `scope`, unparseable timestamps, or a lifecycle whose
 *   `revokedAt`/`expiresAt` precedes `grantedAt`. Validation errors name the
 *   offending field only; they never echo scope payloads or key material.
 *
 * @example
 * ```ts
 * const report = readEffectiveAuditGrantScope(grants);
 * if (!report.allGranteesActive) {
 *   // Actionable and privacy-safe: grantee addresses are masked.
 *   console.warn(report.message);
 * }
 * ```
 */
export function readEffectiveAuditGrantScope(
  grants: AuditGrantRecord[],
  now: Date = new Date()
): AuditGrantScopeReport {
  if (!Array.isArray(grants)) {
    throw new ValidationError("Audit grants must be an array", "grants", "AUDIT_GRANTS_INVALID");
  }

  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) {
    throw new ValidationError(
      "Reference time must be a valid Date",
      "now",
      "AUDIT_GRANT_TIMESTAMP_INVALID"
    );
  }

  const byGrantee = new Map<string, ResolvedAuditGrant[]>();
  const seenGrantIds = new Set<string>();

  for (let i = 0; i < grants.length; i++) {
    const resolved = resolveGrant(grants[i], i, nowMs, seenGrantIds);
    const bucket = byGrantee.get(resolved.grantee);
    if (bucket) {
      bucket.push(resolved);
    } else {
      byGrantee.set(resolved.grantee, [resolved]);
    }
  }

  const grantees = [...byGrantee.entries()]
    .map(([grantee, resolvedGrants]) => buildEffectiveGrant(grantee, resolvedGrants))
    // Deterministic ordering: plain codepoint comparison, independent of input order.
    .sort((a, b) => (a.grantee < b.grantee ? -1 : a.grantee > b.grantee ? 1 : 0));

  const activeGrantees = grantees.filter((entry) => entry.state === "active");
  const inactiveGrantees = grantees.filter((entry) => entry.state !== "active");

  const message =
    grantees.length === 0
      ? "No audit grants to evaluate"
      : inactiveGrantees.length === 0
        ? `${grantees.length} grantee(s) hold live audit access`
        : `${inactiveGrantees.length} of ${grantees.length} grantee(s) have no live audit access: ` +
          inactiveGrantees.map((entry) => entry.redactedGrantee).join(", ");

  return {
    allGranteesActive: inactiveGrantees.length === 0,
    grantees,
    activeGrantees,
    inactiveGrantees,
    message,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Type guard for the contract's `ViewKeyScope` enum. */
function isAuditGrantScope(value: unknown): value is ViewKeyScope {
  return value === "read-only" || value === "full-audit";
}

/** Validates a single grant and resolves its lifecycle state. */
function resolveGrant(
  grant: AuditGrantRecord,
  index: number,
  nowMs: number,
  seenGrantIds: Set<string>
): ResolvedAuditGrant & { grantee: string } {
  if (typeof grant !== "object" || grant === null) {
    throw new ValidationError(
      `Audit grant at index ${index} must be an object`,
      `grants[${index}]`,
      "AUDIT_GRANT_INVALID"
    );
  }

  const grantId = grant.grantId;
  if (typeof grantId !== "string" || grantId.trim().length === 0) {
    throw new ValidationError(
      `Audit grant at index ${index} has a missing or empty grantId`,
      `grants[${index}].grantId`,
      "AUDIT_GRANT_ID_REQUIRED"
    );
  }
  if (seenGrantIds.has(grantId)) {
    throw new ValidationError(
      `Duplicate audit grant id "${grantId}"; provide at most one record per grant`,
      `grants[${index}].grantId`,
      "AUDIT_GRANT_ID_DUPLICATE"
    );
  }

  const grantee = grant.grantee;
  if (typeof grantee !== "string" || grantee.trim().length === 0) {
    throw new ValidationError(
      `Audit grant "${grantId}" has a missing or empty grantee`,
      `grants[${index}].grantee`,
      "AUDIT_GRANTEE_REQUIRED"
    );
  }

  if (!isAuditGrantScope(grant.scope)) {
    throw new ValidationError(
      `Audit grant "${grantId}" must use a known scope ("${AUDIT_GRANT_SCOPES.join('" | "')}")`,
      `grants[${index}].scope`,
      "AUDIT_GRANT_SCOPE_INVALID"
    );
  }

  const grantedAtMs = Date.parse(grant.grantedAt);
  if (Number.isNaN(grantedAtMs)) {
    throw new ValidationError(
      `Audit grant "${grantId}" has an unparseable grantedAt timestamp`,
      `grants[${index}].grantedAt`,
      "AUDIT_GRANT_TIMESTAMP_INVALID"
    );
  }

  const expiresAtMs = Date.parse(grant.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    throw new ValidationError(
      `Audit grant "${grantId}" has an unparseable expiresAt timestamp`,
      `grants[${index}].expiresAt`,
      "AUDIT_GRANT_EXPIRY_INVALID"
    );
  }
  if (expiresAtMs < grantedAtMs) {
    throw new ValidationError(
      `Audit grant "${grantId}" expires before it was granted`,
      `grants[${index}].expiresAt`,
      "AUDIT_GRANT_LIFECYCLE_INVALID"
    );
  }

  let revokedAt: string | undefined;
  let revokedAtMs: number | null = null;
  if (grant.revokedAt !== undefined && grant.revokedAt !== null) {
    revokedAtMs = Date.parse(grant.revokedAt);
    if (Number.isNaN(revokedAtMs)) {
      throw new ValidationError(
        `Audit grant "${grantId}" has an unparseable revokedAt timestamp`,
        `grants[${index}].revokedAt`,
        "AUDIT_GRANT_TIMESTAMP_INVALID"
      );
    }
    if (revokedAtMs < grantedAtMs) {
      throw new ValidationError(
        `Audit grant "${grantId}" was revoked before it was granted`,
        `grants[${index}].revokedAt`,
        "AUDIT_GRANT_LIFECYCLE_INVALID"
      );
    }
    revokedAt = grant.revokedAt;
  }

  seenGrantIds.add(grantId);

  const state: AuditGrantState =
    revokedAtMs !== null ? "revoked" : expiresAtMs <= nowMs ? "expired" : "active";

  return {
    grantee: grantee.trim(),
    grantId,
    scope: grant.scope,
    state,
    grantedBy: typeof grant.grantedBy === "string" ? grant.grantedBy : "",
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    revokedAt,
    scopeRank: SCOPE_RANK[grant.scope],
    remainingMs: state === "active" ? expiresAtMs - nowMs : null,
  };
}

/** Folds one grantee's resolved grants into its effective access entry. */
function buildEffectiveGrant(
  grantee: string,
  resolvedGrants: ResolvedAuditGrant[]
): EffectiveAuditGrant {
  // Oldest first, so `activeGrantIds` and the summary read chronologically.
  const grants = [...resolvedGrants].sort((a, b) => {
    if (a.grantedAt < b.grantedAt) {
      return -1;
    }
    return a.grantedAt > b.grantedAt
      ? 1
      : a.grantId < b.grantId
        ? -1
        : a.grantId > b.grantId
          ? 1
          : 0;
  });

  const active = grants.filter((grant) => grant.state === "active");
  const scope = selectWidestAuditScope(active.map((grant) => grant.scope));
  const state = resolveLifecycleState(grants, active.length);

  return {
    grantee,
    redactedGrantee: redactAuditorId(grantee),
    scope,
    state,
    grants,
    activeGrantIds: active.map((grant) => grant.grantId),
    grantCount: grants.length,
    latestChangeAt: latestChangeAt(grants),
    message: buildMessage(grantee, state, scope, active),
  };
}

/**
 * Derives the effective lifecycle state from a grantee's grants.
 *
 * Expiry outranks revocation when no grant is live: a lapsed grant is still
 * recoverable by re-granting, whereas `"revoked"` signals a deliberate
 * administrative action that should stay visible on the dashboard.
 */
function resolveLifecycleState(
  grants: ResolvedAuditGrant[],
  activeCount: number
): AuditGrantLifecycleState {
  if (activeCount > 0) {
    return "active";
  }
  if (grants.length === 0) {
    return "none";
  }
  return grants.some((grant) => grant.state === "expired") ? "expired" : "revoked";
}

/** Most recent lifecycle-changing timestamp across a grantee's grants. */
function latestChangeAt(grants: ResolvedAuditGrant[]): string | null {
  let latest: string | null = null;
  for (const grant of grants) {
    for (const candidate of [grant.grantedAt, grant.expiresAt, grant.revokedAt]) {
      if (candidate && (latest === null || candidate > latest)) {
        latest = candidate;
      }
    }
  }
  return latest;
}

/** Builds the privacy-safe one-line summary for a grantee's effective access. */
function buildMessage(
  grantee: string,
  state: AuditGrantLifecycleState,
  scope: ViewKeyScope | null,
  active: ResolvedAuditGrant[]
): string {
  const who = redactAuditorId(grantee);

  if (state === "active" && scope !== null) {
    const plural = active.length === 1 ? "grant" : "grants";
    const soonest = soonestActiveExpiry(active);
    return (
      `Auditor ${who}: ${scope} via ${active.length} active ${plural}` +
      (soonest === null ? "" : ` (narrowest grant expires in ${soonest})`)
    );
  }

  if (state === "expired") {
    return `Auditor ${who}: no live access — every grant has expired; issue a new grant to restore audit scope`;
  }
  if (state === "revoked") {
    return `Auditor ${who}: no live access — every grant was revoked by an administrator`;
  }
  return `Auditor ${who}: no audit grants on record`;
}

/**
 * Formats the shortest remaining lifetime among the active grants, or `null`
 * when none carries a finite window. Grantee addresses are never included.
 */
function soonestActiveExpiry(active: ResolvedAuditGrant[]): string | null {
  const remaining = active
    .map((grant) => grant.remainingMs)
    .filter((ms): ms is number => ms !== null && ms >= 0);
  if (remaining.length === 0) {
    return null;
  }
  return formatDurationMs(Math.min(...remaining));
}
