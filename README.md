# Bonsai 2 Local

Chat with Ternary Bonsai 2 27B on an Apple Silicon Mac. The model runs locally on Metal. Use the browser for streaming replies and optional thinking, or call the OpenAI-compatible chat endpoint from your own tools.

## Quick start

You need macOS on Apple Silicon, [Bun](https://bun.sh/) 1.4 or newer, and 12 GiB of free disk space.

```sh
git clone https://github.com/elix1er/bonsai-2-local.git
cd bonsai-2-local
./setup.sh
./start.sh
./start-web.sh -d
```

Open [the chat](http://127.0.0.1:5173). Your conversation and draft stay in this browser. To shut down, run `./stop-web.sh` and then `./stop.sh`.

Setup downloads the [6.71 GiB model](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) and its matching [Prism runtime](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a). It verifies both downloads with SHA-256.

## Abliterated variant (optional)

The [Huihui Ternary Bonsai 27B PQ2_0](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF) is a 7.7 GB abliterated variant of the same Qwen3.8/Bonsai model family. It fits in 36 GB unified memory and requires the Prism llama.cpp runtime. Its output quality and throughput have not been benchmarked here; this release is experimental.

```sh
./setup.sh abliterated
./stop.sh             # Only if another model is currently running
./start.sh abliterated
./start-web.sh -d
```

The original model remains the default: use `./start.sh` to run it. Only one model runs at a time on port 8080; stop it before switching. The web chat and API keep the `bonsai-2-27b` alias for either variant, so existing clients continue to work.

**GLM-5.3 is not supported on 36 GB Macs:** even its smallest GGUF weighs about 217 GB. The abliterated Bonsai model above is a practical *alternative*, not GLM-5.3.

## API

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"bonsai-2-27b","messages":[{"role":"user","content":"What is a bonsai?"}]}'
```

## Development

With the model running and the chat server stopped, run `bun run --cwd web dev` for hot reload.

To run the checks, install ShellCheck and Bun, then:

```sh
cd web
bun install --frozen-lockfile --ignore-scripts
bun --bun playwright install chromium
cd ..
./check.sh
```
