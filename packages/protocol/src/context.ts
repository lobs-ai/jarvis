import { z } from "zod";

// One connected MCP server's contribution to a turn's context, via its *_context tool.
export const ContextEntry = z.object({
  server: z.string(),
  // plain text, already truncated to the server's sub-budget by the manager
  content: z.string(),
});
export type ContextEntry = z.infer<typeof ContextEntry>;

// Attached to the current turn only; never accumulated into history.
export const UtteranceBundle = z.object({
  entries: z.array(ContextEntry),
  // what Jarvis itself is currently showing (id + type + title), so "that table" resolves
  stageExhibits: z.array(z.string()),
});
export type UtteranceBundle = z.infer<typeof UtteranceBundle>;

// Hard cap on the rendered bundle, enforced by the assembler (see design §Eyes).
export const BUNDLE_TOKEN_BUDGET = 2000;
export const PER_SERVER_TIMEOUT_MS = 300;
