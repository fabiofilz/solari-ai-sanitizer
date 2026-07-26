import { z } from "zod";
import { nonEmptyStringSchema, workspaceIdSchema } from "./common";

// Zod schemas for the `workspace:*` channels (contracts/workspace.md).
// `id` here always refers to Workspace.id, a uuid per data-model.md, so it
// is validated with the same canonical-UUID rule as `workspaceId` elsewhere.

export const workspaceListRequestSchema = z.strictObject({});

export const workspaceListResponseSchema = z.strictObject({
  workspaces: z.array(
    z.strictObject({
      id: workspaceIdSchema,
      name: nonEmptyStringSchema,
    }),
  ),
});

export const workspaceCreateRequestSchema = z.strictObject({
  name: nonEmptyStringSchema,
});

export const workspaceCreateResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  name: nonEmptyStringSchema,
});

export const workspaceRenameRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  newName: nonEmptyStringSchema,
});

export const workspaceRenameResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  name: nonEmptyStringSchema,
});

export const workspaceOpenRequestSchema = z.strictObject({
  id: workspaceIdSchema,
});

export const workspaceOpenResponseSchema = z.strictObject({
  id: workspaceIdSchema,
  name: nonEmptyStringSchema,
});

export const workspaceDeleteRequestSchema = z.strictObject({
  id: workspaceIdSchema,
  confirm: z.literal(true),
});

export const workspaceDeleteResponseSchema = z.strictObject({
  status: z.enum(["DELETING", "DELETED"]),
});
