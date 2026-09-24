# Bonsai 2 (27B PQ2_0) · Local Apple Silicon Inference Stack

<p align="center">
  <img src="./assets/tree.svg" alt="Bonsai 2" width="110"/>
</p>

<p align="center">
  <strong>Fast, minimal, verified local inference for PrismML's Ternary Bonsai 2 (27B) on Apple Silicon with Metal acceleration.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Model-Ternary--Bonsai--2--27B-304f38?style=flat-square" alt="Model"/>
  <img src="https://img.shields.io/badge/Quant-PQ2__0%20(2.13%20bpw)-577551?style=flat-square" alt="Quant"/>
  <img src="https://img.shields.io/badge/Hardware-Apple%20Silicon%20(Metal)-91a780?style=flat-square" alt="Hardware"/>
  <img src="https://img.shields.io/badge/Speed-~22.7%20tok%2Fs-success?style=flat-square" alt="Speed"/>
  <img src="https://img.shields.io/badge/Context-32%2C768%20tokens-blue?style=flat-square" alt="Context"/>
  <img src="https://img.shields.io/badge/API-OpenAI%20Compatible-informational?style=flat-square" alt="API"/>
</p>

---

## ⚡ Highlights

- **Native Metal GPU Offload:** 100% layer offload on Apple Silicon via PrismML's compatible `llama.cpp` runtime (`prism-b10709-9a9394a`).
- **Correct Hadamard Transform:** Stock `llama.cpp`, Ollama, and generic GGUF loaders fail on `PQ2_0` activation transformations. This stack pins the exact required runtime for coherent, high-speed reasoning.
- **OpenAI-Compatible Local API:** Direct endpoint at `http://127.0.0.1:8080/v1` ready for agents, tools, and extensions.
- **Clean Minimal Web UI:** Built with Vite + vanilla JS, featuring real-time SSE streaming, live `tok/s` meter, token breakdown, context usage tracking, and 1-click continuation.
- **100% Reproducible:** One-command automated setup script. Zero checked-in model binaries or multi-gigabyte files.

---

## 📊 Measured Benchmarks (M3 Max 36 GB)

| Metric | Result | Notes |
| :--- | :--- | :--- |
| **Generation Speed (Decode)** | **22.4 – 23.1 tok/s** | Sustained average ~22.7 tok/s |
| **Prompt Processing (Prefill)** | **~160 tok/s** | Measured via `llama-bench` (p=512) |
| **Context Window** | **32,768 tokens** | Configured via `--ctx-size 32768` |
| **Model Size on Disk** | **6.71 GiB** (7,206,168,928 bytes) | 2.13 bpw ternary quantization |
| **Memory Footprint** | **~8.2 GiB** RAM total | Minimal unified memory footprint |
| **Long Generation Test** | **3,000 tokens in 133.5s** | Verified continuous generation on localhost |

---

## 🚀 Quickstart

### 1. Clone & Set Up
```bash
git clone https://github.com/elix1er/bonsai-2-local.git
cd bonsai-2-local
./setup.sh
```
`./setup.sh` automatically:
1. Downloads the official ARM64 Prism compatible `llama.cpp` binary.
2. Clears Gatekeeper quarantine & applies ad-hoc codesign.
3. Fast-downloads `Ternary-Bonsai-2-27B-PQ2_0.gguf` using 8 parallel range workers with SHA-256 integrity verification (`3907dc16...`).
4. Installs the minimal frontend dependencies.

### 2. Start the Inference Server
```bash
./start.sh
```
Starts `llama-server` in the background with full Metal offload, 32k context, Flash Attention, and FP16 KV cache. Health check listens at `http://127.0.0.1:8080/health`.

### 3. Launch the Web UI
```bash
./start-web.sh
```
Open **`http://127.0.0.1:5173`** in your browser.

---

## 🕹️ Control Scripts

| Script | Purpose |
| :--- | :--- |
| `./setup.sh` | One-command download of runtime, model weights, and dependencies |
| `./start.sh` | Launches the local model server in the background (PID saved to `server.pid`) |
| `./stop.sh` | Gracefully terminates the model server |
| `./start-web.sh` | Starts the Vite web UI dev server on `127.0.0.1:5173` |
| `./stop-web.sh` | Stops the web UI server |
| `./share.sh` | Spawns a temporary public Cloudflare Tunnel (`*.trycloudflare.com`) |
| `./stop-share.sh` | Closes the Cloudflare tunnel |

---

## 🔌 OpenAI-Compatible API Usage

The inference server exposes standard OpenAI endpoints at `http://127.0.0.1:8080/v1`.

### Direct Generation (Thinking OFF)
```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bonsai-2-27b",
    "messages": [{"role": "user", "content": "Explain why the sky is blue in two sentences."}],
    "stream": true,
    "max_tokens": 4096,
    "reasoning_effort": "none",
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### Deep Reasoning (Thinking ON)
```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bonsai-2-27b",
    "messages": [{"role": "user", "content": "How many r'\''s are in strawberry?"}],
    "stream": true,
    "max_tokens": 8192,
    "reasoning_effort": "medium",
    "chat_template_kwargs": {"enable_thinking": true}
  }'
```

---

## 💡 Web UI Features

- **Universal Real-Time Streaming:** Streams token-by-token over both local loopback and Cloudflare Tunnels using SSE.
- **Live Metrics Dashboard:**
  - Real-time generation speed (`22.8 tok/s`).
  - Output token count and thinking breakdown (`144 tok (42 think)`).
  - Context window usage (`1,460 / 32,768 ctx (4%)`).
  - Server finish reason (`stop`, `length`).
- **1-Click Continuation:**
  If a response hits the max output token limit, a **`Continue generating ↳`** button appears directly beneath the message. Clicking it resumes generation seamlessly from the cutoff point without polluting prompt history.
- **Network Note (Cloudflare Tunnel vs Localhost):**
  Free quick tunnels (`*.trycloudflare.com`) enforce an unbuffered HTTP stream timeout around ~60–65s (~1,440 tokens at 22.7 tok/s). On `localhost`, streams run completely uninterrupted (verified past 3,000+ tokens). The continue button seamlessly bridges remote timeouts.

---

## 📁 Repository Structure

```
├── .gitignore               # Strict ignore rules (excludes models, binaries, logs)
├── README.md                # This documentation
├── setup.sh                 # Master reproducible setup script
├── start.sh                 # Background llama-server launcher
├── stop.sh                  # Safe llama-server shutdown
├── start-web.sh             # Vite chat frontend launcher
├── stop-web.sh              # Web frontend shutdown
├── share.sh                 # Cloudflare tunnel sharing helper
├── stop-share.sh            # Tunnel teardown
├── scripts/
│   ├── download_runtime.sh  # Official PrismML ARM64 llama.cpp binary downloader
│   └── download_model.py   # Multi-threaded parallel model downloader with SHA-256
└── web/
    ├── index.html           # Single-page UI entrypoint
    ├── package.json         # Minimal dependencies (marked, dompurify, vite)
    ├── vite.config.js       # Reverse proxy configuration
    ├── src.js               # Frontend chat logic, SSE streaming, live metrics
    └── style.css            # Minimalist bonsai aesthetic styles
```

---

## 📜 Provenance & Licenses

- **Model:** [`prism-ml/Ternary-Bonsai-2-27B-gguf`](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) (Revision `6ed5e12b`)
- **Runtime:** [PrismML llama.cpp release](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a) (`prism-b10709-9a9394a`)
- **SHA-256:** `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1`
