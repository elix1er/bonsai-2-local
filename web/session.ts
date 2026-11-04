import * as v from "valibot";
import { sessionSchema, type Session } from "./contracts.ts";
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const RESET_KEY = "bonsai-chat-reset-v1";
let revision: string | null = null;
const KEY = "bonsai-chat-v1";

/** Reject malformed saved data instead of putting it into model requests. */
export function loadSession(storage?: SessionStorage): Session | null {
  try {
    storage ??= globalThis.localStorage;
    revision = storage.getItem(RESET_KEY);
    const raw = storage.getItem(KEY);
    const result = v.safeParse(sessionSchema, raw ? JSON.parse(raw) : null);
    if (!result.success) return null;
    const saved = result.output;
    if (
      (saved.revision ?? null) !== revision ||
      saved.messages.length % 2 ||
      !saved.messages.every(
        (message, index) => message.role === (index % 2 ? "assistant" : "user"),
      )
    )
      return null;
    return {
      messages: saved.messages.map((message) =>
        message.role === "assistant"
          ? {
              ...message,
              thought: message.thought || "",
              finish: message.finish || "stop",
            }
          : { role: message.role, content: message.content },
      ),
      draft: saved.draft,
      thinking: saved.thinking === true,
      retryText: saved.retryText || "",
    };
  } catch {
    return null;
  }
}

/** Save this tab's session only while its reset revision is current. */
export function saveSession(session: Session, storage?: SessionStorage) {
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
export function clearSession(storage?: SessionStorage) {
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
export function sessionIsCurrent(storage?: SessionStorage) {
  try {
    storage ??= globalThis.localStorage;
    return storage.getItem(RESET_KEY) === revision;
  } catch {
    return true;
  }
}
