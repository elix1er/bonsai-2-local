/** Hash large files incrementally without buffering model weights in memory. */
export async function sha256(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
if (import.meta.main) {
  const [path, expected] = Bun.argv.slice(2);
  if (!path || !expected || (await sha256(path)) !== expected) {
    console.error("Runtime archive checksum mismatch; refusing to extract it.");
    process.exitCode = 1;
  }
}
