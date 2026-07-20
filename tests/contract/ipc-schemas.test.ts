import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  workspaceListRequestSchema,
  workspaceListResponseSchema,
  workspaceCreateRequestSchema,
  workspaceCreateResponseSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceOpenRequestSchema,
  workspaceOpenResponseSchema,
  workspaceDeleteRequestSchema,
  workspaceDeleteResponseSchema,
} from "../../src/main/ipc/schemas/workspace.schema";
import {
  translationSanitizeRequestSchema,
  translationSanitizeResponseSchema,
  translationRestoreRequestSchema,
  translationRestoreResponseSchema,
  MAX_TRANSLATION_INPUT_LENGTH,
} from "../../src/main/ipc/schemas/translation.schema";
import {
  decisionsSelectCandidateRequestSchema,
  decisionsSelectCandidateResponseSchema,
  decisionsListRequestSchema,
  decisionsListResponseSchema,
  decisionsCheckSimilarRequestSchema,
  decisionsCheckSimilarResponseSchema,
  decisionsResolveAlwaysRequestSchema,
  decisionsResolveAlwaysResponseSchema,
  decisionsResolveNeverRequestSchema,
  decisionsResolveNeverResponseSchema,
  decisionsRemoveRequestSchema,
  decisionsRemoveResponseSchema,
  decisionsRemoveAllRequestSchema,
  decisionsRemoveAllResponseSchema,
} from "../../src/main/ipc/schemas/decisions.schema";
import {
  termsSearchRequestSchema,
  termsSearchResponseSchema,
  termsInspectRequestSchema,
  termsInspectResponseSchema,
  termsListPrefixesRequestSchema,
  termsListPrefixesResponseSchema,
  termsAddAlwaysRequestSchema,
  termsAddAlwaysResponseSchema,
  termsAddNeverRequestSchema,
  termsAddNeverResponseSchema,
  termsEditRequestSchema,
  termsEditResponseSchema,
  termsSetPrincipalRequestSchema,
  termsSetPrincipalResponseSchema,
  termsRemoveRequestSchema,
  termsRemoveResponseSchema,
} from "../../src/main/ipc/schemas/terms.schema";
import {
  dispatch,
  withValidationErrorMapping,
  type ChannelDefinition,
  type WorkspaceStatusLookup,
} from "../../src/main/ipc/dispatch";

// Contract tests for T021: every request/response Zod schema across the
// `workspace`, `translation`, `decisions`, and `terms` namespaces
// (contracts/*.md), plus the shared dispatch helper (T026). All identifiers
// and text below are synthetic (constitution Principle VI).

const VALID_WORKSPACE_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const VALID_TERM_ID = "42";
const VALID_PLACEHOLDER = "SYNTHETIC_BANK_1";

function expectValid(
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown,
): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
}

function expectInvalid(
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown,
): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

describe("workspace:* schemas (contracts/workspace.md)", () => {
  it("workspace:list — valid request/response", () => {
    expectValid(workspaceListRequestSchema, {});
    expectValid(workspaceListResponseSchema, {
      workspaces: [{ id: VALID_WORKSPACE_ID, name: "Synthetic Client Co." }],
    });
  });

  it("workspace:list — rejects extra request fields and a malformed workspace id in the response", () => {
    expectInvalid(workspaceListRequestSchema, { extra: true });
    expectInvalid(workspaceListResponseSchema, { workspaces: [{ id: "not-a-uuid", name: "X" }] });
  });

  it("workspace:create — valid request/response", () => {
    expectValid(workspaceCreateRequestSchema, { name: "Synthetic Client Co." });
    expectValid(workspaceCreateResponseSchema, {
      id: VALID_WORKSPACE_ID,
      name: "Synthetic Client Co.",
    });
  });

  it("workspace:create — rejects empty name, missing name, and extra fields", () => {
    expectInvalid(workspaceCreateRequestSchema, { name: "" });
    expectInvalid(workspaceCreateRequestSchema, {});
    expectInvalid(workspaceCreateRequestSchema, { name: "Synthetic Client Co.", extra: 1 });
  });

  it("workspace:rename — valid request/response", () => {
    expectValid(workspaceRenameRequestSchema, {
      id: VALID_WORKSPACE_ID,
      newName: "New Synthetic Name",
    });
    expectValid(workspaceRenameResponseSchema, {
      id: VALID_WORKSPACE_ID,
      name: "New Synthetic Name",
    });
  });

  it("workspace:rename — rejects a malformed id and an empty newName", () => {
    expectInvalid(workspaceRenameRequestSchema, { id: "bad-id", newName: "X" });
    expectInvalid(workspaceRenameRequestSchema, { id: VALID_WORKSPACE_ID, newName: "" });
  });

  it("workspace:open — valid request/response", () => {
    expectValid(workspaceOpenRequestSchema, { id: VALID_WORKSPACE_ID });
    expectValid(workspaceOpenResponseSchema, {
      id: VALID_WORKSPACE_ID,
      name: "Synthetic Client Co.",
    });
  });

  it("workspace:open — rejects a missing id", () => {
    expectInvalid(workspaceOpenRequestSchema, {});
  });

  it("workspace:delete — valid request/response", () => {
    expectValid(workspaceDeleteRequestSchema, { id: VALID_WORKSPACE_ID, confirm: true });
    expectValid(workspaceDeleteResponseSchema, { status: "DELETING" });
    expectValid(workspaceDeleteResponseSchema, { status: "DELETED" });
  });

  it("workspace:delete — rejects confirm: false and an invalid status enum value", () => {
    expectInvalid(workspaceDeleteRequestSchema, { id: VALID_WORKSPACE_ID, confirm: false });
    expectInvalid(workspaceDeleteRequestSchema, { id: VALID_WORKSPACE_ID });
    expectInvalid(workspaceDeleteResponseSchema, { status: "REMOVED" });
  });

  const malformedWorkspaceIds = [
    "",
    "not-a-uuid",
    "A1B2C3D4-E5F6-4A1B-8C2D-3E4F5A6B7C8D", // uppercase
    "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8", // too short
    "../../../etc/passwd",
  ];

  it.each(malformedWorkspaceIds)("workspace:open — rejects malformed id %j", (badId) => {
    expectInvalid(workspaceOpenRequestSchema, { id: badId });
  });
});

describe("translation:* schemas (contracts/translation.md)", () => {
  it("translation:sanitize — valid request/response", () => {
    expectValid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      originalText: "synthetic original text with test@example.com",
    });
    expectValid(translationSanitizeResponseSchema, {
      requestId: 1,
      sanitizedText: "sanitized EMAIL_1",
    });
  });

  it("translation:sanitize — rejects missing fields, wrong types, and extra fields", () => {
    expectInvalid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalText: "x",
    });
    expectInvalid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: "1",
      originalText: "x",
    });
    expectInvalid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      originalText: "x",
      extra: true,
    });
  });

  it("translation:sanitize — accepts exactly MAX_TRANSLATION_INPUT_LENGTH characters and rejects one more", () => {
    const atLimit = "a".repeat(MAX_TRANSLATION_INPUT_LENGTH);
    const overLimit = "a".repeat(MAX_TRANSLATION_INPUT_LENGTH + 1);
    expect(atLimit.length).toBe(500_000);

    expectValid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      originalText: atLimit,
    });
    expectInvalid(translationSanitizeRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      originalText: overLimit,
    });
  });

  it("translation:restore — valid request/response, including empty unresolvedPlaceholders", () => {
    expectValid(translationRestoreRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 2,
      sanitizedText: "EMAIL_1 said hello",
    });
    expectValid(translationRestoreResponseSchema, {
      requestId: 2,
      restoredText: "test@example.com said hello",
      unresolvedPlaceholders: [],
    });
  });

  it("translation:restore — accepts exactly MAX_TRANSLATION_INPUT_LENGTH characters and rejects one more", () => {
    const atLimit = "b".repeat(MAX_TRANSLATION_INPUT_LENGTH);
    const overLimit = "b".repeat(MAX_TRANSLATION_INPUT_LENGTH + 1);

    expectValid(translationRestoreRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      sanitizedText: atLimit,
    });
    expectInvalid(translationRestoreRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      requestId: 1,
      sanitizedText: overLimit,
    });
  });

  it("translation:restore — rejects a malformed workspaceId", () => {
    expectInvalid(translationRestoreRequestSchema, {
      workspaceId: "not-a-uuid",
      requestId: 1,
      sanitizedText: "x",
    });
  });

  describe("requestId is a strict, bounded, safe integer (remediation item 3)", () => {
    const invalidRequestIds: Array<[string, number]> = [
      ["negative", -1],
      ["fractional", 1.5],
      ["infinite", Infinity],
      ["NaN", NaN],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ];
    const validRequestIds = [0, 1, Number.MAX_SAFE_INTEGER];

    it.each(invalidRequestIds)(
      "translation:sanitize request rejects a %s requestId",
      (_label, badId) => {
        expectInvalid(translationSanitizeRequestSchema, {
          workspaceId: VALID_WORKSPACE_ID,
          requestId: badId,
          originalText: "x",
        });
      },
    );

    it.each(validRequestIds)("translation:sanitize request accepts requestId %j", (goodId) => {
      expectValid(translationSanitizeRequestSchema, {
        workspaceId: VALID_WORKSPACE_ID,
        requestId: goodId,
        originalText: "x",
      });
    });

    it.each(invalidRequestIds)(
      "translation:sanitize response rejects a %s requestId",
      (_label, badId) => {
        expectInvalid(translationSanitizeResponseSchema, { requestId: badId, sanitizedText: "x" });
      },
    );

    it.each(invalidRequestIds)(
      "translation:restore request rejects a %s requestId",
      (_label, badId) => {
        expectInvalid(translationRestoreRequestSchema, {
          workspaceId: VALID_WORKSPACE_ID,
          requestId: badId,
          sanitizedText: "x",
        });
      },
    );

    it.each(invalidRequestIds)(
      "translation:restore response rejects a %s requestId",
      (_label, badId) => {
        expectInvalid(translationRestoreResponseSchema, {
          requestId: badId,
          restoredText: "x",
          unresolvedPlaceholders: [],
        });
      },
    );
  });
});

describe("decisions:* schemas (contracts/decisions.md)", () => {
  it("decisions:select-candidate — valid request/response", () => {
    expectValid(decisionsSelectCandidateRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      text: "Synthetic Bank SA",
    });
    expectValid(decisionsSelectCandidateResponseSchema, {
      pendingDecisionId: "7",
      normalizedCandidate: "synthetic bank sa",
      isNew: true,
    });
  });

  it("decisions:select-candidate — rejects empty text and non-boolean isNew", () => {
    expectInvalid(decisionsSelectCandidateRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      text: "",
    });
    expectInvalid(decisionsSelectCandidateResponseSchema, {
      pendingDecisionId: "7",
      normalizedCandidate: "x",
      isNew: "true",
    });
  });

  it("decisions:list — valid request/response", () => {
    expectValid(decisionsListRequestSchema, { workspaceId: VALID_WORKSPACE_ID });
    expectValid(decisionsListResponseSchema, {
      pendingDecisions: [
        { id: "1", candidate: "Synthetic Bank SA", normalizedCandidate: "synthetic bank sa" },
      ],
    });
  });

  it("decisions:list — rejects a missing workspaceId", () => {
    expectInvalid(decisionsListRequestSchema, {});
  });

  it("decisions:check-similar — valid request/response, including a null suggestion", () => {
    expectValid(decisionsCheckSimilarRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
    });
    expectValid(decisionsCheckSimilarResponseSchema, { suggestion: null });
    expectValid(decisionsCheckSimilarResponseSchema, {
      suggestion: {
        termId: "3",
        originalValue: "Synthetic Bank SA",
        placeholderValue: VALID_PLACEHOLDER,
        confidence: 0.97,
      },
    });
  });

  it("decisions:check-similar — rejects a confidence outside [0,1] and a malformed placeholderValue", () => {
    expectInvalid(decisionsCheckSimilarResponseSchema, {
      suggestion: {
        termId: "3",
        originalValue: "X",
        placeholderValue: VALID_PLACEHOLDER,
        confidence: 1.5,
      },
    });
    expectInvalid(decisionsCheckSimilarResponseSchema, {
      suggestion: {
        termId: "3",
        originalValue: "X",
        placeholderValue: "lowercase_1",
        confidence: 0.5,
      },
    });
  });

  it("decisions:resolve-always — valid with prefix only, valid with sameEntityAsTermId only", () => {
    expectValid(decisionsResolveAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
      prefix: "SYNTHETIC_BANK",
    });
    expectValid(decisionsResolveAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
      sameEntityAsTermId: "3",
      principalTermId: "3",
    });
    expectValid(decisionsResolveAlwaysResponseSchema, {
      termId: "9",
      placeholderValue: VALID_PLACEHOLDER,
    });
  });

  it("decisions:resolve-always — rejects neither prefix nor sameEntityAsTermId, and both at once", () => {
    expectInvalid(decisionsResolveAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
    });
    expectInvalid(decisionsResolveAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
      prefix: "SYNTHETIC_BANK",
      sameEntityAsTermId: "3",
    });
  });

  it("decisions:resolve-never — valid request/response", () => {
    expectValid(decisionsResolveNeverRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
    });
    expectValid(decisionsResolveNeverResponseSchema, { termId: "9" });
  });

  it("decisions:remove — valid request/response", () => {
    expectValid(decisionsRemoveRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      pendingDecisionId: "7",
    });
    expectValid(decisionsRemoveResponseSchema, { removedId: "7" });
  });

  it("decisions:remove-all — valid request/response, rejects confirm: false and a negative removedCount", () => {
    expectValid(decisionsRemoveAllRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      confirm: true,
    });
    expectValid(decisionsRemoveAllResponseSchema, { removedCount: 0 });
    expectInvalid(decisionsRemoveAllRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      confirm: false,
    });
    expectInvalid(decisionsRemoveAllResponseSchema, { removedCount: -1 });
  });
});

describe("terms:* schemas (contracts/terms.md)", () => {
  it("terms:search — valid request/response, including an empty query and optional fields omitted", () => {
    expectValid(termsSearchRequestSchema, { workspaceId: VALID_WORKSPACE_ID, query: "" });
    expectValid(termsSearchResponseSchema, {
      terms: [{ id: "1", originalValue: "Synthetic Bank SA", policy: "ALWAYS" }],
    });
    expectValid(termsSearchResponseSchema, {
      terms: [
        {
          id: "1",
          originalValue: "Synthetic Bank SA",
          policy: "ALWAYS",
          placeholderValue: VALID_PLACEHOLDER,
          isPrincipal: true,
          aliasCount: 2,
        },
      ],
    });
  });

  it("terms:search — rejects an invalid policy enum value", () => {
    expectInvalid(termsSearchResponseSchema, {
      terms: [{ id: "1", originalValue: "X", policy: "MAYBE" }],
    });
  });

  it("terms:inspect — valid request/response with and without optional placeholder/aliases", () => {
    expectValid(termsInspectRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
    });
    expectValid(termsInspectResponseSchema, {
      id: VALID_TERM_ID,
      originalValue: "Synthetic Bank SA",
      policy: "NEVER",
    });
    expectValid(termsInspectResponseSchema, {
      id: VALID_TERM_ID,
      originalValue: "Synthetic Bank SA",
      policy: "ALWAYS",
      placeholder: { value: VALID_PLACEHOLDER, prefixValue: "SYNTHETIC_BANK" },
      aliases: [{ termId: "2", originalValue: "Synthetic Bank SA Ltd", isPrincipal: false }],
    });
  });

  it("terms:inspect — rejects an empty termId", () => {
    expectInvalid(termsInspectRequestSchema, { workspaceId: VALID_WORKSPACE_ID, termId: "" });
  });

  it("terms:list-prefixes — valid request/response", () => {
    expectValid(termsListPrefixesRequestSchema, { workspaceId: VALID_WORKSPACE_ID });
    expectValid(termsListPrefixesResponseSchema, {
      prefixes: ["SYNTHETIC_BANK", "SYNTHETIC_CUSTOMER"],
    });
  });

  it("terms:add-always — valid with prefix only, valid with sameEntityAsTermId, rejects neither/both", () => {
    expectValid(termsAddAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalValue: "Synthetic Bank SA",
      prefix: "SYNTHETIC_BANK",
    });
    expectValid(termsAddAlwaysResponseSchema, { termId: "9", placeholderValue: VALID_PLACEHOLDER });
    expectInvalid(termsAddAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalValue: "Synthetic Bank SA",
    });
    expectInvalid(termsAddAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalValue: "Synthetic Bank SA",
      prefix: "SYNTHETIC_BANK",
      sameEntityAsTermId: "3",
    });
  });

  it("terms:add-always — rejects an empty originalValue", () => {
    expectInvalid(termsAddAlwaysRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalValue: "",
      prefix: "SYNTHETIC_BANK",
    });
  });

  it("terms:add-never — valid request/response", () => {
    expectValid(termsAddNeverRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      originalValue: "Synthetic Person Name",
    });
    expectValid(termsAddNeverResponseSchema, { termId: "10" });
  });

  it("terms:edit — valid with either or both optional fields, valid with neither", () => {
    expectValid(termsEditRequestSchema, { workspaceId: VALID_WORKSPACE_ID, termId: VALID_TERM_ID });
    expectValid(termsEditRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      policy: "NEVER",
    });
    expectValid(termsEditRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      originalValue: "Updated Synthetic Value",
      policy: "ALWAYS",
    });
    expectValid(termsEditResponseSchema, { termId: VALID_TERM_ID });
  });

  it("terms:edit — rejects an invalid policy enum value and an empty originalValue", () => {
    expectInvalid(termsEditRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      policy: "MAYBE",
    });
    expectInvalid(termsEditRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      originalValue: "",
    });
  });

  it("terms:set-principal — valid request/response, rejects a malformed placeholderValue", () => {
    expectValid(termsSetPrincipalRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      placeholderValue: VALID_PLACEHOLDER,
      principalTermId: "3",
    });
    expectValid(termsSetPrincipalResponseSchema, {
      placeholderValue: VALID_PLACEHOLDER,
      principalTermId: "3",
    });
    expectInvalid(termsSetPrincipalRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      placeholderValue: "not_a_valid_placeholder_shape",
      principalTermId: "3",
    });
  });

  it("terms:remove — valid request/response, rejects confirm: false", () => {
    expectValid(termsRemoveRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      confirm: true,
    });
    expectValid(termsRemoveResponseSchema, { removedId: VALID_TERM_ID, placeholderDeleted: false });
    expectInvalid(termsRemoveRequestSchema, {
      workspaceId: VALID_WORKSPACE_ID,
      termId: VALID_TERM_ID,
      confirm: false,
    });
  });
});

describe("dispatch() (T026, src/main/ipc/dispatch.ts)", () => {
  const nonScopedDefinition: ChannelDefinition<{ name: string }, { id: string }> = {
    requestSchema: workspaceCreateRequestSchema,
    responseSchema: workspaceCreateResponseSchema as unknown as ChannelDefinition<
      { name: string },
      { id: string }
    >["responseSchema"],
  };

  const scopedDefinition: ChannelDefinition<
    { workspaceId: string; requestId: number; originalText: string },
    { requestId: number; sanitizedText: string }
  > = {
    requestSchema: translationSanitizeRequestSchema,
    responseSchema: translationSanitizeResponseSchema,
  };

  it("does not invoke the handler when request validation fails", async () => {
    const handler = vi.fn();
    const result = await dispatch(scopedDefinition, { workspaceId: "not-a-uuid" }, handler, {
      getWorkspaceStatus: vi.fn(),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("checks workspace status before invoking the handler for a workspace-scoped channel, and blocks on DELETING", async () => {
    const handler = vi.fn();
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn().mockResolvedValue("DELETING");

    const result = await dispatch(
      scopedDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      handler,
      { getWorkspaceStatus },
    );

    expect(getWorkspaceStatus).toHaveBeenCalledWith(VALID_WORKSPACE_ID);
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_DELETING" } });
  });

  it("[remediation item 2 regression] a request carrying workspaceId is never dispatched to the handler while DELETING, regardless of any workspaceScoped flag a caller might supply", async () => {
    const handler = vi
      .fn()
      .mockResolvedValue({ requestId: 1, sanitizedText: "leaked-despite-deletion" });
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn().mockResolvedValue("DELETING");

    // A caller mis-configures the definition — workspaceScoped: false — even
    // though the request schema plainly carries workspaceId. This must not
    // be able to bypass the DELETING check: scope is derived from the
    // validated request's own shape, not from a separately supplied flag.
    const misconfiguredDefinition = {
      requestSchema: translationSanitizeRequestSchema,
      responseSchema: translationSanitizeResponseSchema,
      workspaceScoped: false,
    } as unknown as ChannelDefinition<
      { workspaceId: string; requestId: number; originalText: string },
      { requestId: number; sanitizedText: string }
    >;

    const result = await dispatch(
      misconfiguredDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      handler,
      { getWorkspaceStatus },
    );

    expect(getWorkspaceStatus).toHaveBeenCalledWith(VALID_WORKSPACE_ID);
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_DELETING" } });
  });

  it("fails safely without invoking the handler when a workspace-scoped request has no getWorkspaceStatus dependency", async () => {
    const handler = vi.fn();

    const result = await dispatch(
      scopedDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      handler,
      {},
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });

  it("invokes the handler when the workspace is ACTIVE and returns its (validated) result", async () => {
    const handler = vi.fn().mockResolvedValue({ requestId: 1, sanitizedText: "sanitized" });
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn().mockResolvedValue("ACTIVE");

    const result = await dispatch(
      scopedDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      handler,
      { getWorkspaceStatus },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { requestId: 1, sanitizedText: "sanitized" } });
  });

  it("rejects an invalid handler response instead of returning it", async () => {
    const handler = vi.fn().mockResolvedValue({ requestId: "not-a-number", sanitizedText: "x" });
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn().mockResolvedValue("ACTIVE");

    const result = await dispatch(
      scopedDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      handler,
      { getWorkspaceStatus },
    );

    expect(result).toEqual({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });

  it("never performs a workspace-status lookup for a non-workspace-scoped channel", async () => {
    const handler = vi.fn().mockResolvedValue({ id: VALID_WORKSPACE_ID, name: "Synthetic Co." });
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn();

    const result = await dispatch(nonScopedDefinition, { name: "Synthetic Co." }, handler, {
      getWorkspaceStatus,
    });

    expect(getWorkspaceStatus).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { id: VALID_WORKSPACE_ID, name: "Synthetic Co." } });
  });

  it("dispatch tests never require the real user database — getWorkspaceStatus is a plain injected function", async () => {
    let recordedWorkspaceId: string | undefined;
    const getWorkspaceStatus: WorkspaceStatusLookup = (workspaceId) => {
      recordedWorkspaceId = workspaceId;
      return "ACTIVE";
    };

    await dispatch(
      scopedDefinition,
      { workspaceId: OTHER_WORKSPACE_ID, requestId: 1, originalText: "hello" },
      vi.fn().mockResolvedValue({ requestId: 1, sanitizedText: "x" }),
      { getWorkspaceStatus },
    );

    expect(recordedWorkspaceId).toBe(OTHER_WORKSPACE_ID);
  });
});

describe("INPUT_TOO_LARGE is reachable through dispatch (remediation item 1)", () => {
  it("dispatch reads a generic, schema-embedded validation-error mapping and never receives the raw request itself", async () => {
    // Proves the mechanism is generic infrastructure, not translation-
    // specific: a locally-built schema attaches its own mapping via
    // withValidationErrorMapping, with no translation.schema.ts involved.
    const localSchema = withValidationErrorMapping(z.strictObject({ value: z.string().max(3) }), [
      { field: "value", issueCode: "too_big", errorCode: "INPUT_TOO_LARGE" },
    ]);
    const definition: ChannelDefinition<{ value: string }, { ok: true }> = {
      requestSchema: localSchema,
      responseSchema: z.strictObject({ ok: z.literal(true) }),
    };

    const handler = vi.fn();
    const overLimit = "toolong";
    const result = await dispatch(definition, { value: overLimit }, handler, {
      getWorkspaceStatus: vi.fn(),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "INPUT_TOO_LARGE" } });
    // dispatch's error-code resolution only ever reads Zod's structural
    // issue list — never the 500,001-character string itself would appear
    // here even if this were the real translation schema.
    expect(JSON.stringify(result)).not.toContain(overLimit);
  });

  it("falls back to VALIDATION_ERROR when the schema has no mapping, or the mapping finds no matching field/issue", async () => {
    const noMappingDefinition: ChannelDefinition<
      { workspaceId: string; requestId: number; originalText: string },
      { requestId: number; sanitizedText: string }
    > = {
      requestSchema: translationSanitizeRequestSchema,
      responseSchema: translationSanitizeResponseSchema,
    };

    // requestSchema.meta() *does* carry a mapping (originalText/too_big),
    // but this failure is a missing-field issue, which does not match it.
    const result = await dispatch(noMappingDefinition, { workspaceId: "not-a-uuid" }, vi.fn(), {
      getWorkspaceStatus: vi.fn(),
    });

    expect(result).toEqual({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("translationSanitizeRequestSchema/translationRestoreRequestSchema carry the INPUT_TOO_LARGE mapping as schema metadata (not a separately-attachable option)", () => {
    expect(translationSanitizeRequestSchema.meta()).toEqual({
      validationErrorMappings: [
        { field: "originalText", issueCode: "too_big", errorCode: "INPUT_TOO_LARGE" },
      ],
    });
    expect(translationRestoreRequestSchema.meta()).toEqual({
      validationErrorMappings: [
        { field: "sanitizedText", issueCode: "too_big", errorCode: "INPUT_TOO_LARGE" },
      ],
    });
  });

  it("end-to-end through dispatch: exactly the ceiling is accepted (handler invoked); one character more returns INPUT_TOO_LARGE (handler never invoked)", async () => {
    const definition: ChannelDefinition<
      { workspaceId: string; requestId: number; originalText: string },
      { requestId: number; sanitizedText: string }
    > = {
      requestSchema: translationSanitizeRequestSchema,
      responseSchema: translationSanitizeResponseSchema,
    };
    const getWorkspaceStatus: WorkspaceStatusLookup = vi.fn().mockResolvedValue("ACTIVE");

    const atLimitHandler = vi.fn().mockResolvedValue({ requestId: 1, sanitizedText: "ok" });
    const atLimitResult = await dispatch(
      definition,
      {
        workspaceId: VALID_WORKSPACE_ID,
        requestId: 1,
        originalText: "a".repeat(MAX_TRANSLATION_INPUT_LENGTH),
      },
      atLimitHandler,
      { getWorkspaceStatus },
    );
    expect(atLimitHandler).toHaveBeenCalledTimes(1);
    expect(atLimitResult.ok).toBe(true);

    const overLimitHandler = vi.fn();
    const overLimitResult = await dispatch(
      definition,
      {
        workspaceId: VALID_WORKSPACE_ID,
        requestId: 1,
        originalText: "a".repeat(MAX_TRANSLATION_INPUT_LENGTH + 1),
      },
      overLimitHandler,
      { getWorkspaceStatus },
    );
    expect(overLimitHandler).not.toHaveBeenCalled();
    expect(overLimitResult).toEqual({ ok: false, error: { code: "INPUT_TOO_LARGE" } });
  });

  it("still returns VALIDATION_ERROR (not INPUT_TOO_LARGE) for an unrelated malformed translation payload", async () => {
    const definition: ChannelDefinition<
      { workspaceId: string; requestId: number; originalText: string },
      { requestId: number; sanitizedText: string }
    > = {
      requestSchema: translationSanitizeRequestSchema,
      responseSchema: translationSanitizeResponseSchema,
    };

    const result = await dispatch(
      definition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: "fine", extra: true },
      vi.fn(),
      { getWorkspaceStatus: vi.fn() },
    );

    expect(result).toEqual({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("[remediation regression] a translation channel definition built from the exported request schema alone (no manually attached mapper) still returns INPUT_TOO_LARGE — the mapping must not be an omittable, separately-attached option", async () => {
    // Deliberately mirrors how a careless/forgetful future handler would
    // wire this up: only requestSchema/responseSchema, nothing else. If the
    // mapping depends on a caller remembering to also pass
    // `mapValidationError`, this definition — built from nothing but the
    // exported schemas — must still produce INPUT_TOO_LARGE, because the
    // schema itself is required to carry that information.
    const forgetfulDefinition: ChannelDefinition<
      { workspaceId: string; requestId: number; originalText: string },
      { requestId: number; sanitizedText: string }
    > = {
      requestSchema: translationSanitizeRequestSchema,
      responseSchema: translationSanitizeResponseSchema,
    };

    const handler = vi.fn();
    const overLimit = "a".repeat(MAX_TRANSLATION_INPUT_LENGTH + 1);

    const result = await dispatch(
      forgetfulDefinition,
      { workspaceId: VALID_WORKSPACE_ID, requestId: 1, originalText: overLimit },
      handler,
      { getWorkspaceStatus: vi.fn() },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "INPUT_TOO_LARGE" } });
  });
});

describe("sensitive request values never appear in validation errors (T021 requirement)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const SENSITIVE_VALUE = "synthetic-secret-original-value-should-never-leak";

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("a Zod validation failure's error object never contains the offending sensitive value", () => {
    const result = translationSanitizeRequestSchema.safeParse({
      workspaceId: "not-a-uuid",
      requestId: 1,
      originalText: SENSITIVE_VALUE,
    });

    expect(result.success).toBe(false);
    const serialized = JSON.stringify(result.success ? null : result.error.issues);
    expect(serialized).not.toContain(SENSITIVE_VALUE);
  });

  it("dispatch's VALIDATION_ERROR result never contains the offending sensitive value, and nothing is logged", async () => {
    const handler = vi.fn();
    const result = await dispatch(
      {
        requestSchema: decisionsSelectCandidateRequestSchema,
        responseSchema: decisionsSelectCandidateResponseSchema,
      },
      { workspaceId: "not-a-uuid", text: SENSITIVE_VALUE },
      handler,
      { getWorkspaceStatus: vi.fn() },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_VALUE);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
