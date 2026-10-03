import { openSync, closeSync } from "node:fs";
const [cwd, log, executable, ...args] = Bun.argv.slice(2);
if (!cwd || !log || !executable)
  throw new Error("Expected working directory, log, and command.");
const descriptor = openSync(log, "w");
try {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    detached: true,
    stdin: "ignore",
    stdout: descriptor,
    stderr: descriptor,
  });
  child.unref();
  console.log(child.pid);
} finally {
  closeSync(descriptor);
}
