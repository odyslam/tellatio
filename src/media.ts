import * as fs from "node:fs";
import * as path from "node:path";

// Intentionally fixed: callers cannot raise the resource limit via a CLI flag.
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

function mediaPath(dataDir: string, kind: "uploads" | "downloads", name: string): string {
  // A single non-hidden basename, never a caller-selected filesystem path.
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(name) || name.includes("..")) {
    throw new Error("Media requires a non-hidden file name, not a path");
  }
  const root = path.join(dataDir, kind);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dataDir).isDirectory() || !fs.lstatSync(root).isDirectory()) {
    throw new Error("Media directories must not be symlinks");
  }
  fs.chmodSync(root, 0o700);
  return path.join(fs.realpathSync(root), name);
}

export function readUpload(dataDir: string, name: string): { name: string; buffer: Buffer } {
  const file = mediaPath(dataDir, "uploads", name);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MEDIA_BYTES) {
      throw new Error("Upload must be a regular, unlinked file of at most 25 MiB");
    }
    // Read the already-open fd; do not pass a path that can be swapped to GramJS.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { name, buffer: buffer.subarray(0, offset) };
  } finally {
    fs.closeSync(fd);
  }
}

export function createDownload(dataDir: string, name: string) {
  const file = mediaPath(dataDir, "downloads", name);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let size = 0;
  let closed = false;
  const close = () => {
    if (!closed) { closed = true; fs.closeSync(fd); }
  };
  return {
    path: file,
    get size() { return size; },
    writer: {
      write(chunk: Buffer) {
        if (closed) throw new Error("Download already closed");
        if (size + chunk.length > MAX_MEDIA_BYTES) throw new Error("Download exceeds 25 MiB limit");
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
        size += chunk.length;
      },
      // GramJS closes stream-like writers itself. The caller also closes on error.
      close,
    },
    close,
    discard() { close(); fs.unlinkSync(file); },
  };
}
