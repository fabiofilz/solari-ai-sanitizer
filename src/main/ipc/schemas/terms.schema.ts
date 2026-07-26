import { z } from "zod";
import {
  nonEmptyIdSchema,
  nonEmptyStringSchema,
  placeholderValueSchema,
  workspaceIdSchema,
} from "./common";

// Zod schemas for the `terms:*` channels (contracts/terms.md).

const policySchema = z.enum(["ALWAYS", "NEVER"]);

export const termsSearchRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  // No minimum length: an empty query is a legitimate "browse all terms"
  // request — terms.md does not document it as prohibited.
  query: z.string(),
});

export const termsSearchResponseSchema = z.strictObject({
  terms: z.array(
    z.strictObject({
      id: nonEmptyIdSchema,
      originalValue: nonEmptyStringSchema,
      policy: policySchema,
      placeholderValue: placeholderValueSchema.optional(),
      isPrincipal: z.boolean().optional(),
      aliasCount: z.number().int().nonnegative().optional(),
    }),
  ),
});

export const termsInspectRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  termId: nonEmptyIdSchema,
});

export const termsInspectResponseSchema = z.strictObject({
  id: nonEmptyIdSchema,
  originalValue: nonEmptyStringSchema,
  policy: policySchema,
  placeholder: z
    .strictObject({
      value: placeholderValueSchema,
      prefixValue: nonEmptyStringSchema,
    })
    .optional(),
  aliases: z
    .array(
      z.strictObject({
        termId: nonEmptyIdSchema,
        originalValue: nonEmptyStringSchema,
        isPrincipal: z.boolean(),
      }),
    )
    .optional(),
});

export const termsListPrefixesRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});

export const termsListPrefixesResponseSchema = z.strictObject({
  prefixes: z.array(nonEmptyStringSchema),
});

// terms.md: "same placeholder-allocation and alias rules as
// decisions:resolve-always" — the same exactly-one-of refinement applies;
// see decisions.schema.ts for the full reasoning.
export const termsAddAlwaysRequestSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    originalValue: nonEmptyStringSchema,
    prefix: nonEmptyStringSchema.optional(),
    sameEntityAsTermId: nonEmptyIdSchema.optional(),
    principalTermId: nonEmptyIdSchema.optional(),
  })
  .refine((value) => (value.prefix !== undefined) !== (value.sameEntityAsTermId !== undefined), {
    message: "exactly one of prefix or sameEntityAsTermId is required",
    path: ["prefix"],
  });

export const termsAddAlwaysResponseSchema = z.strictObject({
  termId: nonEmptyIdSchema,
  placeholderValue: placeholderValueSchema,
});

export const termsAddNeverRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  originalValue: nonEmptyStringSchema,
});

export const termsAddNeverResponseSchema = z.strictObject({
  termId: nonEmptyIdSchema,
});

export const termsEditRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  termId: nonEmptyIdSchema,
  originalValue: nonEmptyStringSchema.optional(),
  policy: policySchema.optional(),
});

export const termsEditResponseSchema = z.strictObject({
  termId: nonEmptyIdSchema,
});

export const termsSetPrincipalRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  placeholderValue: placeholderValueSchema,
  principalTermId: nonEmptyIdSchema,
});

export const termsSetPrincipalResponseSchema = z.strictObject({
  placeholderValue: placeholderValueSchema,
  principalTermId: nonEmptyIdSchema,
});

export const termsRemoveRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  termId: nonEmptyIdSchema,
  confirm: z.literal(true),
});

export const termsRemoveResponseSchema = z.strictObject({
  removedId: nonEmptyIdSchema,
  placeholderDeleted: z.boolean(),
});
