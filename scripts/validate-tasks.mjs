#!/usr/bin/env node
// Specification-validation gate (constitution Principle VI): tasks.md task IDs
// must be sequential and non-duplicate, and every [Story]-labeled task's cited
// FR-*/SC-* IDs must actually exist in spec.md. Run in CI before any other gate.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SPECS_ROOT = "specs";
const errors = [];

function findFeatureDirs() {
  return readdirSync(SPECS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SPECS_ROOT, entry.name));
}

function validateFeature(featureDir) {
  const tasksPath = join(featureDir, "tasks.md");
  const specPath = join(featureDir, "spec.md");
  let tasksContent;
  try {
    tasksContent = readFileSync(tasksPath, "utf8");
  } catch {
    return; // No tasks.md for this feature yet — nothing to validate.
  }
  const specContent = readFileSync(specPath, "utf8");

  const knownIds = new Set(specContent.match(/\b(?:FR|SC)-[A-Z0-9-]+\b/g) ?? []);

  const taskLineRegex = /^-\s\[([ Xx])]\s+(T\d+)\s+(.*)$/gm;
  const seenIds = new Map();
  const numericIds = [];
  let match;
  while ((match = taskLineRegex.exec(tasksContent)) !== null) {
    const [, , id, rest] = match;
    const num = Number.parseInt(id.slice(1), 10);

    if (seenIds.has(id)) {
      errors.push(`${tasksPath}: duplicate task ID ${id}`);
    } else {
      seenIds.set(id, true);
    }
    numericIds.push(num);

    const isStoryLabeled = /^(?:\[P]\s+)?\[US\d+]/.test(rest);
    if (isStoryLabeled) {
      const citedIds = rest.match(/\b(?:FR|SC)-[A-Z0-9-]+\b/g) ?? [];
      for (const citedId of citedIds) {
        if (!knownIds.has(citedId)) {
          errors.push(`${tasksPath}: task ${id} cites unknown requirement ID ${citedId}`);
        }
      }
    }
  }

  numericIds.sort((a, b) => a - b);
  for (let i = 0; i < numericIds.length; i++) {
    const expected = i + 1;
    if (numericIds[i] !== expected) {
      errors.push(
        `${tasksPath}: task ID sequence gap — expected T${String(expected).padStart(3, "0")}, found T${String(numericIds[i]).padStart(3, "0")}`,
      );
      break;
    }
  }
}

for (const featureDir of findFeatureDirs()) {
  validateFeature(featureDir);
}

if (errors.length > 0) {
  console.error("Specification validation FAILED:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  "Specification validation passed: task IDs sequential/non-duplicate, all cited FR/SC IDs exist.",
);
