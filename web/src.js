import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';

const remote = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const idleText = remote ? 'Hosted on a Mac · via Cloudflare' : 'Only on this device';
const readyText = remote ? 'Connected to Bonsai' : 'Local & ready';
const CTX_SIZE = 32768;

const tree = `<svg viewBox="0 0 120 120" fill="none" aria-hidden="true"><path d="M63 87c-15-23 15-28 2-50M60 65 38 49M65 53l22-13" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M30 86h61l-9 17H39z" fill="currentColor"/><path d="M23 106h76" stroke="currentColor" stroke-width="2"/><ellipse cx="34" cy="44" rx="23" ry="13" fill="#91a780"/><ellipse cx="84" cy="35" rx="25" ry="14" fill="#577551"/><ellipse cx="57" cy="23" rx="28" ry="16" fill="#304f38"/></svg>`;

document.querySelector('#app').innerHTML = `
<header>
  <a class="brand" href="/">${tree}<span>bonsai<span class="edition">2 / local</span></span></a>
  <div class="header-right">
    <span id="connection" role="status">Connecting</span>
    <button id="clear" class="quiet">New chat <span aria-hidden="true">↗</span></button>
  </div>
</header>
<main>
  <section id="welcome">
    <div class="tree">${tree}</div>
    <p class="eyebrow">SMALL FOOTPRINT. ROOM TO THINK.</p>
    <h1>What’s on your mind?</h1>
    <p class="intro">A little space for big ideas.<br>${remote ? "Running on your friend’s Mac." : "Running right here, on your Mac."}</p>
    <div class="suggestions">
      <button>Explain something simply</button>
      <button>Help me write some code</button>
      <button>Think through an idea</button>
    </div>
  </section>
  <section id="messages" aria-label="Conversation"></section>
</main>
<div class="dock">
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
    <span>Bonsai 2 · 27B · 32k ctx</span>
    <span id="activity" role="status">${idleText}</span>
    <span>Enter to send <span class="key">↵</span></span>
  </div>
</div>`;

const $ = s => document.querySelector(s);
let history = [];
let controller = null;
const prompt = $('#prompt');

const presets = [
  'Explain how a computer remembers things, using a simple everyday analogy.',
  'Help me write a small Python script. First ask me what I want it to do.',
  'Help me think through an idea. Ask me one useful question to get started.'
];

$('.suggestions').querySelectorAll('button').forEach((b, i) => {
  b.onclick = () => { prompt.value = presets[i]; resize(); prompt.focus(); };
});

function resize() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}

prompt.addEventListener('input', resize);
prompt.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!controller) $('#composer').requestSubmit();
  }
});

$('#stop').onclick = () => controller?.abort();

$('#clear').onclick = () => {
  if (controller) return;
  history = [];
  $('#messages').replaceChildren();
  $('#welcome').hidden = false;
  $('#activity').textContent = idleText;
  prompt.focus();
};

function scroll() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
}

function markdown(node, text) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text));
}

async function health() {
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw Error();
    $('#connection').textContent = readyText;
    $('#connection').className = 'online';
  } catch {
    $('#connection').textContent = 'Model offline';
    $('#connection').className = 'offline';
  }
}
health();

function bubble(role, text = '') {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const name = document.createElement('div');
  name.className = 'speaker';
  name.textContent = role === 'user' ? 'YOU' : 'BONSAI';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  article.append(name, body);
  $('#messages').append(article);
  return { article, body };
}

async function runChat({
  messagesToSend,
  targetArticle,
  targetBody,
  targetDetails,
  targetThought,
  targetSummary,
  targetMeta,
  targetStats,
  targetActions,
  assistantIndex,
  existingContent = '',
  existingThought = '',
  isContinuation = false
}) {
  const thinking = isContinuation ? false : $('#thinking').checked;
  const maxTokens = thinking ? 8192 : 4096;

  controller = new AbortController();
  $('#send').hidden = true;
  $('#stop').hidden = false;
  $('#clear').disabled = true;
  $('#thinking').disabled = true;

  if (targetActions) targetActions.innerHTML = '';
  if (targetMeta) targetMeta.hidden = false;

  const startTime = performance.now();
  let content = existingContent;
  let reasoning = existingThought;
  let tokenCount = 0;
  let thoughtTokens = 0;
  let contentTokens = 0;
  let finish = '';
  let serverTimings = null;
  let done = false;

  const approxPromptTokens = Math.max(1, Math.round(
    messagesToSend.reduce((acc, m) => acc + (m.content || '').length, 0) / 3.5
  ));

  function renderStats(isLive) {
    if (!targetStats) return;
    const elapsed = Math.max(0.01, (performance.now() - startTime) / 1000);
    const liveSpeed = (tokenCount / elapsed).toFixed(1);
    const genTokens = serverTimings?.predicted_n ?? tokenCount;
    const promptTokens = serverTimings?.prompt_n ?? approxPromptTokens;
    const speed = serverTimings?.predicted_per_second
      ? serverTimings.predicted_per_second.toFixed(1)
      : liveSpeed;
    const totalCtx = promptTokens + genTokens;
    const ctxPct = Math.min(100, Math.round((totalCtx / CTX_SIZE) * 100));

    targetStats.innerHTML = '';

    const speedBadge = document.createElement('span');
    speedBadge.className = `stats-badge ${isLive ? 'live' : ''}`;
    speedBadge.textContent = `${speed} tok/s`;

    const countBadge = document.createElement('span');
    countBadge.className = 'stats-badge';
    countBadge.textContent = `${genTokens} tok${thoughtTokens ? ` (${thoughtTokens} think)` : ''}`;

    const ctxBadge = document.createElement('span');
    ctxBadge.className = 'stats-badge';
    ctxBadge.textContent = `${totalCtx.toLocaleString()} / ${CTX_SIZE.toLocaleString()} ctx (${ctxPct}%)`;

    targetStats.append(speedBadge, countBadge, ctxBadge);

    if (!isLive && finish) {
      const finishBadge = document.createElement('span');
      finishBadge.className = `stats-badge ${finish === 'length' ? 'warn' : ''}`;
      finishBadge.textContent = finish === 'length' ? 'limit reached' : `finish: ${finish}`;
      targetStats.append(finishBadge);
    }
  }

  renderStats(true);

  try {
    const response = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bonsai-2-27b',
        messages: messagesToSend,
        stream: true,
        max_tokens: maxTokens,
        temperature: thinking ? 1.0 : 0.7,
        top_p: thinking ? 0.95 : 0.8,
        reasoning_effort: thinking ? 'medium' : 'none',
        chat_template_kwargs: { enable_thinking: thinking }
      })
    });

    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const d = await response.json();
        message = d.error?.message || message;
      } catch {}
      throw Error(message);
    }

    $('#connection').textContent = readyText;
    $('#connection').className = 'online';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function consume(event) {
      const lines = event.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          return;
        }

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        if (chunk.error) throw Error(chunk.error.message || 'Generation failed');
        if (chunk.timings) serverTimings = chunk.timings;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta || {};

        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          thoughtTokens++;
          tokenCount++;
          targetDetails.hidden = false;
          targetThought.textContent = reasoning;
          targetSummary.textContent = content ? 'Thoughts' : 'Thinking…';
          if (!content) targetBody.textContent = 'Thinking…';
          renderStats(true);
        }

        if (delta.content) {
          content += delta.content;
          contentTokens++;
          tokenCount++;
          markdown(targetBody, content);
          targetSummary.textContent = 'Thoughts';
          $('#activity').textContent = 'Replying…';
          if (history[assistantIndex]) history[assistantIndex].content = content;
          renderStats(true);
        }

        const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 140;
        if (nearBottom) scroll();
      }
    }

    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);

    if (!done && !finish) throw Error('Connection ended before the answer finished.');

    if (!content && reasoning) {
      targetBody.textContent = 'The model used its reply allowance on thinking without generating a final answer. Ask to continue or toggle thinking off.';
    }

    if (history[assistantIndex]) {
      history[assistantIndex].content = content;
    }

    renderStats(false);

    // If truncated due to output token limit, provide a 1-click Continue button
    if (finish === 'length') {
      $('#activity').textContent = 'Reply limit reached · click Continue';
      if (targetActions) {
        const contBtn = document.createElement('button');
        contBtn.className = 'btn-continue';
        contBtn.type = 'button';
        contBtn.innerHTML = 'Continue generating ↳';
        contBtn.onclick = () => {
          contBtn.remove();
          const continuationMessages = [
            ...history.slice(0, assistantIndex),
            { role: 'user', content: history[assistantIndex - 1]?.content || 'Prompt' },
            { role: 'assistant', content: content },
            { role: 'user', content: 'Continue directly from where you stopped. Do not repeat anything previously written, resume immediately.' }
          ];
          runChat({
            messagesToSend: continuationMessages,
            targetArticle,
            targetBody,
            targetDetails,
            targetThought,
            targetSummary,
            targetMeta,
            targetStats,
            targetActions,
            assistantIndex,
            existingContent: content,
            existingThought: reasoning,
            isContinuation: true
          });
        };
        targetActions.append(contBtn);
      }
    } else {
      $('#activity').textContent = idleText;
    }

  } catch (error) {
    if (history[assistantIndex]) {
      history[assistantIndex].content = content;
    }
    renderStats(false);

    if (error.name === 'AbortError') {
      if (!content) targetBody.textContent = 'Stopped.';
      $('#activity').textContent = 'Stopped';
      if (targetSummary) targetSummary.textContent = 'Thoughts · stopped';
    } else {
      const note = document.createElement('p');
      note.className = 'error';
      note.textContent = error.message;
      targetArticle.append(note);
      if (!content) {
        targetBody.textContent = 'Couldn’t finish this reply. Your message is back below.';
        prompt.value = messagesToSend[messagesToSend.length - 1]?.content || '';
        resize();
      }
      $('#activity').textContent = 'Try again';
      health();
    }
  } finally {
    controller = null;
    $('#send').hidden = false;
    $('#stop').hidden = true;
    $('#clear').disabled = false;
    $('#thinking').disabled = false;
    prompt.focus();
  }
}

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text || controller) return;

  const requestHistory = [...history, { role: 'user', content: text }];
  history.push({ role: 'user', content: text });
  const assistantIndex = history.push({ role: 'assistant', content: '' }) - 1;

  $('#welcome').hidden = true;
  bubble('user', text);

  const { article, body } = bubble('assistant');

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  const thought = document.createElement('div');
  thought.className = 'thought';
  details.append(summary, thought);
  details.hidden = true;
  article.insertBefore(details, body);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const stats = document.createElement('div');
  stats.className = 'stats';
  const actions = document.createElement('div');
  actions.className = 'actions';
  meta.append(stats, actions);
  article.append(meta);

  body.textContent = '…';
  prompt.value = '';
  resize();
  scroll();
  $('#activity').textContent = $('#thinking').checked ? 'Thinking…' : 'Replying…';

  await runChat({
    messagesToSend: requestHistory,
    targetArticle: article,
    targetBody: body,
    targetDetails: details,
    targetThought: thought,
    targetSummary: summary,
    targetMeta: meta,
    targetStats: stats,
    targetActions: actions,
    assistantIndex,
    existingContent: '',
    existingThought: '',
    isContinuation: false
  });
});
