const KEY = "bonsai-chat-v1";

/** Reject malformed saved data instead of putting it into model requests. */
export function loadSession(storage) {
  try {
    storage ??= globalThis.localStorage;
    const saved = JSON.parse(storage.getItem(KEY));
    if (
      !saved ||
      !Array.isArray(saved.messages) ||
      typeof saved.draft !== "string"
    )
      return null;
    if (
      !saved.messages.every(
        (message, index) =>
          message &&
          message.role === (index % 2 ? "assistant" : "user") &&
          typeof message.content === "string" &&
          (message.thought === undefined ||
            typeof message.thought === "string") &&
          (message.finish === undefined ||
            ["stop", "length", "interrupted", "error"].includes(
              message.finish,
            )),
      ) ||
      saved.messages.length % 2
    )
      return null;
    return {
      messages: saved.messages.map((message) => {
        const clean = { role: message.role, content: message.content };
        if (message.role === "assistant") {
          clean.thought = message.thought || "";
          clean.finish = message.finish || "stop";
          if (
            typeof message.estimatedTokens === "number" &&
            Number.isFinite(message.estimatedTokens) &&
            message.estimatedTokens >= 0
          )
            clean.estimatedTokens = message.estimatedTokens;
          for (const field of ["timings", "usage"]) {
            if (message[field] && typeof message[field] === "object") {
              clean[field] = Object.fromEntries(
                Object.entries(message[field]).filter(
                  ([, value]) =>
                    typeof value === "number" &&
                    Number.isFinite(value) &&
                    value >= 0,
                ),
              );
            }
          }
        }
        return clean;
      }),
      draft: saved.draft,
      thinking: saved.thinking === true,
      retryText: typeof saved.retryText === "string" ? saved.retryText : "",
    };
  } catch {
    return null;
  }
}

export function saveSession(session, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(storage) {
  try {
    storage ??= globalThis.localStorage;
    storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
