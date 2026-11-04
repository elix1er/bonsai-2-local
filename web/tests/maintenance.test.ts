import { test, expect, onTestFinished } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadModel,
  FILENAME,
  verifyFile,
} from "../../scripts/download_model.ts";
import { sha256 } from "../../scripts/hash.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const services = [
  ["web", "start-web.sh", "stop-web.sh"],
  ["server", "start.sh", "stop.sh"],
  ["tunnel", "share.sh", "stop-share.sh"],
];

/** Give each check its own service files and remove them after fixture shutdown. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bonsai-maintenance-"));
  await cp(path.join(ROOT, "scripts"), path.join(root, "scripts"), {
    recursive: true,
  });
  for (const script of [
    "setup.sh",
    ...services.flatMap(([, start, stop]) => [start, stop]),
  ])
    await cp(path.join(ROOT, script), path.join(root, script));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Capture bounded commands without a shell or unescaped argument interpolation. */
async function run(
  command: string[],
  env = process.env,
): Promise<{ code: number; out: string; error: string }> {
  const child = Bun.spawn(command, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, error };
}

/** Reap every owned fixture child even when an assertion fails. */
function child(command: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(async () => {
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
  });
  return process;
}

/** Create an executable stub only inside the disposable fixture. */
async function executable(file: string, source: string): Promise<void> {
  await writeFile(file, `#!/bin/bash\n${source}\n`);
  await chmod(file, 0o755);
}

/** Use an ephemeral port and real HTTP child to test the web launcher. */
async function webFixture(): Promise<{ root: string; port: number }> {
  const root = await fixture();
  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = reservation.port;
  reservation.stop(true);
  if (!port) throw new Error("Missing fixture port");
  await mkdir(path.join(root, "web/dist"), { recursive: true });
  await writeFile(path.join(root, "web/dist/index.html"), "fixture");
  await writeFile(
    path.join(root, "web/server.ts"),
    'require("http").createServer((req,res)=>res.end("ready")).listen(Number(process.argv[process.argv.indexOf("--port")+1]),"127.0.0.1");',
  );
  for (const script of ["scripts/process.sh", "start-web.sh", "stop-web.sh"]) {
    const file = path.join(root, script);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replaceAll("5173", String(port)),
    );
  }
  onTestFinished(async () => {
    await run(["bash", path.join(root, "stop-web.sh")]);
  });
  return { root, port };
}

test("unrelated live PIDs are preserved for every service", async () => {
  const root = await fixture();
  const process = child(["sleep", "60"]);
  for (const [service, , stop] of services) {
    await writeFile(path.join(root, `${service}.pid`), String(process.pid));
    const result = await run(["bash", path.join(root, stop)]);
    expect(result.code).toBe(1);
    expect(result.error).toContain("belongs to another process");
    expect(process.exitCode).toBeNull();
    expect(await Bun.file(path.join(root, `${service}.pid`)).exists()).toBe(
      true,
    );
  }
});

test("detached web startup survives its launcher, reuses its PID, and stops", async () => {
  const { root, port } = await webFixture();
  expect(
    (await run(["bash", path.join(root, "start-web.sh"), "-d"])).code,
  ).toBe(0);
  const pid = await Bun.file(path.join(root, "web.pid")).text();
  expect(existsSync(path.join(root, "web-control.lock"))).toBe(false);
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ready");
  expect(
    (await run(["bash", path.join(root, "start-web.sh"), "-d"])).code,
  ).toBe(0);
  expect(await Bun.file(path.join(root, "web.pid")).text()).toBe(pid);
  expect((await run(["bash", path.join(root, "stop-web.sh")])).code).toBe(0);
  expect(await Bun.file(path.join(root, "web.pid")).exists()).toBe(false);
});

test("foreground web releases its control lock after readiness and remains stoppable", async () => {
  const { root, port } = await webFixture();
  const process = child(["bash", path.join(root, "start-web.sh")]);
  await expect
    .poll(
      async () =>
        (await Bun.file(path.join(root, "web.pid")).exists()) &&
        !existsSync(path.join(root, "web-control.lock")),
      { timeout: 5000 },
    )
    .toBe(true);
  expect(process.exitCode).toBeNull();
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ready");
  expect((await run(["bash", path.join(root, "stop-web.sh")])).code).toBe(0);
  await process.exited;
  expect(await Bun.file(path.join(root, "web.pid")).exists()).toBe(false);
});

test("overlapping start and stop commands preserve existing locks and PID records", async () => {
  const root = await fixture();
  for (const [service, start, stop] of services) {
    await mkdir(path.join(root, `${service}-control.lock`));
    await writeFile(path.join(root, `${service}.pid`), "4242");
    for (const script of [start, stop]) {
      const result = await run(["bash", path.join(root, script)]);
      expect(result.code).toBe(1);
      expect(result.error).toContain(`Another ${service} control command`);
      expect(existsSync(path.join(root, `${service}-control.lock`))).toBe(true);
      expect(await Bun.file(path.join(root, `${service}.pid`)).text()).toBe(
        "4242",
      );
    }
  }
});

for (const ignoreTerm of [false, true])
  test(`failed PID publication cancels its child, ignoring TERM=${ignoreTerm}`, async () => {
    const root = await fixture();
    const blocked = path.join(root, "web.pid");
    await mkdir(blocked);
    const process = child([
      Bun.which("bun") || "bun",
      "-e",
      `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}console.log("ready"); setInterval(() => {}, 1000);`,
    ]);
    const reader = process.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe(
      "ready",
    );
    reader.releaseLock();
    const result = await run([
      "bash",
      "-c",
      'sleep() { return 0; }; source "$1"; PID="$2"; PID_FILE="$3"; publish_pid',
      "fixture",
      path.join(root, "scripts/process.sh"),
      String(process.pid),
      blocked,
    ]);
    expect(result.code).toBe(1);
    expect(result.error).toContain("startup was cancelled");
    await process.exited;
    if (ignoreTerm) expect(process.signalCode).toBe("SIGKILL");
  });

test("zombie, delayed exit, and timeout shutdown states preserve the safeguards", async () => {
  const root = await fixture();
  const commands = path.join(root, "commands");
  await mkdir(commands);
  for (const [service, , stop] of services)
    for (const mode of ["zombie", "delayed", "timeout"]) {
      const marker = path.join(root, "slept");
      await rm(marker, { force: true });
      await writeFile(path.join(root, `${service}.pid`), "4242");
      let command = `${root}/runtime/bin/mac/llama-server --model fixture`;
      if (service === "web") command = `bun ${root}/web/server.ts --port 5173`;
      if (service === "tunnel")
        command = `${root}/bin/cloudflared tunnel --url fixture`;
      await executable(
        path.join(commands, "ps"),
        `if [ "$4" = stat= ]; then\n if [ '${mode}' = zombie ]; then echo Z; elif [ '${mode}' = delayed ] && [ -f '${marker}' ]; then exit 1; else echo S; fi\nelse echo '${command}'; fi`,
      );
      await executable(path.join(commands, "sleep"), `touch '${marker}'`);
      const result = await run(
        [
          "bash",
          "-c",
          'kill() { return 0; }; source "$0"',
          path.join(root, stop),
        ],
        { ...process.env, PATH: `${commands}:${process.env.PATH}` },
      );
      expect(result.code).toBe(mode === "timeout" ? 1 : 0);
      expect(await Bun.file(path.join(root, `${service}.pid`)).exists()).toBe(
        mode === "timeout",
      );
      expect(await Bun.file(marker).exists()).toBe(mode !== "zombie");
    }
});

test("stale PID records are removed for every service", async () => {
  const root = await fixture();
  const process = child(["true"]);
  await process.exited;
  for (const [service, , stop] of services) {
    await writeFile(path.join(root, `${service}.pid`), String(process.pid));
    expect((await run(["bash", path.join(root, stop)])).code).toBe(0);
    expect(await Bun.file(path.join(root, `${service}.pid`)).exists()).toBe(
      false,
    );
  }
});

test("unsupported platforms fail before downloads", async () => {
  const root = await fixture();
  await executable(path.join(root, "uname"), "echo Linux");
  const result = await run(["bash", path.join(root, "setup.sh")], {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
  });
  expect(result.code).toBe(1);
  expect(result.error).toContain("requires macOS on Apple Silicon");
});

test("missing Bun fails before downloads", async () => {
  const root = await fixture();
  const dirname = Bun.which("dirname");
  if (!dirname) throw new Error("Missing dirname");
  await symlink(dirname, path.join(root, "dirname"));
  await executable(
    path.join(root, "uname"),
    'if [ "$1" = -s ]; then echo Darwin; else echo arm64; fi',
  );
  const result = await run(["/bin/bash", path.join(root, "setup.sh")], {
    ...process.env,
    PATH: root,
  });
  expect(result.code).toBe(1);
  expect(result.error).toContain("Missing prerequisite: bun");
});

test("overlapping setup fails before downloads", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "setup-control.lock"));
  const commands = path.join(root, "commands");
  await mkdir(commands);
  for (const tool of ["bun", "curl", "tar", "xattr", "codesign", "lsof"])
    await executable(path.join(commands, tool), "exit 0");
  await executable(
    path.join(commands, "uname"),
    'if [ "$1" = -s ]; then echo Darwin; else echo arm64; fi',
  );
  const result = await run(["bash", path.join(root, "setup.sh")], {
    ...process.env,
    PATH: `${commands}:${process.env.PATH}`,
  });
  expect(result.code).toBe(1);
  expect(result.error).toContain("Another setup control command");
  expect(existsSync(path.join(root, "setup-control.lock"))).toBe(true);
});

test("incompatible runtime is rejected without replacing it", async () => {
  const root = await fixture();
  const binary = path.join(root, "runtime/bin/mac/llama-server");
  await mkdir(path.dirname(binary), { recursive: true });
  await executable(binary, 'echo "version: wrong build"');
  const result = await run([
    "bash",
    path.join(root, "scripts/download_runtime.sh"),
  ]);
  expect(result.code).toBe(1);
  expect(result.error).toContain("does not match prism-b10709-9a9394a");
  expect(await Bun.file(binary).exists()).toBe(true);
});

for (const wrongRange of [false, true])
  test(`range downloader verifies publication and rejects mismatched headers=${wrongRange}`, async () => {
    const root = await fixture();
    const data = new TextEncoder().encode("abcdefgh".repeat(8));
    const checksum = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(
          request.headers.get("range") || "",
        );
        if (!match) return new Response(null, { status: 400 });
        const start = Number(match[1]),
          end = Number(match[2]);
        return new Response(data.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": wrongRange
              ? "bytes 0-0/64"
              : `bytes ${start}-${end}/${data.length}`,
          },
        });
      },
    });
    onTestFinished(() => server.stop(true));
    await writeFile(path.join(root, `${FILENAME}.part`), "x".repeat(100));
    const download = downloadModel({
      directory: root,
      url: server.url.href,
      size: data.length,
      checksum,
      retryDelayMs: 0,
    });
    if (wrongRange) {
      await expect(download).rejects.toThrow("requested byte range");
      expect(await Bun.file(path.join(root, FILENAME)).exists()).toBe(false);
    } else {
      await download;
      expect(
        new Uint8Array(await Bun.file(path.join(root, FILENAME)).arrayBuffer()),
      ).toEqual(data);
      expect(
        await verifyFile(path.join(root, FILENAME), data.length, checksum),
      ).toBe(true);
      expect(await sha256(path.join(root, FILENAME))).toBe(checksum);
    }
  });

test("terminal range failure aborts siblings and removes the partial file", async () => {
  const root = await fixture();
  let siblingRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("range") === "bytes=32-63") {
        siblingRequests++;
        await Bun.sleep(500);
      } else {
        await Bun.sleep(10);
      }
      return new Response(null, { status: 500 });
    },
  });
  onTestFinished(() => server.stop(true));
  await expect(
    downloadModel({
      directory: root,
      url: server.url.href,
      size: 64,
      checksum: "0".repeat(64),
      workers: 2,
      retryDelayMs: 10,
      timeoutMs: 1000,
    }),
  ).rejects.toThrow("requested byte range");
  expect(siblingRequests).toBe(1);
  expect(await Bun.file(path.join(root, `${FILENAME}.part`)).exists()).toBe(
    false,
  );
});

test("truncated ranges retry from the last written byte and an existing verified model is reused", async () => {
  const root = await fixture();
  const data = new TextEncoder().encode("abcdefgh".repeat(8));
  const checksum = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const ranges: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const range = request.headers.get("range") || "";
      ranges.push(range);
      const start = Number(/^bytes=(\d+)-/.exec(range)?.[1]);
      const end = ranges.length === 1 ? 16 : data.length;
      return new Response(data.slice(start, end), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}`,
        },
      });
    },
  });
  onTestFinished(() => server.stop(true));
  const options = {
    directory: root,
    url: server.url.href,
    size: data.length,
    checksum,
    workers: 1,
    retryDelayMs: 0,
  };
  await downloadModel(options);
  expect(ranges).toEqual(["bytes=0-63", "bytes=16-63"]);
  expect(
    new Uint8Array(await Bun.file(path.join(root, FILENAME)).arrayBuffer()),
  ).toEqual(data);
  await downloadModel(options);
  expect(ranges).toHaveLength(2);
});

test("checksum failure removes the partial file and preserves the previous target", async () => {
  const root = await fixture();
  const target = path.join(root, FILENAME);
  await writeFile(target, "previous target");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("corrupt", {
        status: 206,
        headers: { "Content-Range": "bytes 0-6/7" },
      }),
  });
  onTestFinished(() => server.stop(true));
  await expect(
    downloadModel({
      directory: root,
      url: server.url.href,
      size: 7,
      checksum: "0".repeat(64),
      workers: 1,
    }),
  ).rejects.toThrow("checksum verification failed");
  expect(await Bun.file(`${target}.part`).exists()).toBe(false);
  expect(await Bun.file(target).text()).toBe("previous target");
});

test("runtime hash command rejects an incorrect archive checksum", async () => {
  const root = await fixture();
  const archive = path.join(root, "archive");
  await writeFile(archive, "untrusted archive");
  const result = await run([
    Bun.which("bun") || "bun",
    path.join(root, "scripts/hash.ts"),
    archive,
    "0".repeat(64),
  ]);
  expect(result.code).toBe(1);
  expect(result.error).toContain("refusing to extract");
});
