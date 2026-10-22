// .p8c loader — PLAN §3 v1 + TODO.md Phase 3.5 v2 (merged multi-cart).
//
// v1: header(16) | rom(0x4300) | u32 code_len | code | u32 label_len | label?
//     | u32 source_len? | source?          (entry rom/code are bare bytes)
// v2: header(16, magic "P8C2", same fields) | BLOCK(entry rom) | BLOCK(entry
//     code) | [u16 name_len + name + BLOCK rom + BLOCK code]* until EOF
// BLOCK: u32 raw_len | u32 comp_len | u8 method(0=store,1=deflate-raw) | data
//
// Decompression is async (DecompressionStream) so the browser can inflate
// without a bundled zlib; v1 resolves immediately.

export const P8C_MAGIC_V1 = "P8C1";
export const P8C_MAGIC_V2 = "P8C2";
export const P8C_FORMAT = 1;

export interface P8cSub {
  rom: Uint8Array;
  /** null when the sub-cart has no __lua__ section */
  bytecode: Uint8Array | null;
}

export interface P8cFile {
  format: 1 | 2;
  p8Version: number;
  minor: number;
  flags: number;
  /** entry cart ROM (0x4300) */
  rom: Uint8Array;
  /** entry cart bytecode */
  bytecode: Uint8Array;
  label: Uint8Array | null;
  /** latin1 byte-string source (v1 flags bit0 only) */
  source: string | null;
  /** v2: sub-carts by stored filename (e.g. "poom_e1.p8"); empty for v1 */
  subs: Map<string, P8cSub>;
}

function need(buf: Uint8Array, pos: number, n: number, what: string): void {
  if (pos + n > buf.length) {
    throw new Error(`p8c: truncated reading ${what} at ${pos}+${n}`);
  }
}

function u16(buf: Uint8Array, pos: number): number {
  return buf[pos] | (buf[pos + 1] << 8);
}

function u32(buf: Uint8Array, pos: number): number {
  return (
    buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)
  ) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read one BLOCK at pos; returns inflated raw bytes and the end offset. */
async function readBlock(
  buf: Uint8Array, pos: number, what: string,
): Promise<{ raw: Uint8Array; end: number }> {
  need(buf, pos, 9, `block header (${what})`);
  const rawLen = u32(buf, pos);
  const compLen = u32(buf, pos + 4);
  const method = buf[pos + 8];
  const dataStart = pos + 9;
  need(buf, dataStart, compLen, `block data (${what})`);
  const data = buf.subarray(dataStart, dataStart + compLen);
  let raw: Uint8Array;
  if (method === 0) {
    raw = data.slice();
  } else if (method === 1) {
    try {
      raw = await inflateRaw(data);
    } catch (e) {
      throw new Error(
        `p8c: inflate failed for ${what}: ${(e as Error).message}`,
      );
    }
  } else {
    throw new Error(`p8c: unknown block method ${method} (${what})`);
  }
  if (raw.length !== rawLen) {
    throw new Error(
      `p8c: block ${what} size mismatch (got ${raw.length}, want ${rawLen})`,
    );
  }
  return { raw, end: dataStart + compLen };
}

export async function loadP8c(buf: Uint8Array): Promise<P8cFile> {
  need(buf, 0, 16, "header");
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);

  if (magic === P8C_MAGIC_V1) {
    const p8Version = buf[5];
    const minor = u32(buf, 6);
    const flags = buf[10];
    const romLen = u32(buf, 12);
    let pos = 16;
    need(buf, pos, romLen, "rom");
    const rom = buf.subarray(pos, pos + romLen);
    pos += romLen;

    need(buf, pos, 4, "code_len");
    const codeLen = u32(buf, pos);
    pos += 4;
    need(buf, pos, codeLen, "bytecode");
    const bytecode = buf.subarray(pos, pos + codeLen);
    pos += codeLen;

    need(buf, pos, 4, "label_len");
    const labelLen = u32(buf, pos);
    pos += 4;
    let label: Uint8Array | null = null;
    if (labelLen > 0) {
      need(buf, pos, labelLen, "label");
      label = buf.subarray(pos, pos + labelLen);
      pos += labelLen;
    }

    let source: string | null = null;
    if (flags & 1) {
      need(buf, pos, 4, "source_len");
      const srcLen = u32(buf, pos);
      pos += 4;
      need(buf, pos, srcLen, "source");
      let s = "";
      for (let i = 0; i < srcLen; i++) s += String.fromCharCode(buf[pos + i]);
      source = s;
      pos += srcLen;
    }

    return {
      format: 1, p8Version, minor, flags,
      rom, bytecode, label, source,
      subs: new Map(),
    };
  }

  if (magic !== P8C_MAGIC_V2) {
    throw new Error(`p8c: bad magic ${JSON.stringify(magic)}`);
  }
  const p8Version = buf[5];
  const minor = u32(buf, 6);
  const flags = buf[10];
  let pos = 16;

  const entryRom = await readBlock(buf, pos, "entry rom");
  pos = entryRom.end;
  const entryCode = await readBlock(buf, pos, "entry code");
  pos = entryCode.end;

  const subs = new Map<string, P8cSub>();
  while (pos < buf.length) {
    need(buf, pos, 2, "sub name_len");
    const nameLen = u16(buf, pos);
    pos += 2;
    need(buf, pos, nameLen, "sub name");
    let name = "";
    for (let i = 0; i < nameLen; i++) {
      name += String.fromCharCode(buf[pos + i]);
    }
    pos += nameLen;
    const rom = await readBlock(buf, pos, `${name} rom`);
    pos = rom.end;
    const code = await readBlock(buf, pos, `${name} code`);
    pos = code.end;
    subs.set(name, {
      rom: rom.raw,
      bytecode: code.raw.length > 0 ? code.raw : null,
    });
  }

  return {
    format: 2, p8Version, minor, flags,
    rom: entryRom.raw, bytecode: entryCode.raw,
    label: null, source: null,
    subs,
  };
}
