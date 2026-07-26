#!/usr/bin/env node
// Dependency-vulnerability audit gate (constitution Principle VI).
// Fails the build on any actionable (fixable) high/critical advisory. A
// vulnerability with no available fix may only be waived via a reviewed
// entry in audit-waivers.json naming the advisory ID, the justification, and
// an expiry date — after which the waiver must be re-justified or this gate
// fails again. Never silently suppressed.
//
// Waiver policy (see specs/... audit-waiver design):
// - Critical severity is never waivable, regardless of waiver-file content.
// - Only "high" severity is waiver-eligible at all.
// - `fixAvailable === true`, or an object with `isSemVerMajor: false`, means
//   a genuinely compatible (non-major) fix exists and is never waivable —
//   this is a structural check on the boolean/object shape, never on the
//   suggested package name/version or any free-text output, both of which
//   are unstable between runs.
// - A node's `via` may reference sibling nodes by plain package-name string
//   instead of embedding the advisory directly; those references are
//   resolved recursively to their leaf GHSA id(s), with path-specific cycle
//   protection so a shared descendant reached from two independent nodes is
//   never dropped for either one.
// - A node is only waived if *every* leaf advisory id it resolves to has an
//   active waiver — partial coverage still fails.
// - A waiver whose GHSA id is present anywhere in the production-only audit
//   (`npm audit --omit=dev`) is never usable, even if it would otherwise
//   match a dev-only node in the full audit.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WAIVERS_PATH = "audit-waivers.json";
const ACTIONABLE_SEVERITIES = new Set(["high", "critical"]);
const WAIVABLE_SEVERITIES = new Set(["high"]);
const GHSA_ID_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value) {
  return typeof value === "string" && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// Structural validation only — never trusts the waiver file to be
// well-formed. A malformed entry is reported and treated as inactive, never
// silently accepted.
function validateWaiverShape(waiver) {
  const errors = [];
  if (typeof waiver.id !== "string" || !GHSA_ID_PATTERN.test(waiver.id)) {
    errors.push("id must be a single GHSA advisory identifier");
  }
  if (typeof waiver.package !== "string" || waiver.package.length === 0) {
    errors.push("package must be a non-empty string");
  }
  if (typeof waiver.reason !== "string" || waiver.reason.trim().length === 0) {
    errors.push("reason must be a non-empty string");
  }
  if (waiver.devOnly !== true) {
    errors.push("devOnly must be true");
  }
  if (!isValidDateString(waiver.noCompatibleFixConfirmedAt)) {
    errors.push("noCompatibleFixConfirmedAt must be a valid YYYY-MM-DD date");
  }
  if (!isValidDateString(waiver.expires)) {
    errors.push("expires must be a valid YYYY-MM-DD date");
  }
  return errors;
}

// Parses raw waiver-file JSON into active / expired / invalid buckets. Pure
// function of (data, today) so it can be unit-tested without touching disk.
export function loadWaiversFromData(raw, today) {
  const active = new Map();
  const expired = [];
  const invalid = [];
  for (const waiver of raw.waivers ?? []) {
    const errors = validateWaiverShape(waiver);
    if (errors.length > 0) {
      invalid.push({ waiver, errors });
      continue;
    }
    if (waiver.expires < today) {
      expired.push(waiver);
    } else {
      active.set(waiver.id, waiver);
    }
  }
  return { active, expired, invalid };
}

function runAudit(extraArgs = []) {
  // execSync (not execFileSync) so this resolves through the OS shell — on
  // Windows, npm is the "npm.cmd" shim, which requires shell resolution to
  // run at all; execFileSync without shell:true cannot find/execute it there.
  const command = ["npm audit --json", ...extraArgs].join(" ");
  try {
    const out = execSync(command, { encoding: "utf8" });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found; stdout still has the report.
    if (err.stdout) {
      return JSON.parse(err.stdout);
    }
    throw err;
  }
}

// A fix is "compatible" (never waivable) when npm's audit report says so
// structurally: a bare `true`, or a suggestion object whose `isSemVerMajor`
// is anything other than exactly `true` (including an object that omits the
// field). Only a bare `false`, or an object with `isSemVerMajor: true`,
// counts as "no compatible fix". Any other/unrecognized shape (missing
// field, non-boolean fixAvailable, etc.) fails closed as "has a compatible
// fix" so an unexpected shape can never become waiver-eligible by default.
export function hasCompatibleFix(vuln) {
  if (vuln.fixAvailable === false) return false;
  if (typeof vuln.fixAvailable === "object" && vuln.fixAvailable !== null) {
    return vuln.fixAvailable.isSemVerMajor !== true;
  }
  return true;
}

// Resolves a vulnerability node's `via` entries to the set of leaf GHSA ids
// (or synthetic `source:<id>` ids when no GHSA URL is present) it ultimately
// depends on, following string references into sibling nodes of the same
// report. `pathStack` is copied (not mutated) on each recursive call, so
// cycle protection is path-specific: a node revisited via a different,
// non-cyclic branch is still fully resolved, and its advisory ids are never
// dropped just because some unrelated branch touched it first.
export function resolveLeafAdvisoryIds(report, name, pathStack = new Set()) {
  if (pathStack.has(name)) return new Set();
  const nextStack = new Set(pathStack);
  nextStack.add(name);

  const node = report.vulnerabilities?.[name];
  const ids = new Set();
  for (const entry of node?.via ?? []) {
    if (typeof entry === "object" && entry !== null) {
      const match = /GHSA-[a-z0-9-]+/i.exec(entry.url ?? "");
      ids.add(match ? match[0] : `source:${String(entry.source)}`);
    } else if (typeof entry === "string" && report.vulnerabilities?.[entry]) {
      for (const id of resolveLeafAdvisoryIds(report, entry, nextStack)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

// Maps each GHSA (or synthetic source:<id>) to the name(s) of every node
// that embeds it directly as an advisory object in its own `via` — the
// canonical, authoritative source(s) for that advisory. A downstream/
// aggregate node's `via` typically only references the canonical source by
// plain string, so this index is the only reliable place to read whether a
// given advisory itself has a compatible fix: npm's own `fixAvailable` on an
// aggregate node reflects a graph-wide resolution simulation that can be
// non-deterministic run-to-run even when the underlying advisory and its fix
// status haven't changed at all.
export function buildCanonicalAdvisoryIndex(report) {
  const index = new Map();
  for (const [name, node] of Object.entries(report.vulnerabilities ?? {})) {
    for (const entry of node.via ?? []) {
      if (typeof entry === "object" && entry !== null) {
        const match = /GHSA-[a-z0-9-]+/i.exec(entry.url ?? "");
        const id = match ? match[0] : `source:${String(entry.source)}`;
        if (!index.has(id)) index.set(id, new Set());
        index.get(id).add(name);
      }
    }
  }
  return index;
}

// Decides whether a single GHSA is waiver-eligible using only its canonical
// source node(s) — never the downstream/aggregate node that happened to
// resolve to it. Fails closed (not eligible) if: the GHSA has no canonical
// source in this report at all; any canonical source is critical severity;
// any canonical source has a compatible fix (hasCompatibleFix); or multiple
// canonical sources disagree with each other on eligibility (an inconsistent
// report should never be trusted enough to waive).
export function evaluateGhsaEligibility(report, ghsaId, canonicalIndex) {
  const sourceNames = canonicalIndex.get(ghsaId);
  if (!sourceNames || sourceNames.size === 0) {
    return { ghsaId, eligible: false, reason: "missing-canonical-source" };
  }

  let sawEligible = false;
  let sawIneligible = false;
  for (const name of sourceNames) {
    const sourceNode = report.vulnerabilities?.[name];
    const ineligible =
      !sourceNode || sourceNode.severity === "critical" || hasCompatibleFix(sourceNode);
    if (ineligible) {
      sawIneligible = true;
    } else {
      sawEligible = true;
    }
  }

  if (sawEligible && sawIneligible) {
    return { ghsaId, eligible: false, reason: "conflicting-canonical-sources" };
  }
  if (sawIneligible) {
    return { ghsaId, eligible: false, reason: "canonical-source-not-eligible" };
  }
  return { ghsaId, eligible: true, reason: null };
}

// A production audit report is only trustworthy if it has the shape npm
// audit --json actually produces. Anything else (a degraded/partial
// response that still parses as JSON, an unsupported-flag error payload,
// etc.) must never be silently treated as "no production vulnerabilities" —
// that would let the production cross-check fail open exactly where it
// matters most.
function isValidAuditReport(report) {
  return (
    typeof report === "object" &&
    report !== null &&
    typeof report.vulnerabilities === "object" &&
    report.vulnerabilities !== null
  );
}

function collectAllLeafAdvisoryIds(report) {
  const ids = new Set();
  for (const name of Object.keys(report.vulnerabilities ?? {})) {
    for (const id of resolveLeafAdvisoryIds(report, name)) {
      ids.add(id);
    }
  }
  return ids;
}

// Splits the active-waiver map into those safe to use and those blocked
// because their GHSA id is present anywhere in the production-only audit —
// a waiver justified as "dev-only" must never end up suppressing something
// that is also reachable from production dependencies.
function partitionWaiversByProductionPresence(activeWaivers, productionAdvisoryIds) {
  const usable = new Map();
  const blocked = [];
  for (const [id, waiver] of activeWaivers) {
    if (productionAdvisoryIds.has(id)) {
      blocked.push(waiver);
    } else {
      usable.set(id, waiver);
    }
  }
  return { usable, blocked };
}

// Pure evaluation core: takes already-parsed audit reports and waiver data,
// returns the full decision breakdown. No file/process I/O, so this is
// directly unit-testable.
export function evaluateAuditReports({
  fullReport,
  prodReport,
  waiversRaw,
  today = todayString(),
}) {
  const { active, expired, invalid } = loadWaiversFromData(waiversRaw, today);
  const productionReportValid = isValidAuditReport(prodReport);

  // Fail closed: if the production-only audit report itself could not be
  // validated, no waiver can be trusted as production-safe — block every
  // active waiver rather than silently falling back to an empty production
  // advisory set (which would make every waiver look production-safe).
  let activeWaivers;
  let blockedWaivers;
  if (productionReportValid) {
    const productionAdvisoryIds = collectAllLeafAdvisoryIds(prodReport);
    ({ usable: activeWaivers, blocked: blockedWaivers } = partitionWaiversByProductionPresence(
      active,
      productionAdvisoryIds,
    ));
  } else {
    activeWaivers = new Map();
    blockedWaivers = [...active.values()];
  }

  const canonicalIndex = buildCanonicalAdvisoryIndex(fullReport);

  const unwaived = [];
  const waived = [];
  const canonicalIssues = [];

  for (const vuln of Object.values(fullReport.vulnerabilities ?? {})) {
    if (!ACTIONABLE_SEVERITIES.has(vuln.severity)) continue;

    // Eligibility is decided entirely at the canonical leaf-advisory
    // source(s) — this node's own `fixAvailable` is never consulted here,
    // since npm computes it per-node via a graph-wide simulation that can
    // disagree run-to-run for the same underlying, unchanged advisory.
    if (WAIVABLE_SEVERITIES.has(vuln.severity)) {
      const advisoryIds = [...resolveLeafAdvisoryIds(fullReport, vuln.name)];
      const eligibilities = advisoryIds.map((id) =>
        evaluateGhsaEligibility(fullReport, id, canonicalIndex),
      );
      const allEligible = advisoryIds.length > 0 && eligibilities.every((e) => e.eligible);

      if (allEligible) {
        const matchedWaivers = advisoryIds.map((id) => activeWaivers.get(id));
        const allCovered = matchedWaivers.every(Boolean);
        if (allCovered) {
          waived.push({ package: vuln.name, severity: vuln.severity, waiver: matchedWaivers[0] });
          continue;
        }
      } else {
        for (const eligibility of eligibilities) {
          if (!eligibility.eligible) {
            canonicalIssues.push({ package: vuln.name, ...eligibility });
          }
        }
      }
    }

    unwaived.push(vuln);
  }

  return {
    waived,
    canonicalIssues,
    unwaived,
    expiredWaivers: expired,
    invalidWaivers: invalid,
    blockedWaivers,
    productionAuditInvalid: !productionReportValid,
  };
}

function main() {
  const waiversRaw = JSON.parse(readFileSync(WAIVERS_PATH, "utf8"));
  const fullReport = runAudit();
  const prodReport = runAudit(["--omit=dev"]);
  const result = evaluateAuditReports({ fullReport, prodReport, waiversRaw });

  if (result.productionAuditInvalid) {
    console.error(
      "Production-only audit (npm audit --omit=dev) did not return a valid report — " +
        "every active waiver is blocked until this can be re-verified.",
    );
  }

  if (result.invalidWaivers.length > 0) {
    console.error("Malformed audit waiver(s) — never treated as active:");
    for (const { waiver, errors } of result.invalidWaivers) {
      console.error(`  - ${JSON.stringify(waiver.id ?? waiver)}: ${errors.join("; ")}`);
    }
  }

  if (result.blockedWaivers.length > 0) {
    console.error("Audit waiver(s) blocked — GHSA present in the production-only audit:");
    for (const w of result.blockedWaivers) {
      console.error(`  - ${w.id}: dev-only waiver cannot cover a production-reachable advisory`);
    }
  }

  if (result.expiredWaivers.length > 0) {
    console.error("Audit waiver(s) expired and must be re-justified:");
    for (const w of result.expiredWaivers) {
      console.error(`  - ${w.id} (expired ${w.expires}): ${w.reason}`);
    }
  }

  if (result.canonicalIssues.length > 0) {
    console.error("Advisories blocked at their canonical source (never eligible for waiver):");
    for (const issue of result.canonicalIssues) {
      console.error(`  - ${issue.package} via ${issue.ghsaId}: ${issue.reason}`);
    }
  }

  if (result.waived.length > 0) {
    console.log("Waived advisories (no compatible fix available, reviewed waiver on file):");
    for (const w of result.waived) {
      console.log(
        `  - ${w.package} [${w.severity}] waived by ${w.waiver.id}, expires ${w.waiver.expires}`,
      );
    }
  }

  const failed =
    result.unwaived.length > 0 ||
    result.expiredWaivers.length > 0 ||
    result.invalidWaivers.length > 0 ||
    result.blockedWaivers.length > 0 ||
    result.productionAuditInvalid;

  if (failed) {
    console.error(
      `\nAudit FAILED: ${result.unwaived.length} unwaived high/critical advisory(ies), ` +
        `${result.expiredWaivers.length} expired waiver(s), ` +
        `${result.invalidWaivers.length} malformed waiver(s), ` +
        `${result.blockedWaivers.length} production-blocked waiver(s).`,
    );
    for (const vuln of result.unwaived) {
      console.error(
        `  - ${vuln.name} [${vuln.severity}] fixAvailable=${JSON.stringify(vuln.fixAvailable)}`,
      );
    }
    process.exit(1);
  }

  console.log("Audit passed: no unwaived high/critical advisories.");
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  main();
}
