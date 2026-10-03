export const RESET_KEY = "bonsai-chat-reset-v1";
let revision = null;
const KEY = "bonsai-chat-v1";

/** Reject malformed saved data instead of putting it into model requests. */
export function loadSession(storage) {
  try {
    storage ??= globalThis.localStorage;
    revision = storage.getItem(RESET_KEY);
    const saved = JSON.parse(storage.getItem(KEY));
    if (
      !saved ||
      (saved.revision ?? null) !== revision ||
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

/** Save this tab's session only while its reset revision is current. */
export function saveSession(session, storage) {
  try {
    storage ??= globalThis.localStorage;
    if (!sessionIsCurrent(storage)) return false;
    storage.setItem(KEY, JSON.stringify({ ...session, revision }));
    return true;
  } catch {
    return false;
  }
}

/** Advance the reset marker so other tabs cannot restore the cleared conversation. */
export function clearSession(storage) {
  try {
    storage ??= globalThis.localStorage;
    storage.removeItem(KEY);
    revision = `${Date.now()}-${Math.random()}`;
    storage.setItem(RESET_KEY, revision);
    return true;
  } catch {
    return false;
  }
}

/** Check the reset marker synchronously so stale tabs cannot restore cleared text. */
export function sessionIsCurrent(storage) {
  try {
    storage ??= globalThis.localStorage;
    return storage.getItem(RESET_KEY) === revision;
  } catch {
    return true;
  }
}
