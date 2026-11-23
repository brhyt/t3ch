// @effect-diagnostics nodeBuiltinImport:off -- Nonblocking regular-file reads prevent FIFO hangs and bound credential-file allocation.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

// Read only regular files, with a hard byte limit even if a descriptor grows during reading.
export async function readObserverDescriptor(path: string) {
  const file = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("descriptor");
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 4096) throw new Error("descriptor");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
