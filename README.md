# bonsai-2-local

<p align="center"><img src="./assets/tree.svg" alt="Bonsai 2" width="96" /></p>

Local chat with Ternary Bonsai 2 27B on Apple Silicon, using the matching Prism runtime and Metal.

## Run chat

Requires macOS on Apple Silicon and Bun 1.4+. The locked toolchain uses Bun 1.4.2. Install Bun using its [official instructions](https://bun.sh/docs/installation). A fresh setup needs 12 GiB of free disk space. Setup checks these prerequisites before downloading anything and rejects overlapping setup runs.

```bash
git clone https://github.com/elix1er/bonsai-2-local.git
cd bonsai-2-local
./setup.sh
./start.sh
./start-web.sh
```

Open `http://127.0.0.1:5173`. Setup installs locked dependencies with `bun install --frozen-lockfile` and builds the UI. The launcher serves that build through a small Bun server, bound to localhost. After editing the frontend, run `bun run --cwd web build` and reload the page.

| Service | Start | Stop | Log |
| :--- | :--- | :--- | :--- |
| Model | `./start.sh` | `./stop.sh` | `logs/server.log` |
| Chat | `./start-web.sh -d` | `./stop-web.sh` | `logs/web.log` |
| Temporary sharing | `./share.sh` | `./stop-share.sh` or Ctrl+C | Terminal |

Without `-d`, chat stays in the terminal and Ctrl+C stops it. The model API listens on `127.0.0.1:8080`. The web server serves frontend files from `web/dist/`, proxies health and chat completions under `/api`, and handles remote reply jobs.

Each service records its PID and uses a control lock to reject overlapping start and stop commands. Startup cancels its child if the PID cannot be recorded. Stop commands check ownership before signaling and retain the PID if shutdown times out. A PID belonging to another process requires inspection, not deletion or a forced kill.

If a control command is killed before cleanup, confirm it is no longer running, then remove its leftover directory with `rmdir web-control.lock`, `rmdir server-control.lock`, `rmdir tunnel-control.lock`, or `rmdir setup-control.lock`. Model startup can take three minutes. After a readiness timeout, inspect `logs/server.log`; the PID stays available for `./stop.sh`.

## Chat behavior

The current conversation, draft, and thinking preference stay in this browser's local storage. Refresh restores them. New chat clears the conversation and draft across tabs using the same URL. It also stops a reply in another tab before that tab can restore cleared text. Storage is separate for each URL, browser, and profile. If storage is unavailable or full, the app displays a warning. Saved text is not encrypted.

Local replies stream. Remote chat starts a reply job and polls until its completed JSON answer is available. Both support thinking, Stop, and continuation after the reply limit. Interrupted partial answers remain available to continue. Only the latest answer can be extended, so earlier exchanges stay consistent.

A failed or stopped unanswered request can be retried. Its prompt returns to an empty composer; a newer draft stays intact. Copy answer and Copy code buttons copy plain text. Markdown is sanitized before rendering.

Live token counts and speed are text-based estimates, marked with `~`. Final metrics use server timings or usage counts when available and describe the latest request. Context estimates reserve 4,096 output tokens, or 8,192 with thinking enabled. They warn near the 32,768-token limit and block requests estimated to exceed it. Tokenization varies by text, so the model can still reject a request below the estimate. Keep latest exchange removes earlier messages explicitly; New chat starts fresh.

The connection indicator refreshes every 15 seconds while the page is visible and when the window gains focus.

## Runtime and model

Preserve this pairing. Bonsai's Hadamard activation transform requires the matching Prism runtime. Loading a GGUF successfully does not prove that another runtime produces correct output.

| Setting | Value |
| :--- | :--- |
| Runtime | [prism-b10709-9a9394a](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a) |
| Runtime archive SHA-256 | `f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff` |
| Model repository | [prism-ml/Ternary-Bonsai-2-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) |
| Model revision | `6ed5e12bf84b7a63069882c91dd9e9218647d17b` |
| File | `Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| Model size | 7,206,168,928 bytes, 6.71 GiB |
| Model SHA-256 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| Context | 32,768 tokens |

Setup verifies the runtime archive checksum, stages extraction, signs the binaries, and checks the expected build and commit before publishing them. An existing executable must report the matching version. An incompatible runtime is left intact with an error explaining how to move it aside.

The model downloader checks size and SHA-256 before publishing the completed file. Failed byte ranges retry within a run. Restarting the downloader fetches all ranges again. `start.sh` requests full GPU layer offload, flash attention, and f16 KV caches. Performance depends on hardware, prompt length, and context use.

Check generated text as well as health:

```bash
curl --fail-with-body http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"bonsai-2-27b","messages":[{"role":"user","content":"Explain why the sky is blue in two sentences."}],"max_tokens":128,"reasoning_effort":"none","chat_template_kwargs":{"enable_thinking":false}}'
```

For streaming, add `"stream": true` and use `curl -N`. For reasoning, set `"reasoning_effort": "medium"` and `"chat_template_kwargs": {"enable_thinking": true}`.

## Share temporarily

Place a Cloudflare `cloudflared` executable at `bin/cloudflared`. Setup does not install it. Start the model and chat, then run `./share.sh`. Keep the terminal open and use the printed URL.

The URL exposes chat, reply jobs, and the two proxied model endpoints publicly without authentication. Anyone with it can use your model. Stop sharing when the test ends.

[Cloudflare Quick Tunnels do not support SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations). The UI therefore starts a reply job on remote hostnames and polls it with short requests. This also avoids [Cloudflare's response timeout for long origin requests](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/). A waiting indicator stays visible until the complete answer arrives. One remote reply can run at a time. Stop cancels its model request. Jobs stay in memory, have a 20-minute generation limit, and expire 10 minutes after completion. If a pending job has not been polled for three minutes, a new request can reclaim it. Polling retries transient network failures; three consecutive failures end the request. Restarting chat loses pending jobs. This is temporary sharing, not a persistent or authenticated hosting setup.

## Develop and check

The frontend stays vanilla TypeScript. `web/src.ts` handles UI interactions, `web/chat.ts` handles requests and streaming, and `web/session.ts` handles saved data. `web/server.ts` serves the build and proxies the model. `web/jobs.ts` handles bounded remote jobs and cancellation for both normal and development servers. Launchers share PID, lock, and shutdown handling through `scripts/process.sh`.

Shared Valibot schemas validate data from the model, browser storage, and remote clients. TypeScript derives the application types from those schemas. The web application, configuration, and browser and unit tests are TypeScript. Bun executes server sources directly, so no server compilation or second JavaScript runtime is needed.

Bun also runs the model downloader, streaming checksum verification, disk preflight, and detached process launcher in `scripts/`.

For frontend development, `bun run --cwd web dev` starts Vite on port 5173 with the same API proxy. Stop the built chat server first. Rebuild before using the normal launcher again.

Install ShellCheck, then prepare the browser once:

```bash
bun install --cwd web --frozen-lockfile
bun --cwd web --bun playwright install chromium
./check.sh
```

The check command runs shell lint, process and downloader tests, formatting, strict TypeScript checking, the frontend build, Vitest tests on Bun, and Chromium interaction tests. It uses disposable services and mocked model replies. It does not download weights or run inference. GitHub Actions runs the same command on PRs and main.

Weights, runtimes, logs, PIDs, control locks, dependencies, builds, and browser reports are ignored. Real model output and an external tunnel still need local acceptance checks.
