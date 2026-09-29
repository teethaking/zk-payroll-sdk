import { ValidationError } from "../src/core/errors";
import {
  AUDIT_GRANT_SCOPES,
  auditScopeSatisfies,
  readEffectiveAuditGrantScope,
  resolveAuditGrantState,
  selectWidestAuditScope,
} from "../src/audit/grantScope";
import type { AuditGrantRecord } from "../src/audit/grantScope";

/** Fixed reference time so every lifecycle assertion is deterministic. */
const NOW = new Date("2026-07-01T00:00:00.000Z");

const AUDITOR_SARAH = "GBS5ZG3ORKZB4LT6JMPMFGSHZBFV3N2R6UJWDNGJTCKX3PZZ3ZJQ4Z3JHR";
const AUDITOR_OMAR = "GA2C5RFPE6GCKMY3Z4DC6NOURMDRYZ3UMDVQ4N5ACFBPQ4E3Y3376E67";
const ADMIN = "GDNSDTGIEYJZP3DHYOEZ5WUJMZ5JDVEW7FTCFXCP3MDGXQKNGJ4XBZGWY";

/** Builds a grant with sensible defaults; override only what a test cares about. */
function grant(overrides: Partial<AuditGrantRecord> = {}): AuditGrantRecord {
  return {
    grantId: "grant-1",
    grantee: AUDITOR_SARAH,
    scope: "read-only",
    grantedBy: ADMIN,
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Main path: several live grants fold into one effective scope ────────────

describe("readEffectiveAuditGrantScope — effective scope", () => {
  it("reports the widest live scope and names the grants that produced it", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "g-ro", scope: "read-only", grantedAt: "2026-02-01T00:00:00.000Z" }),
        grant({
          grantId: "g-full",
          scope: "full-audit",
          grantedAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      NOW
    );

    expect(report.allGranteesActive).toBe(true);
    expect(report.grantees).toHaveLength(1);

    const sarah = report.grantees[0];
    expect(sarah.grantee).toBe(AUDITOR_SARAH);
    expect(sarah.scope).toBe("full-audit");
    expect(sarah.state).toBe("active");
    expect(sarah.activeGrantIds).toEqual(["g-ro", "g-full"]);
    expect(sarah.grantCount).toBe(2);
    expect(report.activeGrantees).toEqual([sarah]);
    expect(report.inactiveGrantees).toEqual([]);
  });

  it("orders grants oldest first and is independent of input order", () => {
    const ordered = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "g-ro", grantedAt: "2026-02-01T00:00:00.000Z" }),
        grant({ grantId: "g-full", scope: "full-audit", grantedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      NOW
    );
    const reversed = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "g-full", scope: "full-audit", grantedAt: "2026-03-01T00:00:00.000Z" }),
        grant({ grantId: "g-ro", grantedAt: "2026-02-01T00:00:00.000Z" }),
      ],
      NOW
    );

    expect(ordered.grantees[0].grants.map((g) => g.grantId)).toEqual(["g-ro", "g-full"]);
    expect(reversed.grantees[0].grants.map((g) => g.grantId)).toEqual(["g-ro", "g-full"]);
  });

  it("returns an empty report for an empty grant set", () => {
    const report = readEffectiveAuditGrantScope([], NOW);
    expect(report.grantees).toEqual([]);
    expect(report.allGranteesActive).toBe(true);
    expect(report.message).toBe("No audit grants to evaluate");
  });
});

// ── Edge case: a lapsed grant must never widen live access ──────────────────

describe("readEffectiveAuditGrantScope — stale grants", () => {
  it("ignores an expired wider grant when a narrower one is still live", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({
          grantId: "g-expired-full",
          scope: "full-audit",
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-06-01T00:00:00.000Z", // lapsed before NOW
        }),
        grant({ grantId: "g-live-ro", scope: "read-only" }),
      ],
      NOW
    );

    const sarah = report.grantees[0];
    expect(sarah.scope).toBe("read-only");
    expect(sarah.state).toBe("active");
    expect(sarah.activeGrantIds).toEqual(["g-live-ro"]);
    expect(sarah.grants.map((g) => g.state)).toEqual(["expired", "active"]);
  });

  it("reports no live scope once every grant has expired", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({
          grantId: "g-old",
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
      NOW
    );

    const sarah = report.grantees[0];
    expect(sarah.scope).toBeNull();
    expect(sarah.state).toBe("expired");
    expect(report.allGranteesActive).toBe(false);
    expect(report.inactiveGrantees).toHaveLength(1);
    expect(sarah.message).toMatch(/every grant has expired/);
  });

  it("treats a grant expiring at exactly the reference time as expired", () => {
    const report = readEffectiveAuditGrantScope(
      [grant({ grantId: "g-edge", expiresAt: NOW.toISOString() })],
      NOW
    );
    expect(report.grantees[0].state).toBe("expired");
    expect(report.grantees[0].scope).toBeNull();
  });

  it("ignores a revoked wider grant in favour of a live narrower one", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({
          grantId: "g-revoked-full",
          scope: "full-audit",
          revokedAt: "2026-05-01T00:00:00.000Z",
        }),
        grant({ grantId: "g-live-ro" }),
      ],
      NOW
    );

    const sarah = report.grantees[0];
    expect(sarah.scope).toBe("read-only");
    expect(sarah.state).toBe("active");
    expect(sarah.grants.find((g) => g.grantId === "g-revoked-full")?.state).toBe("revoked");
  });

  it("reports revoked when no live grant remains and none expired by time", () => {
    const report = readEffectiveAuditGrantScope(
      [grant({ grantId: "g-revoked", revokedAt: "2026-04-01T00:00:00.000Z" })],
      NOW
    );

    const sarah = report.grantees[0];
    expect(sarah.state).toBe("revoked");
    expect(sarah.scope).toBeNull();
    expect(sarah.message).toMatch(/every grant was revoked/);
  });

  it("prefers expired over revoked when a grantee has both terminal states", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({
          grantId: "g-revoked",
          revokedAt: "2026-04-01T00:00:00.000Z",
        }),
        grant({
          grantId: "g-expired",
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      NOW
    );

    expect(report.grantees[0].state).toBe("expired");
  });
});

// ── Multi-grantee reporting ─────────────────────────────────────────────────

describe("readEffectiveAuditGrantScope — multiple grantees", () => {
  it("partitions grants per grantee and sorts deterministically", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "sarah-ro", grantee: AUDITOR_SARAH }),
        grant({
          grantId: "omar-full",
          grantee: AUDITOR_OMAR,
          scope: "full-audit",
        }),
      ],
      NOW
    );

    expect(report.grantees.map((g) => g.grantee)).toEqual([AUDITOR_OMAR, AUDITOR_SARAH]);
    expect(report.allGranteesActive).toBe(true);
    expect(report.message).toBe("2 grantee(s) hold live audit access");
  });

  it("flags a mixed report and names only the inactive grantees", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "sarah-ro", grantee: AUDITOR_SARAH }),
        grant({
          grantId: "omar-expired",
          grantee: AUDITOR_OMAR,
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      NOW
    );

    expect(report.allGranteesActive).toBe(false);
    expect(report.activeGrantees.map((g) => g.grantee)).toEqual([AUDITOR_SARAH]);
    expect(report.inactiveGrantees.map((g) => g.grantee)).toEqual([AUDITOR_OMAR]);
    expect(report.message).toContain("1 of 2 grantee(s) have no live audit access");
  });
});

// ── Privacy: messages must be safe to log verbatim ──────────────────────────

describe("readEffectiveAuditGrantScope — privacy", () => {
  it("masks grantee addresses in every message", () => {
    const report = readEffectiveAuditGrantScope(
      [
        grant({ grantId: "sarah-ro", grantee: AUDITOR_SARAH }),
        grant({
          grantId: "omar-expired",
          grantee: AUDITOR_OMAR,
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      NOW
    );

    expect(report.message).not.toContain(AUDITOR_OMAR);
    expect(report.message).toContain(report.grantees[0].redactedGrantee);
    for (const entry of report.grantees) {
      expect(entry.message).not.toContain(entry.grantee);
      expect(entry.message).toContain("Auditor ");
    }
  });

  it("drops credential material carried on the source record", () => {
    // A persisted `ViewKey` row often also holds the shareable token; the
    // reader must copy across only the grant metadata it documents.
    const withSecrets = {
      ...grant(),
      keyId: "vk_a3f9bc12de45",
      secretKey: "SBTZ4VAOX5VSNVWZHPW6GWCRNGMVWTUK3BFLJQTKMLV4WQ2TCKJQBSA",
    } as AuditGrantRecord;

    const serialized = JSON.stringify(readEffectiveAuditGrantScope([withSecrets], NOW));

    expect(serialized).not.toContain("keyId");
    expect(serialized).not.toContain("vk_a3f9bc12de45");
    expect(serialized).not.toContain("SBTZ4VAOX5VSNVWZHPW6GWCRNGMVWTUK3BFLJQTKMLV4WQ2TCKJQBSA");
  });

  it("keeps validation errors free of grant payload values", () => {
    try {
      readEffectiveAuditGrantScope(
        [grant({ grantId: "bad", scope: "everything" as AuditGrantRecord["scope"] })],
        NOW
      );
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe("AUDIT_GRANT_SCOPE_INVALID");
      expect((error as ValidationError).field).toBe("grants[0].scope");
      expect((error as ValidationError).message).not.toContain(ADMIN);
    }
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("readEffectiveAuditGrantScope — validation", () => {
  const expectCode = (fn: () => unknown, code: string): void => {
    expect(fn).toThrow(ValidationError);
    try {
      fn();
    } catch (error) {
      expect((error as ValidationError).code).toBe(code);
    }
  };

  it("rejects a non-array grant set", () => {
    expectCode(
      () => readEffectiveAuditGrantScope({} as unknown as AuditGrantRecord[], NOW),
      "AUDIT_GRANTS_INVALID"
    );
  });

  it("rejects a non-object grant entry", () => {
    expectCode(
      () => readEffectiveAuditGrantScope([null as unknown as AuditGrantRecord], NOW),
      "AUDIT_GRANT_INVALID"
    );
  });

  it("rejects missing or duplicate grant ids", () => {
    expectCode(
      () => readEffectiveAuditGrantScope([grant({ grantId: "" })], NOW),
      "AUDIT_GRANT_ID_REQUIRED"
    );
    expectCode(
      () =>
        readEffectiveAuditGrantScope([grant({ grantId: "dup" }), grant({ grantId: "dup" })], NOW),
      "AUDIT_GRANT_ID_DUPLICATE"
    );
  });

  it("rejects a missing grantee", () => {
    expectCode(
      () => readEffectiveAuditGrantScope([grant({ grantee: "   " })], NOW),
      "AUDIT_GRANTEE_REQUIRED"
    );
  });

  it("rejects unknown scopes", () => {
    expectCode(
      () =>
        readEffectiveAuditGrantScope(
          [grant({ scope: "full-payroll" as AuditGrantRecord["scope"] })],
          NOW
        ),
      "AUDIT_GRANT_SCOPE_INVALID"
    );
  });

  it("rejects unparseable timestamps", () => {
    expectCode(
      () => readEffectiveAuditGrantScope([grant({ grantedAt: "not-a-date" })], NOW),
      "AUDIT_GRANT_TIMESTAMP_INVALID"
    );
    expectCode(
      () => readEffectiveAuditGrantScope([grant({ expiresAt: "" })], NOW),
      "AUDIT_GRANT_EXPIRY_INVALID"
    );
    expectCode(
      () => readEffectiveAuditGrantScope([grant({ revokedAt: "soon" })], NOW),
      "AUDIT_GRANT_TIMESTAMP_INVALID"
    );
  });

  it("rejects an impossible lifecycle", () => {
    expectCode(
      () =>
        readEffectiveAuditGrantScope(
          [
            grant({
              grantedAt: "2026-05-01T00:00:00.000Z",
              expiresAt: "2026-04-01T00:00:00.000Z",
            }),
          ],
          NOW
        ),
      "AUDIT_GRANT_LIFECYCLE_INVALID"
    );
    expectCode(
      () =>
        readEffectiveAuditGrantScope(
          [
            grant({
              grantedAt: "2026-05-01T00:00:00.000Z",
              revokedAt: "2026-04-01T00:00:00.000Z",
            }),
          ],
          NOW
        ),
      "AUDIT_GRANT_LIFECYCLE_INVALID"
    );
  });
});

// ── Single-grant and scope helpers ──────────────────────────────────────────

describe("resolveAuditGrantState", () => {
  it("classifies live, expired, and revoked grants", () => {
    expect(resolveAuditGrantState(grant(), NOW)).toBe("active");
    expect(resolveAuditGrantState(grant({ expiresAt: "2026-02-01T00:00:00.000Z" }), NOW)).toBe(
      "expired"
    );
    expect(resolveAuditGrantState(grant({ revokedAt: "2026-05-01T00:00:00.000Z" }), NOW)).toBe(
      "revoked"
    );
  });

  it("ranks revocation above expiry", () => {
    const both = grant({
      expiresAt: "2026-02-01T00:00:00.000Z",
      revokedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(resolveAuditGrantState(both, NOW)).toBe("revoked");
  });
});

describe("selectWidestAuditScope", () => {
  it("returns the widest scope, or null when there is none", () => {
    expect(selectWidestAuditScope([])).toBeNull();
    expect(selectWidestAuditScope(["read-only"])).toBe("read-only");
    expect(selectWidestAuditScope(["read-only", "full-audit"])).toBe("full-audit");
    expect(selectWidestAuditScope(["full-audit", "read-only"])).toBe("full-audit");
  });
});

describe("auditScopeSatisfies", () => {
  it("requires at least the requested scope", () => {
    expect(auditScopeSatisfies("full-audit", "read-only")).toBe(true);
    expect(auditScopeSatisfies("full-audit", "full-audit")).toBe(true);
    expect(auditScopeSatisfies("read-only", "full-audit")).toBe(false);
  });

  it("never treats a lapsed grant as satisfying a requirement", () => {
    expect(auditScopeSatisfies(null, "read-only")).toBe(false);
  });
});

describe("AUDIT_GRANT_SCOPES", () => {
  it("lists exactly the contract scopes, narrowest first", () => {
    expect(AUDIT_GRANT_SCOPES).toEqual(["read-only", "full-audit"]);
  });
});
