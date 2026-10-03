import * as v from "valibot";

const metricsSchema = v.optional(
  v.pipe(
    v.unknown(),
    v.check(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    ),
    v.record(v.string(), v.unknown()),
    v.transform((values) =>
      Object.fromEntries(
        Object.entries(values).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" &&
            Number.isFinite(entry[1]) &&
            entry[1] >= 0,
        ),
      ),
    ),
  ),
);
export const messageSchema = v.object({
  role: v.picklist(["user", "assistant"]),
  content: v.string(),
  thought: v.optional(v.string()),
  finish: v.optional(v.picklist(["stop", "length", "interrupted", "error"])),
  estimatedTokens: v.optional(v.pipe(v.number(), v.minValue(0))),
  timings: metricsSchema,
  usage: metricsSchema,
});
export type Message = v.InferOutput<typeof messageSchema>;
export type ModelMessage = Pick<Message, "role" | "content">;
export const requestSchema = v.object({
  model: v.optional(v.string()),
  stream: v.optional(v.boolean()),
  messages: v.pipe(
    v.array(
      v.object({
        role: v.picklist(["user", "assistant"]),
        content: v.string(),
      }),
    ),
    v.minLength(1),
  ),
  max_tokens: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192)),
  ),
  temperature: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
  top_p: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  reasoning_effort: v.optional(v.picklist(["none", "medium"])),
  chat_template_kwargs: v.optional(v.object({ enable_thinking: v.boolean() })),
});
export const jobRequestSchema = v.object({
  ...requestSchema.entries,
  id: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)),
});
const textSchema = v.object({
  content: v.optional(v.nullable(v.string())),
  reasoning_content: v.optional(v.nullable(v.string())),
});
export const replySchema = v.object({
  choices: v.optional(
    v.array(
      v.object({
        message: v.optional(textSchema),
        delta: v.optional(textSchema),
        finish_reason: v.optional(v.nullable(v.picklist(["stop", "length"]))),
      }),
    ),
  ),
  timings: metricsSchema,
  usage: metricsSchema,
  error: v.optional(v.object({ message: v.string() })),
});
export type Reply = v.InferOutput<typeof replySchema>;
export type Chunk = v.InferOutput<typeof textSchema> &
  Pick<Reply, "timings" | "usage"> & { finish?: "stop" | "length" | null };
export const jobSchema = v.variant("state", [
  v.object({ state: v.literal("pending") }),
  v.object({ state: v.literal("done"), result: replySchema }),
  v.object({
    state: v.literal("error"),
    error: v.object({ message: v.string() }),
  }),
]);
export type JobResult = v.InferOutput<typeof jobSchema>;
export const sessionSchema = v.object({
  messages: v.array(
    v.object({
      ...messageSchema.entries,
      // Older clients stored unvalidated metrics; retain the conversation without them.
      timings: v.fallback(metricsSchema, undefined),
      usage: v.fallback(metricsSchema, undefined),
    }),
  ),
  draft: v.string(),
  thinking: v.optional(v.boolean()),
  retryText: v.optional(v.string()),
  revision: v.optional(v.nullable(v.string())),
});
export type Session = Pick<
  v.InferOutput<typeof sessionSchema>,
  "messages" | "draft" | "thinking" | "retryText"
>;

/** Keep unknown failures readable at network and storage boundaries. */
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unexpected error. Retry your message.";
}
