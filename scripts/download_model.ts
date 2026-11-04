import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sha256 } from "./hash.ts";

export const FILENAME = "Ternary-Bonsai-2-27B-PQ2_0.gguf";
export const EXPECTED_SIZE = 7206168928;
export const EXPECTED_SHA256 =
  "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1";
const MODEL_URL = `https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/${FILENAME}`;

export const MODELS = {
  bonsai: {
    filename: FILENAME,
    size: EXPECTED_SIZE,
    sha256: EXPECTED_SHA256,
    url: MODEL_URL,
  },
  abliterated: {
    filename: "Huihui-Qwen3.8-27B-abliterated-Ternary-Bonsai-PQ2_0.gguf",
    size: 7704693216,
    sha256: "0de67be7b5256c20971f44e514d87ec7fa81ad4f8d8fcf151644009f74f3a5cf",
    url: "https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-Ternary-Bonsai-PQ2_0.gguf",
  },
} as const;
export type ModelName = keyof typeof MODELS;

/** Accept weights only when their size and pinned checksum match. */
export async function verifyFile(
  file: string,
  size: number,
  checksum: string,
): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return (
    !!info?.isFile() && info.size === size && (await sha256(file)) === checksum
  );
}

/** Stream disjoint ranges to disk, retry from written offsets, then publish verified weights. */
export async function downloadModel({
  directory = fileURLToPath(new URL("../models/", import.meta.url)),
  model = "bonsai",
  url,
  size,
  checksum,
  workers = 8,
  retryDelayMs = 2000,
  timeoutMs = 60000,
}: {
  directory?: string;
  model?: ModelName;
  url?: string;
  size?: number;
  checksum?: string;
  workers?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
} = {}): Promise<void> {
  const selected = MODELS[model];
  const modelUrl = url ?? selected.url;
  const modelSize = size ?? selected.size;
  const modelChecksum = checksum ?? selected.sha256;
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, selected.filename);
  const partial = `${target}.part`;
  if (await verifyFile(target, modelSize, modelChecksum)) {
    console.log(`Model already downloaded and verified: ${target}`);
    return;
  }
  const file = await open(partial, "w+");
  const progress = Array.from({ length: workers }, () => 0);
  const started = performance.now();
  const display = setInterval(() => {
    const bytes = progress.reduce((sum, value) => sum + value, 0);
    const speed =
      bytes / 1024 ** 2 / Math.max(0.1, (performance.now() - started) / 1000);
    process.stdout.write(
      `\rProgress: ${((bytes / modelSize) * 100).toFixed(1)}% @ ${speed.toFixed(1)} MB/s`,
    );
  }, 1000);
  const chunkSize = Math.ceil(modelSize / workers);
  const failed = new AbortController();

  /** Bound network inactivity and resume only bytes that have reached the file. */
  async function fetchRange(index: number): Promise<void> {
    let position = index * chunkSize;
    const end = Math.min(modelSize - 1, position + chunkSize - 1);
    for (let attempt = 0; position <= end && attempt < 5; attempt++) {
      if (failed.signal.aborted) throw failed.signal.reason;
      const controller = new AbortController();
      let timer = setTimeout(
        () => controller.abort(new Error("Download timed out.")),
        timeoutMs,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const source = new URL(modelUrl);
        source.searchParams.set("part", String(index));
        source.searchParams.set("attempt", String(attempt));
        const response = await fetch(source, {
          headers: { Range: `bytes=${position}-${end}` },
          signal: AbortSignal.any([controller.signal, failed.signal]),
        });
        if (
          response.status !== 206 ||
          response.headers.get("content-range") !==
            `bytes ${position}-${end}/${modelSize}`
        ) {
          await response.body?.cancel();
          throw new Error("Server did not return the requested byte range");
        }
        if (!response.body) throw new Error("Empty model response");
        reader = response.body.getReader();
        while (position <= end) {
          const chunk = await reader.read();
          clearTimeout(timer);
          timer = setTimeout(
            () => controller.abort(new Error("Download timed out.")),
            timeoutMs,
          );
          if (chunk.done) throw new Error("Truncated model response");
          if (chunk.value.length > end - position + 1)
            throw new Error("Model response exceeded the requested range");
          let offset = 0;
          while (offset < chunk.value.length) {
            const { bytesWritten } = await file.write(
              chunk.value,
              offset,
              chunk.value.length - offset,
              position,
            );
            if (!bytesWritten) throw new Error("Could not write model data");
            offset += bytesWritten;
            position += bytesWritten;
            progress[index] += bytesWritten;
          }
        }
        return;
      } catch (error) {
        if (failed.signal.aborted) throw failed.signal.reason;
        if (attempt === 4) throw error;
        await Bun.sleep(retryDelayMs);
        if (failed.signal.aborted) throw failed.signal.reason;
      } finally {
        clearTimeout(timer);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
  }
  try {
    try {
      await file.truncate(modelSize);
      const results = await Promise.allSettled(
        progress.map(async (_, index) => {
          try {
            await fetchRange(index);
          } catch (error) {
            if (!failed.signal.aborted) failed.abort(error);
            throw error;
          }
        }),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw failed.signal.reason ?? rejected.reason;
    } finally {
      clearInterval(display);
      await file.close();
    }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw failed.signal.aborted ? failed.signal.reason : error;
  }
  if (!(await verifyFile(partial, modelSize, modelChecksum))) {
    await rm(partial, { force: true });
    throw new Error(
      "Model modelChecksum verification failed; corrupted partial file removed.",
    );
  }
  await rename(partial, target);
  console.log(`\nModel successfully saved to ${target}`);
}
if (import.meta.main) {
  const name = process.argv[2] ?? "bonsai";
  if (!Object.hasOwn(MODELS, name)) {
    console.error("Usage: bun scripts/download_model.ts [bonsai|abliterated]");
    process.exitCode = 2;
  } else {
    downloadModel({ model: name as ModelName }).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
