import { z } from "zod";
import {
  nonEmptyIdSchema,
  nonEmptyStringSchema,
  placeholderValueSchema,
  workspaceIdSchema,
} from "./common";

// Zod schemas for the `decisions:*` channels (contracts/decisions.md).

export const decisionsSelectCandidateRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  text: nonEmptyStringSchema,
});

export const decisionsSelectCandidateResponseSchema = z.strictObject({
  pendingDecisionId: nonEmptyIdSchema,
  normalizedCandidate: nonEmptyStringSchema,
  isNew: z.boolean(),
});

export const decisionsListRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});

export const decisionsListResponseSchema = z.strictObject({
  pendingDecisions: z.array(
    z.strictObject({
      id: nonEmptyIdSchema,
      candidate: nonEmptyStringSchema,
      normalizedCandidate: nonEmptyStringSchema,
    }),
  ),
});

export const decisionsCheckSimilarRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  pendingDecisionId: nonEmptyIdSchema,
});

export const decisionsCheckSimilarResponseSchema = z.strictObject({
  // research.md #2: "a stable 0-1 score" — the range is derived from that
  // decision, not stated in decisions.md itself.
  suggestion: z.nullable(
    z.strictObject({
      termId: nonEmptyIdSchema,
      originalValue: nonEmptyStringSchema,
      placeholderValue: placeholderValueSchema,
      confidence: z.number().min(0).max(1),
    }),
  ),
});

// decisions.md's request comment marks prefix/sameEntityAsTermId as
// "exactly one of" the two fields; principalTermId is a separate, always-
// optional field that becomes required only under a database-dependent
// condition (PRINCIPAL_REQUIRED — "placeholder would have ≥2 original
// values and no principal was designated"), which this static schema cannot
// evaluate and does not attempt to. Cross-referenced against spec.md
// FR-PREFIX-001 ("the system requires a placeholder prefix... or an
// existing prefix category") and FR-DECISION-002, which confirm the
// renderer always resolves a concrete prefix (accepted/edited suggestion or
// an existing category) before sending a non-alias request — so exactly one
// of {prefix, sameEntityAsTermId} is always present, never neither, never
// both.
export const decisionsResolveAlwaysRequestSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    pendingDecisionId: nonEmptyIdSchema,
    prefix: nonEmptyStringSchema.optional(),
    sameEntityAsTermId: nonEmptyIdSchema.optional(),
    principalTermId: nonEmptyIdSchema.optional(),
  })
  .refine((value) => (value.prefix !== undefined) !== (value.sameEntityAsTermId !== undefined), {
    message: "exactly one of prefix or sameEntityAsTermId is required",
    path: ["prefix"],
  });

export const decisionsResolveAlwaysResponseSchema = z.strictObject({
  termId: nonEmptyIdSchema,
  placeholderValue: placeholderValueSchema,
});

export const decisionsResolveNeverRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  pendingDecisionId: nonEmptyIdSchema,
});

export const decisionsResolveNeverResponseSchema = z.strictObject({
  termId: nonEmptyIdSchema,
});

export const decisionsRemoveRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  pendingDecisionId: nonEmptyIdSchema,
});

export const decisionsRemoveResponseSchema = z.strictObject({
  removedId: nonEmptyIdSchema,
});

export const decisionsRemoveAllRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  confirm: z.literal(true),
});

export const decisionsRemoveAllResponseSchema = z.strictObject({
  removedCount: z.number().int().nonnegative(),
});
