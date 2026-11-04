import { statfs } from "node:fs/promises";
import { FILENAME, EXPECTED_SIZE } from "./download_model.ts";
const root = Bun.argv[2];
if (!root) throw new Error("Expected repository directory.");
const required =
  Bun.file(`${root}/models/${FILENAME}`).size === EXPECTED_SIZE
    ? 1024 ** 3
    : 12 * 1024 ** 3;
const disk = await statfs(root);
if (disk.bavail * disk.bsize < required)
  throw new Error(
    `Setup needs at least ${required / 1024 ** 3} GiB of free disk space.`,
  );
