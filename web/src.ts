import { errorMessage, type Message, type ModelMessage } from "./contracts.ts";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";
import treeUrl from "../assets/tree.svg";
import { CONTEXT_SIZE, contextUsage, requestChat } from "./chat.ts";
import {
  loadSession,
  saveSession,
  clearSession,
  sessionIsCurrent,
  RESET_KEY,
} from "./session.ts";

const remote = !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const idleText = remote ? "Hosted on a Mac" : "Only on this device";
const readyText = remote ? "Connected to Bonsai" : "Local & ready";

const tree = `<img src="${treeUrl}" alt="" />`;

element("#app", HTMLElement).innerHTML = `
<header>
  <div class="brand">${tree}<span>bonsai<span class="edition">2 / local</span></span></div>
  <div class="header-right">
    <span id="connection" role="status">Connecting</span>
    <button id="clear" class="quiet">New chat <span aria-hidden="true">↗</span></button>
  </div>
</header>
<main>
  <section id="welcome">
    <div class="tree">${tree}</div>
    <p class="eyebrow">LOCAL CHAT WITH BONSAI 2</p>
    <h1>What’s on your mind?</h1>
    <p class="intro">${remote ? "Running on your friend’s Mac." : "Running right here, on your Mac."}</p>
    <div class="suggestions">
      <button>Explain something simply</button>
      <button>Help me write some code</button>
      <button>Think through an idea</button>
    </div>
  </section>
  <section id="messages" aria-label="Conversation"></section>
</main>
<div class="dock">
  <div id="context-notice" class="notice" hidden>
    <span id="context-text"></span>
    <button id="shorten" type="button" class="quiet">Keep latest exchange</button>
  </div>
  <p id="save-notice" class="notice" role="status" hidden></p>
  <form id="composer">
    <label class="sr-only" for="prompt">Message Bonsai</label>
    <textarea id="prompt" rows="1" placeholder="Ask Bonsai anything…" required></textarea>
    <div class="composer-bottom">
      <label class="thinking">
        <input id="thinking" type="checkbox"/>
        <span class="switch"></span>Think a little longer
      </label>
      <button id="send" type="submit" aria-label="Send message">↑</button>
      <button id="stop" type="button" hidden>Stop <span aria-hidden="true">■</span></button>
    </div>
  </form>
  <div class="footnote">
    <span>Bonsai 2 · saved in this browser</span>
    <span id="activity" role="status">${idleText}</span>
    <span>Enter to send <span class="key">↵</span></span>
  </div>
</div>`;

/** Validate the static DOM once at each lookup and preserve its concrete element type. */
function element<T extends HTMLElement>(
  selector: string,
  constructor: { new (): T },
): T {
  const node = document.querySelector(selector);
  if (!(node instanceof constructor))
    throw new Error(`Missing UI element: ${selector}`);
  return node;
}
const $ = (selector: string) => element(selector, HTMLElement);
const thinkingInput = element("#thinking", HTMLInputElement);
const shortenButton = element("#shorten", HTMLButtonElement);
const clearButton = element("#clear", HTMLButtonElement);
const composer = element("#composer", HTMLFormElement);
const prompt = element("#prompt", HTMLTextAreaElement);
const saved = loadSession();
let messages: Message[] = saved?.messages || [];
let controller: AbortController | null = null;
let retryText = saved?.retryText || "";
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let sessionGeneration = 0;
prompt.value = saved?.draft || "";
thinkingInput.checked = saved?.thinking || false;

/** Save one browser session and report quota or access failures. */
function persist() {
  if (!sessionIsCurrent()) {
    resetOtherTab();
    return;
  }
  clearTimeout(saveTimer);
  const ok = saveSession({
    messages,
    draft: prompt.value,
    thinking: thinkingInput.checked,
    retryText,
  });
  $("#save-notice").hidden = ok;
  $("#save-notice").textContent =
    "Browser storage is unavailable or full. This chat will be lost on refresh.";
}

/** Batch streamed updates and typing instead of writing storage for every chunk. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

/** Grow the composer to 180 pixels, then let its text scroll. */
function resize() {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}

/** Reserve reply space and offer explicit removal of older exchanges. */
function updateContext() {
  const usage = contextUsage(
    [...messages, { content: prompt.value }],
    thinkingInput.checked,
  );
  $("#context-notice").hidden = !usage.nearLimit;
  $("#context-text").textContent = usage.overLimit
    ? "This chat may exceed the 32k context window with room for a reply. Shorten it or start a new chat."
    : "This chat is nearing the 32k context window. Keep the latest exchange or start a new chat.";
  shortenButton.disabled = !!controller || messages.length <= 2;
}

/** Follow the answer only when the caller decides the reader is near the bottom. */
function scroll() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
}

/** Report clipboard permission failures without discarding the displayed text. */
async function copy(button: HTMLButtonElement, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = button.dataset.label || "Copy";
  }, 1500);
}

/** Resolve text at click time so appended answers copy their latest content. */
function copyButton(label: string, text: () => string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet copy";
  button.textContent = button.dataset.label = label;
  button.onclick = () => copy(button, text());
  return button;
}

/** Sanitize generated HTML and attach code-copy controls after generation ends. */
function markdown(node: HTMLElement, text: string, complete: boolean) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
  if (complete)
    node.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (code)
        pre.before(copyButton("Copy code", () => code.textContent || ""));
    });
}

/** Build one message and keep its elements together for streaming updates. */
function bubble(message: Message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  const name = document.createElement("div");
  name.className = "speaker";
  name.textContent = message.role === "user" ? "YOU" : "BONSAI";
  const body = document.createElement("div");
  body.className = "body";
  article.append(name, body);
  $("#messages").append(article);
  if (message.role === "user") {
    body.textContent = message.content;
    return { kind: message.role, article, body };
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Thoughts";
  const thought = document.createElement("div");
  thought.className = "thought";
  details.append(summary, thought);
  article.insertBefore(details, body);
  const meta = document.createElement("div");
  meta.className = "meta";
  const stats = document.createElement("div");
  stats.className = "stats";
  const actions = document.createElement("div");
  actions.className = "actions";
  meta.append(stats, actions);
  article.append(meta);
  return {
    kind: message.role,
    article,
    body,
    details,
    summary,
    thought,
    stats,
    actions,
  };
}

type AnswerView = Extract<ReturnType<typeof bubble>, { kind: "assistant" }>;

/** Render content, reasoning, and metrics for the latest request on an answer. */
function renderAnswer(
  view: AnswerView,
  message: Message,
  live = false,
  elapsed = 0,
) {
  view.details.hidden = !message.thought;
  view.thought.textContent = message.thought || "";
  view.summary.textContent =
    live && !message.content ? "Thinking…" : "Thoughts";
  if (message.content) markdown(view.body, message.content, !live);
  else
    view.body.textContent = live
      ? message.thought
        ? "Thinking…"
        : remote
          ? "Waiting for the complete reply…"
          : "…"
      : message.thought
        ? "Thinking ended without a final answer. Continue with thinking off."
        : "No answer was returned.";
  const timings = message.timings;
  const tokens = message.usage?.completion_tokens ?? timings?.predicted_n;
  const inputTokens = message.usage?.prompt_tokens ?? timings?.prompt_n;
  const estimated =
    message.estimatedTokens ??
    Math.ceil(
      ((message.content || "").length + (message.thought || "").length) / 3,
    );
  const speed = timings?.predicted_per_second;
  const badges = [];
  if (tokens !== undefined) badges.push(`${tokens} tokens`);
  else if (estimated) badges.push(`~${estimated} tokens`);
  if (speed) badges.push(`${speed.toFixed(1)} tok/s`);
  else if (live && estimated && elapsed)
    badges.push(`~${(estimated / elapsed).toFixed(1)} tok/s`);
  if (inputTokens !== undefined && tokens !== undefined)
    badges.push(`${inputTokens + tokens} / ${CONTEXT_SIZE} context`);
  if (!live && message.finish)
    badges.push(
      message.finish === "length"
        ? "Reply limit reached"
        : message.finish === "interrupted"
          ? "Interrupted"
          : "",
    );
  view.stats.textContent = badges.length
    ? `Latest request · ${badges.filter(Boolean).join(" · ")}`
    : "";
  view.actions.replaceChildren();
  if (live) return;
  if (message.content)
    view.actions.append(copyButton("Copy answer", () => message.content));
  // Extending an older answer would invalidate the exchanges after it.
  if (
    message === messages.at(-1) &&
    (message.finish === "length" || message.finish === "interrupted")
  ) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-continue";
    button.textContent = "Continue generating";
    button.onclick = () => {
      if (controller) return;
      const request: ModelMessage[] = [
        ...messages.map(({ role, content }) => ({ role, content })),
        {
          role: "user",
          content:
            "Continue directly from where you stopped. Do not repeat anything previously written, resume immediately.",
        },
      ];
      runChat(request, message, view, true);
    };
    view.actions.append(button);
  }
}

/** Retry the unanswered prompt while preserving a separately typed draft. */
function renderRetry(view: AnswerView, text: string, stopped = false) {
  view.body.textContent = stopped
    ? "Stopped before an answer arrived."
    : "Could not finish this reply.";
  view.actions.replaceChildren();
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet";
  retry.textContent = "Retry message";
  retry.onclick = () => submitText(text, true);
  view.actions.append(retry);
}

/** Rebuild saved messages and the unanswered prompt, with continuation on the last answer. */
function renderConversation() {
  $("#messages").replaceChildren();
  $("#welcome").hidden = !!(messages.length || retryText);
  let lastView: AnswerView | undefined;
  for (const message of messages) {
    const view = bubble(message);
    if (view.kind === "assistant") {
      lastView = view;
      renderAnswer(view, message);
    }
  }
  if (retryText) {
    bubble({ role: "user", content: retryText });
    const view = bubble({ role: "assistant", content: "" });
    if (view.kind !== "assistant") throw new Error("Expected answer view");
    view.details.hidden = true;
    renderRetry(view, retryText, true);
  }
  updateContext();
  return lastView;
}

/** Allow one request at a time while keeping Stop and draft editing available. */
function setBusy(busy: boolean) {
  $("#send").hidden = busy;
  $("#stop").hidden = !busy;
  clearButton.disabled = busy;
  thinkingInput.disabled = busy;
  shortenButton.disabled = busy || messages.length <= 2;
  document
    .querySelectorAll<HTMLButtonElement>(".btn-continue")
    .forEach((button) => {
      button.disabled = busy;
    });
}

/** Refresh the readiness badge without changing the conversation. */
async function health() {
  try {
    const response = await fetch("/api/health", {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error();
    $("#connection").textContent = readyText;
    $("#connection").className = "online";
  } catch {
    $("#connection").textContent = "Model offline";
    $("#connection").className = "offline";
  }
}

/** Read completion state after the asynchronous chunk callback has updated it. */
const replyLimited = (message: Message) => message.finish === "length";

/** Append a request to its answer while keeping a separately typed draft intact. */
async function runChat(
  request: ModelMessage[],
  message: Message,
  view: AnswerView,
  continuation = false,
) {
  if (controller) return;
  const thinking = continuation ? false : thinkingInput.checked;
  if (contextUsage(request, thinking).overLimit) {
    $("#activity").textContent =
      "Chat too long. Shorten it or start a new chat.";
    return;
  }
  const generation = sessionGeneration;
  controller = new AbortController();
  setBusy(true);
  message.finish = "interrupted";
  delete message.timings;
  delete message.usage;
  persist();
  const start = performance.now();
  let generatedCharacters = 0;
  message.estimatedTokens = 0;
  renderAnswer(view, message, true);
  $("#activity").textContent = remote
    ? "Waiting for reply…"
    : thinking
      ? "Thinking…"
      : "Replying…";
  try {
    await requestChat(request, {
      thinking,
      stream: !remote,
      signal: controller.signal,
      onChunk(chunk) {
        if (generation !== sessionGeneration) return;
        generatedCharacters +=
          (chunk.content || "").length + (chunk.reasoning_content || "").length;
        message.estimatedTokens = Math.ceil(generatedCharacters / 3);
        message.content += chunk.content || "";
        message.thought =
          (message.thought || "") + (chunk.reasoning_content || "");
        if (chunk.finish) message.finish = chunk.finish;
        if (chunk.timings) message.timings = chunk.timings;
        if (chunk.usage) message.usage = chunk.usage;
        const nearBottom =
          window.innerHeight + window.scrollY >=
          document.body.scrollHeight - 140;
        renderAnswer(view, message, true, (performance.now() - start) / 1000);
        scheduleSave();
        if (nearBottom) scroll();
      },
    });
    if (generation !== sessionGeneration) return;
    if (!message.content && !message.thought)
      throw new Error("The model returned an empty answer.");
    $("#activity").textContent = replyLimited(message)
      ? "Reply limit reached · Continue is available"
      : idleText;
    $("#connection").textContent = readyText;
    $("#connection").className = "online";
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    if (generation !== sessionGeneration) return;
    message.finish = "interrupted";
    if (!message.content && !continuation) {
      messages.splice(-2);
      if (!prompt.value) {
        prompt.value = request.at(-1)?.content || "";
        resize();
      }
      retryText = request.at(-1)?.content || "";
      view.details.hidden = !message.thought;
      renderRetry(view, retryText, aborted);
    }
    if (!aborted) {
      const note = document.createElement("p");
      note.className = "error";
      note.textContent = errorMessage(error);
      view.article.append(note);
      health();
    }
    $("#activity").textContent = aborted
      ? "Stopped"
      : "Reply failed · retry when ready";
  } finally {
    controller = null;
    setBusy(false);
    if (messages.includes(message)) renderAnswer(view, message);
    persist();
    updateContext();
    prompt.focus();
  }
}

/** Send text-only model history and retain the chosen draft during retries. */
function submitText(text: string, preserveDraft = false) {
  if (!text || controller) return;
  const request: ModelMessage[] = [
    ...messages.map(({ role, content }) => ({ role, content })),
    { role: "user", content: text },
  ];
  if (contextUsage(request, thinkingInput.checked).overLimit) {
    $("#activity").textContent =
      "Message too long for the estimated context budget.";
    updateContext();
    return;
  }
  retryText = "";
  messages.push({ role: "user", content: text });
  const message: Message = {
    role: "assistant",
    content: "",
    thought: "",
    finish: "interrupted",
  };
  messages.push(message);
  // Re-render so only the most recent answer can be continued.
  const view = renderConversation();
  if (!view) throw new Error("Expected latest answer view");
  if (!preserveDraft || prompt.value.trim() === text) prompt.value = "";
  resize();
  scroll();
  runChat(request, message, view);
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitText(prompt.value.trim());
});
prompt.addEventListener("input", () => {
  resize();
  updateContext();
  scheduleSave();
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!controller) composer.requestSubmit();
  }
});
thinkingInput.onchange = () => {
  updateContext();
  persist();
};
$("#stop").onclick = () => controller?.abort();
clearButton.onclick = () => {
  if (controller) return;
  clearTimeout(saveTimer);
  messages = [];
  retryText = "";
  prompt.value = "";
  clearSession();
  sessionGeneration++;
  renderConversation();
  resize();
  persist();
  $("#activity").textContent = idleText;
  prompt.focus();
};
shortenButton.onclick = () => {
  if (controller) return;
  messages = messages.slice(-2);
  renderConversation();
  persist();
  $("#activity").textContent = "Earlier exchanges removed from this chat.";
};
const presets = [
  "Explain how a computer remembers things, using a simple everyday analogy.",
  "Help me write a small TypeScript script. First ask me what I want it to do.",
  "Help me think through an idea. Ask me one useful question to get started.",
];
$(".suggestions")
  .querySelectorAll<HTMLButtonElement>("button")
  .forEach((button, index) => {
    button.onclick = () => {
      prompt.value = presets[index];
      resize();
      updateContext();
      persist();
      prompt.focus();
    };
  });

// A reload can interrupt a request before any answer is saved.
const last = messages.at(-1);
if (last?.finish === "interrupted" && !last.content) {
  const user = messages.at(-2);
  retryText = user?.content || "";
  messages.splice(-2);
  if (!prompt.value) prompt.value = user?.content || "";
}
renderConversation();
resize();
persist();
health();
setInterval(() => {
  if (!document.hidden) health();
}, 15000);
window.addEventListener("focus", health);
window.addEventListener("pagehide", () => {
  controller?.abort();
  persist();
});

/** Apply New chat across tabs and abort a reply belonging to the cleared session. */
function resetOtherTab() {
  clearTimeout(saveTimer);
  sessionGeneration++;
  controller?.abort();
  messages = [];
  retryText = "";
  prompt.value = "";
  loadSession();
  renderConversation();
  resize();
  $("#activity").textContent = "Chat cleared in another tab.";
}
window.addEventListener("storage", (event) => {
  if (event.key === RESET_KEY) resetOtherTab();
});
