# bonsai-2-local

<p align="center">
  <img src="./assets/tree.svg" alt="Bonsai 2" width="96" />
</p>

<p align="center">
  Local Apple Silicon inference runtime for Ternary Bonsai 2 27B with Metal acceleration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/model-Ternary--Bonsai--2--27B-34493e?style=flat-square" alt="Model" />
  <img src="https://img.shields.io/badge/quantization-PQ2__0%20(2.13%20bpw)-495e54?style=flat-square" alt="Quantization" />
  <img src="https://img.shields.io/badge/runtime-PrismML%20llama.cpp-2f3b35?style=flat-square" alt="Runtime" />
  <img src="https://img.shields.io/badge/backend-Apple%20Metal-3c4a42?style=flat-square" alt="Backend" />
  <img src="https://img.shields.io/badge/context-32%2C768%20tokens-4f5f56?style=flat-square" alt="Context" />
</p>


## Run local chat

Requires macOS on Apple Silicon, Python 3, Node.js compatible with the locked Vite version, and npm.

```bash
git clone https://github.com/elix1er/bonsai-2-local.git
cd bonsai-2-local
./setup.sh
./start.sh
./start-web.sh
```

Open `http://127.0.0.1:5173`. Use `./start-web.sh -d` to run the web server in the background. Setup uses `npm ci` and builds the UI, but the launcher serves it through Vite's development server.

The model server listens on `127.0.0.1:8080`. The browser sends health and chat requests through the Vite proxy at `/api`.

| Service | Start | Stop | Log |
| :--- | :--- | :--- | :--- |
| Model | `./start.sh` | `./stop.sh` | `logs/server.log` |
| Chat | `./start-web.sh -d` | `./stop-web.sh` | `logs/web.log` |
| Sharing | `./share.sh` | `./stop-share.sh` | Terminal |

Launchers record process IDs in the repository root. Stop commands check process ownership before signaling. If a recorded PID belongs to another process, inspect the PID file rather than killing that process.

`start.sh` waits up to three minutes for model health. If it times out, the process may still be loading. Inspect `logs/server.log` before retrying.

## Check inference

A successful health check proves HTTP readiness. Check generated text as well:

```bash
curl --fail-with-body http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bonsai-2-27b",
    "messages": [{"role": "user", "content": "Explain why the sky is blue in two sentences."}],
    "max_tokens": 128,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

For streaming, add `"stream": true` and use `curl -N`. For reasoning, set `"reasoning_effort": "medium"` and `"chat_template_kwargs": {"enable_thinking": true}`.

## Runtime and model

This setup pins the Prism runtime that supports the model's Hadamard activation transform. Preserve this pairing. Loading a GGUF successfully does not prove that a different runtime produces correct output.

| Setting | Value |
| :--- | :--- |
| Runtime | [prism-b10709-9a9394a](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a) |
| Model repository | [prism-ml/Ternary-Bonsai-2-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) |
| Model revision | `6ed5e12bf84b7a63069882c91dd9e9218647d17b` |
| File | `Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| Size | 7,206,168,928 bytes, 6.71 GiB |
| SHA-256 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| Context | 32,768 tokens |

The downloader checks model size and SHA-256 before publishing the completed file. It retries failed byte ranges within a run. Restarting the downloader fetches all ranges again. The runtime archive comes from the pinned release URL and is not independently checksum-verified.

`start.sh` requests full GPU layer offload, flash attention, and f16 KV caches. See the script for the complete launch flags. Performance depends on hardware, prompt length, and context use. Previous local measurements are not a benchmark guarantee.

## Chat behavior

The UI renders sanitized Markdown, streams replies, and can stop a request. Thinking is optional. Continue generating appears when the model reports its output limit and appends to the selected answer.

Live token counts estimate tokens from streamed chunks. Final metrics use server timings when available. The context gauge is approximate until prompt timings arrive. Continuation metrics describe the latest request, not the accumulated answer.

If a request fails or you stop it before producing text, the prompt returns to the composer. Partial output stays in the conversation after an interrupted stream. A connection failure displays an error, not a continuation button.

## Share temporarily

Place a Cloudflare `cloudflared` executable at `bin/cloudflared`. Setup does not install it. Start local inference and chat, then run `./share.sh`. Keep the terminal open and use the printed URL.

The temporary URL exposes chat and the proxied inference endpoints publicly without authentication. Stop sharing with Ctrl+C or `./stop-share.sh` when the test ends.

`share.sh` creates a Quick Tunnel. [Cloudflare documents that Quick Tunnels do not support SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations), so this streaming chat UI does not support remote replies through that URL. The keepalive setting does not remove this limitation. Use local chat for streaming.

## Maintain the repository

Service launchers live at the root. `scripts/` downloads the runtime and model. `web/src.js` contains chat state and streaming, and `web/vite.config.js` configures the API proxy. Weights, runtimes, logs, process files, and web build outputs are ignored.

Web start and stop commands use `web-control.lock/` to reject overlapping operations. If a control command is killed before cleanup, confirm no start or stop command is running, then remove the leftover directory with `rmdir web-control.lock`.

Run the maintenance checks from the repository root:

```bash
shellcheck *.sh scripts/*.sh
ruff check scripts/ tests/
python3 -m unittest discover -s tests
npm run build --prefix web
```

With local chat running, use an isolated browser session for the mocked streaming checks:

```bash
agent-browser --session bonsai-check open http://127.0.0.1:5173
agent-browser --session bonsai-check eval "$(cat tests/chat-browser.js)"
agent-browser --session bonsai-check close
```

The browser fixture checks continuation, split CRLF frames, error recovery, and cancellation without sending generation requests to the model.
