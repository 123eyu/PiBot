interface LogReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

/** A log may grow or shrink during export; only complete lines from the bounded snapshot leave it. */
export async function readLogTail(file: LogReader, size: number, signal?: AbortSignal) {
  const length = Math.min(size, 4 * 1024 * 1024);
  const bytes = Buffer.alloc(length);
  const position = size - length;
  let offset = 0;
  while (offset < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      bytes,
      offset,
      Math.min(64 * 1024, length - offset),
      position + offset,
    );
    if (!bytesRead) break;
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  const read = bytes.subarray(0, offset);
  const first = position ? read.indexOf(10) : -1;
  const start = position ? (first < 0 ? offset : first + 1) : 0;
  const end = Math.max(start, read.lastIndexOf(10) + 1);
  return Buffer.concat([
    ...(position ? [Buffer.from("[Pi Bot log truncated: earlier lines omitted]\n")] : []),
    read.subarray(start, end),
    ...(offset < length || end < offset
      ? [Buffer.from("[Pi Bot log truncated: incomplete tail omitted]\n")]
      : []),
  ]);
}
