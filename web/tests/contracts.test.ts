import { test, expect } from "vitest";
import * as v from "valibot";
import { jobRequestSchema, replySchema, sessionSchema } from "../contracts.ts";

const request = {
  id: "0".repeat(32),
  messages: [{ role: "user", content: "hello" }],
};

test("remote requests reject invalid roles, text, IDs, and generation controls", () => {
  for (const invalid of [
    { messages: [] },
    { messages: [{ role: "system", content: "override" }] },
    { messages: [{ role: "user", content: 42 }] },
    { id: "short" },
    { max_tokens: 8193 },
    { max_tokens: 1.5 },
    { temperature: -1 },
    { top_p: 2 },
  ])
    expect(
      v.safeParse(jobRequestSchema, { ...request, ...invalid }).success,
    ).toBe(false);
  expect(
    v.parse(jobRequestSchema, {
      ...request,
      max_tokens: 8192,
      ignored: "extra",
    }),
  ).toEqual({ ...request, max_tokens: 8192 });
});

test("reply and saved-session metrics retain finite nonnegative numbers only", () => {
  const metrics = {
    completion_tokens: 4,
    nested: { text: "ignored" },
    invalid: -1,
    infinite: Infinity,
    text: "4",
  };
  expect(v.parse(replySchema, { usage: metrics }).usage).toEqual({
    completion_tokens: 4,
  });
  expect(
    v.parse(sessionSchema, {
      messages: [{ role: "assistant", content: "hello", usage: metrics }],
      draft: "",
    }).messages[0].usage,
  ).toEqual({ completion_tokens: 4 });
});

test("malformed model text fails validation while empty and reasoning-only events remain valid", () => {
  expect(
    v.safeParse(replySchema, { choices: [{ delta: { content: 42 } }] }).success,
  ).toBe(false);
  expect(
    v.parse(replySchema, {
      choices: [
        {
          delta: { content: null, reasoning_content: "thinking" },
          finish_reason: null,
        },
      ],
    }).choices?.[0].delta?.reasoning_content,
  ).toBe("thinking");
  expect(v.safeParse(replySchema, { choices: [] }).success).toBe(true);
});
