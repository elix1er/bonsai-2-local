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
