import { statfs } from "node:fs/promises";
import { MODELS, type ModelName } from "./download_model.ts";
const root = Bun.argv[2];
if (!root) throw new Error("Expected repository directory.");
const name = Bun.argv[3] ?? "bonsai";
if (!Object.hasOwn(MODELS, name)) throw new Error("Unknown model.");
const model = MODELS[name as ModelName];
const required =
  Bun.file(`${root}/models/${model.filename}`).size === model.size
    ? 1024 ** 3
    : 12 * 1024 ** 3;
const disk = await statfs(root);
if (disk.bavail * disk.bsize < required)
  throw new Error(
    `Setup needs at least ${required / 1024 ** 3} GiB of free disk space.`,
  );
