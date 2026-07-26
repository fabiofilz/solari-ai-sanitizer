import { describe, expect, it } from "vitest";
import {
  buildCanonicalAdvisoryIndex,
  evaluateAuditReports,
  evaluateGhsaEligibility,
  hasCompatibleFix,
  resolveLeafAdvisoryIds,
} from "../../../scripts/audit-check.mjs";

// Waiver-policy gate for scripts/audit-check.mjs. Written and confirmed to
// fail before audit-check.mjs exported any of these functions at all -
// the current script only executes a CLI side effect (a real `npm audit`
// call plus a possible process.exit(1)) at import time and exposes nothing
// importable, so this file could not even load, let alone assert anything.
//
// GHSA ids below are synthetic (`GHSA-aaaa-...`, `GHSA-bbbb-...`) - none of
// these tests depend on any specific real advisory, so the eventual
// GHSA-mh99-v99m-4gvg brace-expansion waiver in audit-waivers.json is never
// referenced here.

function makeReport(vulnerabilities: Record<string, unknown>) {
  return { vulnerabilities };
}

function advisoryEntry(ghsaId: string, severity = "high") {
  return {
    source: 1,
    name: "synthetic",
    dependency: "synthetic",
    title: "synthetic advisory",
    url: `https://github.com/advisories/${ghsaId}`,
    severity,
    range: "*",
  };
}

function waiverFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    package: "synthetic",
    reason: "synthetic dev-only fixture with no compatible non-major fix",
    devOnly: true,
    noCompatibleFixConfirmedAt: "2026-07-24",
    expires: "2026-08-07",
    ...overrides,
  };
}

const TODAY = "2026-07-24";
const emptyReport = makeReport({});

describe("hasCompatibleFix", () => {
  it("treats bare true as a compatible fix", () => {
    expect(hasCompatibleFix({ fixAvailable: true })).toBe(true);
  });

  it("treats false as no compatible fix", () => {
    expect(hasCompatibleFix({ fixAvailable: false })).toBe(false);
  });

  it("treats isSemVerMajor: false as a compatible fix", () => {
    expect(hasCompatibleFix({ fixAvailable: { isSemVerMajor: false } })).toBe(true);
  });

  it("treats isSemVerMajor: true as no compatible fix", () => {
    expect(hasCompatibleFix({ fixAvailable: { isSemVerMajor: true } })).toBe(false);
  });

  it("fails closed (treats as a compatible fix) when fixAvailable is an object missing isSemVerMajor", () => {
    expect(hasCompatibleFix({ fixAvailable: { name: "pkg", version: "1.0.0" } })).toBe(true);
  });

  it("fails closed (treats as a compatible fix) for an unrecognized fixAvailable shape", () => {
    expect(hasCompatibleFix({ fixAvailable: undefined })).toBe(true);
    expect(hasCompatibleFix({ fixAvailable: null })).toBe(true);
  });
});

describe("resolveLeafAdvisoryIds", () => {
  it("resolves a multi-hop chain of string via-references down to its leaf GHSA", () => {
    const report = makeReport({
      leaf: {
        name: "leaf",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
      mid: { name: "mid", severity: "high", fixAvailable: false, via: ["leaf"] },
      top: { name: "top", severity: "high", fixAvailable: false, via: ["mid"] },
    });
    expect([...resolveLeafAdvisoryIds(report, "top")]).toEqual(["GHSA-aaaa-aaaa-aaaa"]);
  });

  it("does not drop an advisory id when a descendant is reached from two unrelated top-level nodes", () => {
    const report = makeReport({
      shared: {
        name: "shared",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-dddd-dddd-dddd")],
      },
      x: { name: "x", severity: "high", fixAvailable: false, via: ["shared"] },
      y: { name: "y", severity: "high", fixAvailable: false, via: ["shared"] },
    });
    expect([...resolveLeafAdvisoryIds(report, "x")]).toEqual(["GHSA-dddd-dddd-dddd"]);
    expect([...resolveLeafAdvisoryIds(report, "y")]).toEqual(["GHSA-dddd-dddd-dddd"]);
  });

  it("terminates safely on a circular via reference instead of recursing forever", () => {
    const report = makeReport({
      a: { name: "a", severity: "high", fixAvailable: false, via: ["b"] },
      b: { name: "b", severity: "high", fixAvailable: false, via: ["a"] },
    });
    expect([...resolveLeafAdvisoryIds(report, "a")]).toEqual([]);
  });
});

describe("evaluateAuditReports waiver policy", () => {
  it("does not suppress a node whose leaf advisory is a different GHSA than the one waived", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-bbbb-bbbb-bbbb")] },
      today: TODAY,
    });
    expect(result.unwaived.map((v: { name: string }) => v.name)).toEqual(["pkg"]);
    expect(result.waived).toEqual([]);
  });

  it("never waives a critical-severity node even with a matching waiver", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "critical",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa", "critical")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
  });

  it("never waives a node with fixAvailable: true (bare boolean)", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: true,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
  });

  it("never waives a node whose fixAvailable object has isSemVerMajor: false", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: { name: "pkg", version: "2.0.0", isSemVerMajor: false },
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
  });

  it("allows waiving a node whose fixAvailable object has isSemVerMajor: true", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: { name: "pkg", version: "9.0.0", isSemVerMajor: true },
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toEqual([]);
    expect(result.waived).toHaveLength(1);
    expect(result.waived[0]).toMatchObject({ package: "pkg", severity: "high" });
  });

  it("preserves the existing fixAvailable: false waiver behavior", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toEqual([]);
    expect(result.waived).toHaveLength(1);
  });

  it("fails when only some of a node's leaf advisories are waived (partial coverage)", () => {
    const report = makeReport({
      // leafOne/leafTwo are "moderate" (non-actionable) so only "top" is
      // independently evaluated here — they exist purely to contribute their
      // advisory ids to "top"'s resolved leaf set via the via-chain below.
      leafOne: {
        name: "leafOne",
        severity: "moderate",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
      leafTwo: {
        name: "leafTwo",
        severity: "moderate",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-bbbb-bbbb-bbbb")],
      },
      top: { name: "top", severity: "high", fixAvailable: false, via: ["leafOne", "leafTwo"] },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived.map((v: { name: string }) => v.name)).toEqual(["top"]);
    expect(result.waived).toEqual([]);
  });

  it("fails an expired waiver and reports it as expired", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa", { expires: "2026-01-01" })] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
    expect(result.expiredWaivers).toHaveLength(1);
  });

  it("fails a malformed waiver (missing reason) and never treats it as active", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformed = waiverFor("GHSA-aaaa-aaaa-aaaa", { reason: "" });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [malformed] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
    expect(result.invalidWaivers).toHaveLength(1);
  });

  it("fails a malformed waiver (devOnly not true) and never treats it as active", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformed = waiverFor("GHSA-aaaa-aaaa-aaaa", { devOnly: false });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [malformed] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.invalidWaivers).toHaveLength(1);
  });

  it("rejects an otherwise-matching waiver when its GHSA is present anywhere in the production audit", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const prodReport = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
    expect(result.blockedWaivers).toHaveLength(1);
  });

  it("never waives a node whose fixAvailable object is missing isSemVerMajor (fails closed)", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: { name: "pkg", version: "1.0.0" },
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
  });

  it("fails when a node's via resolves to zero leaf advisory ids (never waivable by default)", () => {
    const report = makeReport({
      // via references a package name absent from this report, so it
      // resolves to no advisory objects at all — must not be treated as
      // "fully covered by zero required waivers".
      pkg: { name: "pkg", severity: "high", fixAvailable: false, via: ["nonexistent-package"] },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
  });

  it("fails a malformed waiver whose id is not a single GHSA identifier", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformed = waiverFor("GHSA-aaaa-aaaa-aaaa, GHSA-bbbb-bbbb-bbbb");
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [malformed] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.invalidWaivers).toHaveLength(1);
  });

  it("fails a malformed waiver with an invalid noCompatibleFixConfirmedAt date", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformed = waiverFor("GHSA-aaaa-aaaa-aaaa", {
      noCompatibleFixConfirmedAt: "not-a-date",
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [malformed] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.invalidWaivers).toHaveLength(1);
  });

  it("fails a malformed waiver with an invalid expires date", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformed = waiverFor("GHSA-aaaa-aaaa-aaaa", { expires: "2026-13-40" });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [malformed] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.invalidWaivers).toHaveLength(1);
  });

  it("fails closed and blocks every active waiver when the production report itself is malformed", () => {
    const report = makeReport({
      pkg: {
        name: "pkg",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
    });
    const malformedProdReport = { error: "npm audit --omit=dev failed unexpectedly" };
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: malformedProdReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toHaveLength(1);
    expect(result.waived).toEqual([]);
    expect(result.blockedWaivers).toHaveLength(1);
    expect(result.productionAuditInvalid).toBe(true);
  });
});

describe("canonical leaf-advisory-source eligibility", () => {
  it("waives a downstream node reporting fixAvailable: true when its canonical leaf source has only a major fix", () => {
    // Mirrors the real-world case: npm's own aggregate fixAvailable for a
    // downstream package (e.g. glob/rimraf) can non-deterministically say
    // "true" even though the only real cause is a source package (e.g.
    // brace-expansion) with no compatible fix. Eligibility must be decided
    // by the canonical source, not this misleading downstream value.
    const report = makeReport({
      source: {
        name: "source",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
      downstream: {
        name: "downstream",
        severity: "high",
        fixAvailable: true,
        via: ["source"],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toEqual([]);
    expect(result.waived.map((w: { package: string }) => w.package).sort()).toEqual([
      "downstream",
      "source",
    ]);
  });

  it("does not waive a downstream node reporting isSemVerMajor: true when its canonical leaf source has a compatible fix", () => {
    const report = makeReport({
      source: {
        name: "source",
        severity: "high",
        fixAvailable: true,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
      downstream: {
        name: "downstream",
        severity: "high",
        fixAvailable: { name: "source", version: "9.0.0", isSemVerMajor: true },
        via: ["source"],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      // A waiver exists, but must never apply: the canonical source has a
      // genuinely compatible fix, so this GHSA is never waiver-eligible.
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived.map((v: { name: string }) => v.name).sort()).toEqual([
      "downstream",
      "source",
    ]);
    expect(result.waived).toEqual([]);
  });

  it("fails closed when a resolved GHSA has no canonical source node", () => {
    const canonicalIndex = new Map(); // deliberately empty - GHSA is unmapped
    const report = makeReport({});
    const result = evaluateGhsaEligibility(report, "GHSA-zzzz-zzzz-zzzz", canonicalIndex);
    expect(result.eligible).toBe(false);
  });

  it("fails closed end-to-end when a leaf GHSA is missing from the canonical index", () => {
    // via embeds an advisory whose `source` id is used as a fallback
    // synthetic id (no GHSA url), but the report never actually contains a
    // node with that source id as a proper key — simulating a report where
    // resolution outpaces the canonical index somehow.
    const report = makeReport({
      top: {
        name: "top",
        severity: "high",
        fixAvailable: false,
        via: [
          {
            source: 999999,
            name: "top",
            dependency: "top",
            title: "advisory with no GHSA url",
            url: "",
            severity: "high",
            range: "*",
          },
        ],
      },
    });
    // The canonical index is built from the same report, so under normal
    // operation this id (`source:999999`) IS present (top embeds it
    // directly) - this test instead directly proves the defensive branch
    // fires when asked about an id absent from a given index.
    const index = buildCanonicalAdvisoryIndex(report);
    expect(index.has("source:999999")).toBe(true);
    const missingResult = evaluateGhsaEligibility(report, "source:does-not-exist", index);
    expect(missingResult.eligible).toBe(false);
  });

  it("fails closed when two canonical sources for the same GHSA disagree on eligibility", () => {
    const report = makeReport({
      sourceA: {
        name: "sourceA",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-cccc-cccc-cccc")],
      },
      sourceB: {
        name: "sourceB",
        severity: "high",
        fixAvailable: true,
        via: [advisoryEntry("GHSA-cccc-cccc-cccc")],
      },
      top: {
        name: "top",
        severity: "high",
        fixAvailable: false,
        via: ["sourceA", "sourceB"],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-cccc-cccc-cccc")] },
      today: TODAY,
    });
    // sourceA, sourceB, and top all resolve to the same disputed GHSA and
    // must all stay unwaived - conflicting canonical sources block the
    // whole GHSA, not just the node that happened to trigger the check.
    expect(result.unwaived.map((v: { name: string }) => v.name).sort()).toEqual([
      "sourceA",
      "sourceB",
      "top",
    ]);
    expect(result.waived).toEqual([]);
  });

  it("waives multiple independent downstream nodes resolving to the same eligible canonical leaf consistently", () => {
    const report = makeReport({
      source: {
        name: "source",
        severity: "high",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa")],
      },
      downstreamOne: {
        name: "downstreamOne",
        severity: "high",
        fixAvailable: true,
        via: ["source"],
      },
      downstreamTwo: {
        name: "downstreamTwo",
        severity: "high",
        fixAvailable: { name: "source", version: "2.0.0", isSemVerMajor: true },
        via: ["source"],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.unwaived).toEqual([]);
    expect(result.waived.map((w: { package: string }) => w.package).sort()).toEqual([
      "downstreamOne",
      "downstreamTwo",
      "source",
    ]);
  });

  it("never waives a downstream node whose canonical leaf source is critical severity, even if the downstream node is high", () => {
    const report = makeReport({
      source: {
        name: "source",
        severity: "critical",
        fixAvailable: false,
        via: [advisoryEntry("GHSA-aaaa-aaaa-aaaa", "critical")],
      },
      downstream: {
        name: "downstream",
        severity: "high",
        fixAvailable: false,
        via: ["source"],
      },
    });
    const result = evaluateAuditReports({
      fullReport: report,
      prodReport: emptyReport,
      waiversRaw: { waivers: [waiverFor("GHSA-aaaa-aaaa-aaaa")] },
      today: TODAY,
    });
    expect(result.waived).toEqual([]);
    expect(result.unwaived.map((v: { name: string }) => v.name)).toContain("downstream");
  });
});
