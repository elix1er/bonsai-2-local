import { test, expect } from "@playwright/test";

/** Return a deterministic model event with final timing metadata. */
function stream(content = "First", finish = "stop") {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }], timings: { prompt_n: 7, predicted_n: 2, predicted_per_second: 20 } })}\r\n\r\ndata: [DONE]\r\n\r\n`;
}

/** Intercept model traffic so browser checks never consume real inference resources. */
async function setup(page, handler) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(
    "**/api/v1/chat/completions",
    handler ||
      ((route) =>
        route.fulfill({ contentType: "text/event-stream", body: stream() })),
  );
}

/** Submit through visible controls and wait for completion rather than a fixed delay. */
async function send(page, text) {
  await page.getByRole("textbox", { name: "Message Bonsai" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden();
}

test("local streaming, continuation, copy actions, and sanitized Markdown", async ({
  page,
}) => {
  const requests = [];
  await setup(page, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "text/event-stream",
      body:
        requests.length === 1
          ? stream("First", "length")
          : stream(
              ' second\n```js\nconst x = 1;\n```\n<img src=x onerror="window.bad=true">',
            ),
    });
  });
  await page.goto("/");
  await send(page, "Original question");
  await page.getByRole("button", { name: "Continue generating" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".assistant .body")).toContainText("First second");
  expect(requests[1].messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(requests[0].stream).toBe(true);
  expect(requests[0].reasoning_effort).toBe("none");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  expect(await page.evaluate(() => window.bad)).toBeUndefined();
  await expect(page.locator(".stats")).toContainText("20.0 tok/s");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "const x = 1;\n",
  );
});

test("conversation, draft, and thinking survive refresh; New chat clears them", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await send(page, "Keep this");
  await page
    .getByRole("textbox", { name: "Message Bonsai" })
    .fill("My next draft");
  await page.getByLabel("Think a little longer").check();
  await page.reload();
  await expect(page.locator(".user .body")).toHaveText("Keep this");
  await expect(page.locator(".assistant .body")).toHaveText("First");
  await expect(page.getByRole("textbox")).toHaveValue("My next draft");
  await expect(page.getByLabel("Think a little longer")).toBeChecked();
  await page.getByRole("button", { name: "New chat" }).click();
  await page.reload();
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("");
});

test("stop preserves a newer draft and retry sends the failed message once", async ({
  page,
}) => {
  let pending;
  const requests = [];
  await setup(page, (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) pending = route;
    else
      return route.fulfill({
        contentType: "text/event-stream",
        body: stream(),
      });
  });
  await page.goto("/");
  await page.getByRole("textbox").fill("First question");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox").fill("Newer draft");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry message" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("Newer draft");
  await pending.abort().catch(() => {});
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("textbox")).toHaveValue("Newer draft");
  expect(requests[1].messages).toEqual([
    { role: "user", content: "First question" },
  ]);
});

test("HTTP failure restores the prompt and leaves failed turns out of history", async ({
  page,
}) => {
  const requests = [];
  await setup(page, (route) => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: { message: "Fixture unavailable" } },
        })
      : route.fulfill({ contentType: "text/event-stream", body: stream() });
  });
  await page.goto("/");
  await send(page, "Retry me");
  await expect(page.getByRole("textbox")).toHaveValue("Retry me");
  await expect(page.locator(".error")).toHaveText("Fixture unavailable");
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden();
  expect(requests[1].messages).toHaveLength(1);
});

test("remote chat uses JSON, thinking controls, and continuation", async ({
  page,
}) => {
  const requests = [];
  await setup(page);
  let polls = 0;
  let id;
  await page.route("**/api/chat/jobs", (route) => {
    requests.push(route.request().postDataJSON());
    id = requests.at(-1).id;
    return route.fulfill({ status: 202, json: { id } });
  });
  await page.route("**/api/chat/jobs/*", (route) => {
    if (route.request().method() === "DELETE")
      return route.fulfill({ status: 204 });
    polls++;
    if (polls === 1) return route.fulfill({ json: { state: "pending" } });
    return route.fulfill({
      json: {
        state: "done",
        result: {
          choices: [
            {
              message: {
                content: requests.length === 1 ? "First" : " second",
                reasoning_content: "A thought",
              },
              finish_reason: requests.length === 1 ? "length" : "stop",
            },
          ],
        },
      },
    });
  });
  await page.goto("http://bonsai.test:5187");
  await page.getByLabel("Think a little longer").check();
  await send(page, "Remote question");
  await expect(page.locator(".assistant .body")).toHaveText("First");
  await page.getByRole("button", { name: "Continue generating" }).click();
  await expect(page.locator(".assistant .body")).toHaveText("First second");
  expect(requests[0].stream).toBe(false);
  expect(requests[0].max_tokens).toBe(8192);
  expect(requests[1].chat_template_kwargs.enable_thinking).toBe(false);
});

test("context warning shortens explicitly; excessive prompts never reach the model", async ({
  page,
}) => {
  let requests = 0;
  await setup(page, (route) => {
    requests++;
    return route.fulfill({ contentType: "text/event-stream", body: stream() });
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      "bonsai-chat-v1",
      JSON.stringify({
        draft: "",
        messages: [
          { role: "user", content: "x".repeat(74000) },
          { role: "assistant", content: "Old answer", finish: "stop" },
          { role: "user", content: "Recent question" },
          { role: "assistant", content: "Recent answer", finish: "stop" },
        ],
      }),
    ),
  );
  await page.goto("/");
  await expect(page.locator("#context-notice")).toBeVisible();
  await page.getByRole("button", { name: "Keep latest exchange" }).click();
  await expect(page.locator(".message")).toHaveCount(2);
  await expect(page.locator("#context-notice")).toBeHidden();
  await send(page, "x".repeat(100000));
  expect(requests).toBe(0);
  await expect(page.locator("#activity")).toContainText("too long");
  await expect(page.getByRole("textbox")).toHaveValue("x".repeat(100000));
});

test("reload recovers an unanswered request without losing its newer draft", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      "bonsai-chat-v1",
      JSON.stringify({
        draft: "new draft",
        messages: [
          { role: "user", content: "unfinished" },
          { role: "assistant", content: "", finish: "interrupted" },
        ],
      }),
    ),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Retry message" }),
  ).toBeVisible();
  await expect(page.locator(".user .body")).toHaveText("unfinished");
  await expect(page.getByRole("textbox")).toHaveValue("new draft");
});

test("partial failures stay resumable, while older answers cannot be extended", async ({
  page,
}) => {
  let count = 0;
  await setup(page, (route) => {
    count++;
    return route.fulfill({
      contentType: "text/event-stream",
      body:
        count === 1
          ? 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
          : stream("Later", "length"),
    });
  });
  await page.goto("/");
  await send(page, "First");
  await expect(page.locator(".assistant .body")).toHaveText("Partial");
  await expect(
    page.getByRole("button", { name: "Continue generating" }),
  ).toHaveCount(1);
  await send(page, "Second");
  await expect(
    page.getByRole("button", { name: "Continue generating" }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".assistant")
      .first()
      .getByRole("button", { name: "Continue generating" }),
  ).toHaveCount(0);
});

test("model health recovers on focus, and composer has visible keyboard focus", async ({
  page,
}) => {
  let online = false;
  await setup(page);
  await page.route("**/api/health", (route) =>
    route.fulfill({ status: online ? 200 : 503, json: {} }),
  );
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Model offline");
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#connection")).toHaveText("Local & ready");
  await page.getByRole("textbox").focus();
  expect(
    await page
      .getByRole("textbox")
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
});

test("Stop cancels a remote job and preserves the newer draft", async ({
  page,
}) => {
  await setup(page);
  let id;
  let cancelled = false;
  await page.route("**/api/chat/jobs", (route) => {
    id = route.request().postDataJSON().id;
    return route.fulfill({ status: 202, json: { id } });
  });
  await page.route("**/api/chat/jobs/*", (route) => {
    if (route.request().method() === "DELETE") {
      cancelled = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { state: "pending" } });
  });
  await page.goto("http://bonsai.test:5187");
  await page.getByRole("textbox").fill("Remote pending");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox").fill("Newer draft");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry message" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("Newer draft");
  await expect.poll(() => cancelled).toBe(true);
});

test("New chat in one tab prevents an active second tab from restoring cleared text", async ({
  page,
  context,
}) => {
  await setup(page);
  await page.goto("/");
  await send(page, "Old conversation");
  const second = await context.newPage();
  let pending;
  await setup(second, (route) => {
    pending = route;
  });
  await second.goto("/");
  await second.getByRole("textbox").fill("In-flight question");
  await second.getByRole("button", { name: "Send message" }).click();
  await expect(
    second.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await second.getByRole("textbox").fill("Draft in the other tab");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(second.locator(".message")).toHaveCount(0);
  await expect(
    second.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden();
  await pending.abort().catch(() => {});
  await second.reload();
  await page.reload();
  await expect(second.locator(".message")).toHaveCount(0);
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(second.getByRole("textbox")).toHaveValue("");
});

test("Stop cancels a remote request before its start acknowledgement arrives", async ({
  page,
}) => {
  await setup(page);
  let pending;
  let id;
  let cancelled = false;
  await page.route("**/api/chat/jobs", (route) => {
    pending = route;
    id = route.request().postDataJSON().id;
  });
  await page.route("**/api/chat/jobs/*", (route) => {
    cancelled =
      route.request().method() === "DELETE" &&
      route.request().url().endsWith(id);
    return route.fulfill({ status: 204 });
  });
  await page.goto("http://bonsai.test:5187");
  await page.getByRole("textbox").fill("Cancel during startup");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => id).toBeTruthy();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(
    page.getByRole("button", { name: "Retry message" }),
  ).toBeVisible();
  await pending.abort().catch(() => {});
});
