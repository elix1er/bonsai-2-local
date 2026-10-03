import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sha256 } from "./hash.ts";

export const FILENAME = "Ternary-Bonsai-2-27B-PQ2_0.gguf";
export const EXPECTED_SIZE = 7206168928;
export const EXPECTED_SHA256 =
  "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1";
const MODEL_URL = `https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/${FILENAME}`;

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
  url = MODEL_URL,
  size = EXPECTED_SIZE,
  checksum = EXPECTED_SHA256,
  workers = 8,
  retryDelayMs = 2000,
  timeoutMs = 60000,
}: {
  directory?: string;
  url?: string;
  size?: number;
  checksum?: string;
  workers?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
} = {}): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, FILENAME);
  const partial = `${target}.part`;
  if (await verifyFile(target, size, checksum)) {
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
      `\rProgress: ${((bytes / size) * 100).toFixed(1)}% @ ${speed.toFixed(1)} MB/s`,
    );
  }, 1000);
  const chunkSize = Math.ceil(size / workers);

  /** Bound network inactivity and resume only bytes that have reached the file. */
  async function fetchRange(index: number): Promise<void> {
    let position = index * chunkSize;
    const end = Math.min(size - 1, position + chunkSize - 1);
    for (let attempt = 0; position <= end && attempt < 5; attempt++) {
      const controller = new AbortController();
      let timer = setTimeout(
        () => controller.abort(new Error("Download timed out.")),
        timeoutMs,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const source = new URL(url);
        source.searchParams.set("part", String(index));
        source.searchParams.set("attempt", String(attempt));
        const response = await fetch(source, {
          headers: { Range: `bytes=${position}-${end}` },
          signal: controller.signal,
        });
        if (
          response.status !== 206 ||
          response.headers.get("content-range") !==
            `bytes ${position}-${end}/${size}`
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
        if (attempt === 4) throw error;
        await Bun.sleep(retryDelayMs);
      } finally {
        clearTimeout(timer);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
  }
  try {
    await file.truncate(size);
    const results = await Promise.allSettled(
      progress.map((_, index) => fetchRange(index)),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  } finally {
    clearInterval(display);
    await file.close();
  }
  if (!(await verifyFile(partial, size, checksum))) {
    await rm(partial, { force: true });
    throw new Error(
      "Model checksum verification failed; corrupted partial file removed.",
    );
  }
  await rename(partial, target);
  console.log(`\nModel successfully saved to ${target}`);
}
if (import.meta.main)
  downloadModel().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
