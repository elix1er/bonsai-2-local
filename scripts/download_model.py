#!/usr/bin/env python3
"""
Downloads Ternary-Bonsai-2-27B-PQ2_0.gguf from Hugging Face using parallel HTTP Range requests.
Verifies SHA-256 checksum upon completion.
"""

import concurrent.futures
import hashlib
import os
import pathlib
import sys
import time
import urllib.request

REPO = "prism-ml/Ternary-Bonsai-2-27B-gguf"
REVISION = "6ed5e12bf84b7a63069882c91dd9e9218647d17b"
FILENAME = "Ternary-Bonsai-2-27B-PQ2_0.gguf"
EXPECTED_SHA256 = "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1"
EXPECTED_SIZE = 7206168928

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
TARGET_FILE = MODELS_DIR / FILENAME
PART_FILE = MODELS_DIR / f"{FILENAME}.part"

def verify_file(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    if path.stat().st_size != EXPECTED_SIZE:
        return False
    print(f"Verifying SHA-256 checksum of {path.name}...")
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024 * 8):
            h.update(chunk)
    digest = h.hexdigest()
    if digest == EXPECTED_SHA256:
        print(f"Checksum verified: {digest}")
        return True
    print(f"Checksum MISMATCH! Expected {EXPECTED_SHA256}, got {digest}")
    return False

def main():
    """Download the model in parallel and verify its size and SHA-256 checksum."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if TARGET_FILE.exists():
        if verify_file(TARGET_FILE):
            print(f"Model already downloaded and verified: {TARGET_FILE}")
            return
        print("Existing file corrupted or incomplete, re-downloading...")
        TARGET_FILE.unlink()

    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{FILENAME}"
    print(f"==> Downloading {FILENAME} ({EXPECTED_SIZE / (1024**3):.2f} GiB)...")
    print(f"Source: {url}")

    with PART_FILE.open("a+b") as part:
        part.truncate(EXPECTED_SIZE)
    fd = os.open(str(PART_FILE), os.O_WRONLY)
    num_workers = 8
    chunk_size = (EXPECTED_SIZE + num_workers - 1) // num_workers
    progress = [0] * num_workers
    start_time = time.monotonic()

    def fetch_range(idx, start, end):
        """Write an inclusive byte range to the part file, retrying up to five attempts.

        Update progress for worker ``idx`` as bytes are written, resume from the
        last written offset after failures, and re-raise the final exception.
        """
        pos = start
        for attempt in range(5):
            try:
                req = urllib.request.Request(
                    f"{url}?part={idx}&attempt={attempt}",
                    headers={"Range": f"bytes={pos}-{end}"}
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    expected_range = f"bytes {pos}-{end}/{EXPECTED_SIZE}"
                    if resp.status != 206 or resp.headers.get("Content-Range") != expected_range:
                        raise IOError("Server did not return the requested byte range")
                    while pos <= end:
                        data = resp.read(min(1024 * 1024, end - pos + 1))
                        if not data:
                            raise IOError("Truncated read")
                        n = os.pwrite(fd, data, pos)
                        if n == 0:
                            raise IOError("Could not write model data")
                        pos += n
                        progress[idx] += n
                return
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = []
            for i in range(num_workers):
                s = i * chunk_size
                e = min(EXPECTED_SIZE - 1, (i + 1) * chunk_size - 1)
                if s < EXPECTED_SIZE:
                    futures.append(executor.submit(fetch_range, i, s, e))

            while not all(f.done() for f in futures):
                downloaded = sum(progress)
                pct = (downloaded / EXPECTED_SIZE) * 100
                elapsed = time.monotonic() - start_time
                speed_mb = (downloaded / (1024 * 1024)) / max(0.1, elapsed)
                print(f"\rProgress: {pct:.1f}% ({downloaded / (1024**3):.2f}/{EXPECTED_SIZE / (1024**3):.2f} GiB) @ {speed_mb:.1f} MB/s", end="", flush=True)
                time.sleep(1)

            for f in futures:
                f.result()
    finally:
        os.close(fd)

    print("\nDownload complete. Running integrity check...")
    if not verify_file(PART_FILE):
        print("Verification failed! Removing corrupted part file.")
        PART_FILE.unlink(missing_ok=True)
        sys.exit(1)

    PART_FILE.rename(TARGET_FILE)
    print(f"Model successfully saved to {TARGET_FILE}")

if __name__ == "__main__":
    main()
