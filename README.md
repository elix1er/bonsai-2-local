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
  <img src="https://img.shields.io/badge/speed-22.7%20tok%2Fs-34493e?style=flat-square" alt="Speed" />
</p>

---

## Overview

This repository sets up a self-contained local inference stack for `prism-ml/Ternary-Bonsai-2-27B` using the `PQ2_0` quantization format on Apple Silicon.

It provides:
- A local `llama-server` process with 100% Metal GPU layer offload.
- An OpenAI-compatible HTTP API on `http://127.0.0.1:8080/v1`.
- A browser-based chat frontend with real-time token metrics.
- Reproducible scripts to download, verify, start, stop, and share the model.

```
┌────────────────┐     HTTP / SSE      ┌──────────────────────────┐
│  Client / Agent │ ──────────────────> │   llama-server (:8080)   │
│   (cURL, etc.)  │ <────────────────── │  Metal GPU, 32k context  │
└────────────────┘                     └─────────────┬────────────┘
                                                     │
┌────────────────┐     Vite proxy                    │
│  Browser Chat   │ ──────────────────> localhost:5173
│  (SSE metrics)  │
└────────────────┘
```

---

## Why standard llama.cpp fails

Bonsai 2 relies on an activation transform (a randomized Hadamard transform) coupled with ternary quantization (`PQ2_0`, 2.13 bits per weight).

Upstream `llama.cpp`, Ollama, and generic GGUF runners read the file metadata and allocate memory without throwing an error. Because they lack the Hadamard transform kernel, the forward pass produces corrupted tokens, repetitive loops, or symbol soup.

This setup locks to PrismML's official ARM64 binary build (`prism-b10709-9a9394a`), which implements the required activation kernels for Apple Metal.

---

## Verified benchmarks

Measurements taken on an Apple M3 Max with 36 GB unified memory running macOS Sonoma:

| Parameter | Measurement | Notes |
| :--- | :--- | :--- |
| Decode throughput | 22.4 to 23.1 tok/s | Sustained average 22.7 tok/s |
| Prefill throughput | ~160 tok/s | Evaluated at 512 prompt tokens |
| Context window | 32,768 tokens | Set via `--ctx-size 32768` |
| Weight size on disk | 6.71 GiB | 7,206,168,928 bytes |
| Total RAM footprint | ~8.2 GiB | Model weights plus 32k context KV cache |
| Continuous generation | 3,000 tokens in 133.5s | Completed on localhost with zero drops |

---

## Quick start

### 1. Setup

Clone the repository and run the setup script:

```bash
git clone https://github.com/elix1er/bonsai-2-local.git
cd bonsai-2-local
./setup.sh
```

`setup.sh` handles four steps:
1. Downloads the PrismML `llama.cpp` macOS ARM64 binary archive.
2. Clears Gatekeeper quarantine attributes and applies an ad-hoc code signature.
3. Downloads `Ternary-Bonsai-2-27B-PQ2_0.gguf` from Hugging Face using 8 parallel chunk workers, then verifies the SHA-256 checksum.
4. Installs web interface dependencies and builds the production assets.

### 2. Start inference server

```bash
./start.sh
```

The script starts `llama-server` in the background, writes its process ID to `server.pid`, and checks `http://127.0.0.1:8080/health` until ready. Logs stream to `logs/server.log`.

Server flags used:
- `--ctx-size 32768`
- `--n-gpu-layers 999`
- `--flash-attn on`
- `--cache-type-k f16 --cache-type-v f16`
- `--cache-ram 0`
- `--batch-size 2048 --ubatch-size 512`

### 3. Open web chat (optional)

```bash
./start-web.sh
```

Visit `http://127.0.0.1:5173` in your browser.

---

## Service control

| Script | Action |
| :--- | :--- |
| `./setup.sh` | Downloads runtime, fetches model weights, verifies hash, installs web packages |
| `./start.sh` | Launches `llama-server` in background with Metal acceleration |
| `./stop.sh` | Stops the running `llama-server` process |
| `./start-web.sh` | Starts the Vite web UI dev server on port 5173 |
| `./stop-web.sh` | Stops the web UI server |
| `./share.sh` | Opens a temporary public Cloudflare Tunnel to port 5173 |
| `./stop-share.sh` | Terminates the Cloudflare tunnel |

---

## API reference

The server exposes standard OpenAI endpoints at `http://127.0.0.1:8080/v1`.

### Standard completion

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bonsai-2-27b",
    "messages": [
      {"role": "user", "content": "Explain why the sky is blue in two sentences."}
    ],
    "stream": true,
    "max_tokens": 4096,
    "reasoning_effort": "none",
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### Extended reasoning mode

Bonsai 2 supports internal chain-of-thought thinking tokens:

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bonsai-2-27b",
    "messages": [
      {"role": "user", "content": "How many r characters are in strawberry?"}
    ],
    "stream": true,
    "max_tokens": 8192,
    "reasoning_effort": "medium",
    "chat_template_kwargs": {"enable_thinking": true}
  }'
```

---

## Web interface

The web client in `web/` provides a focused chat surface:
- Live generation speed gauge (`tok/s`).
- Token accounting broken down into reasoning and final response tokens.
- Context window utilization meter showing used tokens against the 32,768 ceiling.
- One-click continuation button if output hits the configured token limit.

### Cloudflare tunnel notes

When testing via `share.sh` (`*.trycloudflare.com` quick tunnels), Cloudflare drops idle or unbuffered HTTP connections after roughly 60 seconds. At 22.7 tok/s, that translates to approximately 1,440 generated tokens per burst.

On `localhost`, requests never experience this timeout. The web client handles remote drops cleanly: if the server signals `finish_reason: length` or drops mid-stream, a **Continue generating** button appears so you can resume the response without re-sending earlier turns.

---

## Repository layout

```
├── .gitignore               # Excludes weights, binaries, node_modules, and logs
├── README.md                # Documentation and operational reference
├── setup.sh                 # Reproducible environment installer
├── start.sh                 # Background llama-server runner
├── stop.sh                  # Graceful server shutdown
├── start-web.sh             # Vite chat frontend runner
├── stop-web.sh              # Chat frontend shutdown
├── share.sh                 # Cloudflare tunnel helper
├── stop-share.sh            # Tunnel shutdown
├── assets/
│   └── tree.svg             # Bonsai vector logo
├── scripts/
│   ├── download_runtime.sh  # Fetches PrismML ARM64 binary release
│   └── download_model.py    # Multi-threaded range downloader with hash check
└── web/
    ├── index.html           # Minimal HTML shell
    ├── package.json         # Frontend dependencies (marked, dompurify, vite)
    ├── vite.config.js       # Local proxy with extended socket timeout
    ├── src.js               # Chat client, SSE parser, and metrics renderer
    └── style.css            # Layout and theme styles
```

---

## Model verification

| Attribute | Specification |
| :--- | :--- |
| Repository | [`prism-ml/Ternary-Bonsai-2-27B-gguf`](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) |
| Git revision | `6ed5e12bf84b7a63069882c91dd9e9218647d17b` |
| File | `Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| Size | 7,206,168,928 bytes (6.71 GiB) |
| SHA-256 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| Runtime release | [`prism-b10709-9a9394a`](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a) |
