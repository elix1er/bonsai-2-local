export const CONTEXT_SIZE = 32768;
/** Give thinking requests more output space within the fixed context window. */
export const replyLimit = (thinking) => (thinking ? 8192 : 4096);

/** Reserve output space and allow for chat-template overhead in this estimate. */
export function contextUsage(messages, thinking) {
  const input = messages.reduce(
    (total, message) => total + Math.ceil(message.content.length / 3) + 16,
    0,
  );
  const total = input + replyLimit(thinking);
  return {
    input,
    total,
    nearLimit: total >= CONTEXT_SIZE * 0.85,
    overLimit: total > CONTEXT_SIZE,
  };
}

/** Read OpenAI-compatible streaming or completed replies through the same callback. */
export async function requestChat(
  messages,
  { thinking, stream, signal, onChunk },
) {
  const body = {
    model: "bonsai-2-27b",
    messages,
    stream,
    max_tokens: replyLimit(thinking),
    temperature: thinking ? 1 : 0.7,
    top_p: thinking ? 0.95 : 0.8,
    reasoning_effort: thinking ? "medium" : "none",
    chat_template_kwargs: { enable_thinking: thinking },
  };
  if (!stream) {
    const result = await remoteReply(body, signal);
    const choice = result.choices?.[0];
    if (!choice?.message || !choice.finish_reason)
      throw new Error("The server returned an incomplete reply.");
    onChunk({
      ...choice.message,
      finish: choice.finish_reason,
      timings: result.timings,
      usage: result.usage,
    });
    return;
  }
  const response = await fetch("/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json()).error?.message || message;
    } catch {
      /* Use HTTP status for non-JSON errors. */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("The server returned an empty reply.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let done = false;
  /** Apply a complete SSE event and distinguish its finish status from transport EOF. */
  function consume(event) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error("The server returned an unreadable streaming event.");
    }
    if (chunk.error)
      throw new Error(chunk.error.message || "Generation failed");
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finished = true;
    onChunk({
      ...choice?.delta,
      finish: choice?.finish_reason,
      timings: chunk.timings,
      usage: chunk.usage,
    });
  }
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let separator;
      while (!done && (separator = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (!done && buffer.trim()) consume(buffer);
    if (!finished)
      throw new Error("Connection ended before the answer finished.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Start once, poll with short requests, and cancel the job on failure or Stop. */
async function remoteReply(body, signal) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  /** Bound each tunnel request while leaving generation independent of it. */
  async function json(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data)
      throw Object.assign(
        new Error(
          data?.error?.message ||
            `Request failed (${response.status}). Retry your message.`,
        ),
        { status: response.status },
      );
    return data;
  }
  try {
    await json("/api/chat/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, id }),
    });
    let failures = 0;
    while (true) {
      let job;
      try {
        job = await json(`/api/chat/jobs/${id}`);
        failures = 0;
      } catch (error) {
        const permanent =
          error.status >= 400 && error.status < 500 && error.status !== 429;
        if (signal?.aborted || permanent || ++failures >= 3) throw error;
      }
      if (job?.state === "done") return job.result;
      if (job && job.state !== "pending")
        throw new Error(job.error?.message || "Remote generation failed.");
      await new Promise((resolve, reject) => {
        function abort() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 1000);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    if (id)
      fetch(`/api/chat/jobs/${id}`, {
        method: "DELETE",
        keepalive: true,
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
  }
}
