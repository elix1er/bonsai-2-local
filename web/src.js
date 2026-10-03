import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";
import treeUrl from "../assets/tree.svg";
import { CONTEXT_SIZE, contextUsage, requestChat } from "./chat.js";
import { loadSession, saveSession, clearSession } from "./session.js";

const remote = !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const idleText = remote
  ? "Hosted on a Mac · via Cloudflare"
  : "Only on this device";
const readyText = remote ? "Connected to Bonsai" : "Local & ready";

const tree = `<img src="${treeUrl}" alt="" />`;

document.querySelector("#app").innerHTML = `
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

const $ = (selector) => document.querySelector(selector);
const prompt = $("#prompt");
const saved = loadSession();
let messages = saved?.messages || [];
let controller = null;
let retryText = saved?.retryText || "";
let saveTimer;
prompt.value = saved?.draft || "";
$("#thinking").checked = saved?.thinking || false;

function persist() {
  clearTimeout(saveTimer);
  const ok = saveSession({
    messages,
    draft: prompt.value,
    thinking: $("#thinking").checked,
    retryText,
  });
  $("#save-notice").hidden = ok;
  $("#save-notice").textContent =
    "Browser storage is unavailable or full. This chat will be lost on refresh.";
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

function resize() {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}

function updateContext() {
  const usage = contextUsage(
    [...messages, { content: prompt.value }],
    $("#thinking").checked,
  );
  $("#context-notice").hidden = !usage.nearLimit;
  $("#context-text").textContent = usage.overLimit
    ? "This chat may exceed the 32k context window with room for a reply. Shorten it or start a new chat."
    : "This chat is nearing the 32k context window. Keep the latest exchange or start a new chat.";
  $("#shorten").disabled = !!controller || messages.length <= 2;
}

function scroll() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
}

async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1500);
}

function copyButton(label, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet copy";
  button.textContent = button.dataset.label = label;
  button.onclick = () => copy(button, text());
  return button;
}

function markdown(node, text, complete) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text));
  if (complete)
    node.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (code) pre.before(copyButton("Copy code", () => code.textContent));
    });
}

/** Build one message and keep its elements together for streaming updates. */
function bubble(message) {
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
    return { article, body };
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
  return { article, body, details, summary, thought, stats, actions };
}

function renderAnswer(view, message, live = false, elapsed = 0) {
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
    ["length", "interrupted"].includes(message.finish)
  ) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-continue";
    button.textContent = "Continue generating";
    button.onclick = () => {
      if (controller) return;
      const request = [
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

function renderRetry(view, text, stopped = false) {
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

function renderConversation() {
  $("#messages").replaceChildren();
  $("#welcome").hidden = !!messages.length;
  let lastView;
  for (const message of messages) {
    lastView = bubble(message);
    if (message.role === "assistant") renderAnswer(lastView, message);
  }
  if (retryText) {
    bubble({ role: "user", content: retryText });
    const view = bubble({ role: "assistant", content: "" });
    view.details.hidden = true;
    renderRetry(view, retryText, true);
  }
  updateContext();
  return lastView;
}

function setBusy(busy) {
  $("#send").hidden = busy;
  $("#stop").hidden = !busy;
  $("#clear").disabled = busy;
  $("#thinking").disabled = busy;
  $("#shorten").disabled = busy || messages.length <= 2;
  document.querySelectorAll(".btn-continue").forEach((button) => {
    button.disabled = busy;
  });
}

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

/** Append a request to its answer while keeping a separately typed draft intact. */
async function runChat(request, message, view, continuation = false) {
  if (controller) return;
  const thinking = continuation ? false : $("#thinking").checked;
  if (contextUsage(request, thinking).overLimit) {
    $("#activity").textContent =
      "Chat too long. Shorten it or start a new chat.";
    return;
  }
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
    if (!message.content && !message.thought)
      throw new Error("The model returned an empty answer.");
    $("#activity").textContent =
      message.finish === "length"
        ? "Reply limit reached · Continue is available"
        : idleText;
    $("#connection").textContent = readyText;
    $("#connection").className = "online";
  } catch (error) {
    message.finish = "interrupted";
    if (!message.content && !continuation) {
      messages.splice(-2);
      if (!prompt.value) {
        prompt.value = request.at(-1).content;
        resize();
      }
      retryText = request.at(-1).content;
      view.details.hidden = !message.thought;
      renderRetry(view, retryText, error.name === "AbortError");
    }
    if (error.name !== "AbortError") {
      const note = document.createElement("p");
      note.className = "error";
      note.textContent = error.message;
      view.article.append(note);
      health();
    }
    $("#activity").textContent =
      error.name === "AbortError"
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

function submitText(text, preserveDraft = false) {
  if (!text || controller) return;
  const request = [
    ...messages.map(({ role, content }) => ({ role, content })),
    { role: "user", content: text },
  ];
  if (contextUsage(request, $("#thinking").checked).overLimit) {
    $("#activity").textContent =
      "Message too long for the estimated context budget.";
    updateContext();
    return;
  }
  retryText = "";
  messages.push({ role: "user", content: text });
  const message = {
    role: "assistant",
    content: "",
    thought: "",
    finish: "interrupted",
  };
  messages.push(message);
  // Re-render so only the most recent answer can be continued.
  const view = renderConversation();
  if (!preserveDraft || prompt.value.trim() === text) prompt.value = "";
  resize();
  scroll();
  runChat(request, message, view);
}

$("#composer").addEventListener("submit", (event) => {
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
    if (!controller) $("#composer").requestSubmit();
  }
});
$("#thinking").onchange = () => {
  updateContext();
  persist();
};
$("#stop").onclick = () => controller?.abort();
$("#clear").onclick = () => {
  if (controller) return;
  clearTimeout(saveTimer);
  messages = [];
  retryText = "";
  prompt.value = "";
  clearSession();
  renderConversation();
  resize();
  persist();
  $("#activity").textContent = idleText;
  prompt.focus();
};
$("#shorten").onclick = () => {
  if (controller) return;
  messages = messages.slice(-2);
  renderConversation();
  persist();
  $("#activity").textContent = "Earlier exchanges removed from this chat.";
};
const presets = [
  "Explain how a computer remembers things, using a simple everyday analogy.",
  "Help me write a small Python script. First ask me what I want it to do.",
  "Help me think through an idea. Ask me one useful question to get started.",
];
$(".suggestions")
  .querySelectorAll("button")
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
  retryText = user.content;
  messages.splice(-2);
  if (!prompt.value) prompt.value = user.content;
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
