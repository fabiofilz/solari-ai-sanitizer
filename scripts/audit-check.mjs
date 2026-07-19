#!/usr/bin/env node
// Dependency-vulnerability audit gate (constitution Principle VI).
// Fails the build on any actionable (fixable) high/critical advisory. A
// vulnerability with no available fix may only be waived via a reviewed
// entry in audit-waivers.json naming the advisory ID, the justification, and
// an expiry date — after which the waiver must be re-justified or this gate
// fails again. Never silently suppressed.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WAIVERS_PATH = "audit-waivers.json";
const ACTIONABLE_SEVERITIES = new Set(["high", "critical"]);

function loadWaivers() {
  const raw = JSON.parse(readFileSync(WAIVERS_PATH, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const active = new Map();
  const expired = [];
  for (const waiver of raw.waivers ?? []) {
    if (waiver.expires < today) {
      expired.push(waiver);
    } else {
      active.set(waiver.id, waiver);
    }
  }
  return { active, expired };
}

function runAudit() {
  // execSync (not execFileSync) so this resolves through the OS shell — on
  // Windows, npm is the "npm.cmd" shim, which requires shell resolution to
  // run at all; execFileSync without shell:true cannot find/execute it there.
  try {
    const out = execSync("npm audit --json", { encoding: "utf8" });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found; stdout still has the report.
    if (err.stdout) {
      return JSON.parse(err.stdout);
    }
    throw err;
  }
}

function extractAdvisoryIds(via) {
  const ids = [];
  for (const entry of via) {
    if (typeof entry === "object" && entry !== null) {
      const match = /GHSA-[a-z0-9-]+/i.exec(entry.url ?? "");
      ids.push(match ? match[0] : `source:${String(entry.source)}`);
    }
  }
  return ids;
}

const { active: activeWaivers, expired: expiredWaivers } = loadWaivers();
const report = runAudit();

const unwaived = [];
const waived = [];

for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  if (!ACTIONABLE_SEVERITIES.has(vuln.severity)) continue;
  if (vuln.fixAvailable === false) {
    // No fix available — eligible for a waiver.
    const advisoryIds = extractAdvisoryIds(vuln.via);
    const matchedWaiver = advisoryIds.map((id) => activeWaivers.get(id)).find(Boolean);
    if (matchedWaiver) {
      waived.push({ package: vuln.name, severity: vuln.severity, waiver: matchedWaiver });
      continue;
    }
  }
  unwaived.push(vuln);
}

if (expiredWaivers.length > 0) {
  console.error("Audit waiver(s) expired and must be re-justified:");
  for (const w of expiredWaivers) {
    console.error(`  - ${w.id} (expired ${w.expires}): ${w.reason}`);
  }
}

if (waived.length > 0) {
  console.log("Waived advisories (no fix available, reviewed waiver on file):");
  for (const w of waived) {
    console.log(
      `  - ${w.package} [${w.severity}] waived by ${w.waiver.id}, expires ${w.waiver.expires}`,
    );
  }
}

if (unwaived.length > 0 || expiredWaivers.length > 0) {
  console.error(
    `\nAudit FAILED: ${unwaived.length} unwaived high/critical advisory(ies), ${expiredWaivers.length} expired waiver(s).`,
  );
  for (const vuln of unwaived) {
    console.error(
      `  - ${vuln.name} [${vuln.severity}] fixAvailable=${JSON.stringify(vuln.fixAvailable)}`,
    );
  }
  process.exit(1);
}

console.log("Audit passed: no unwaived high/critical advisories.");
