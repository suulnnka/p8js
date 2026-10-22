// #include expansion for cart Lua source — ported from zepto8
// src/pico8/cart.cpp (cart::preprocess_code): flat one-level expansion,
// only on lines that cannot be inside a string or comment.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileBytesToPico8 } from "./charset.ts";
import { parseP8Text } from "./p8.ts";

function readInclude(cartPath: string, fileName: string): string {
  const dir = dirname(cartPath);
  const full = join(dir, fileName);
  if (!existsSync(full)) {
    throw new Error(`cannot load include cart: ${full}`);
  }
  const text = readFileSync(full, "latin1");
  if (fileName.toLowerCase().endsWith(".p8")) {
    // Includes of .p8 files contribute only their __lua__ section; parseP8Text
    // already applies the utf8→pico8 conversion.
    return parseP8Text(text).lua;
  }
  return fileBytesToPico8(text);
}

/**
 * Expand `#include file` directives. The input source must already be a
 * PICO-8 byte string (as produced by the cart parsers).
 */
export function preprocessIncludes(source: string, cartPath: string): string {
  if (!source.includes("#include ")) return source;

  const out: string[] = [];
  const lines = source.split("\n");
  for (const line of lines) {
    const idx = line.indexOf("#include ");
    if (
      idx >= 0 &&
      !line.includes('"') &&
      !line.includes("'") &&
      !line.includes("--")
    ) {
      const fileName = line.slice(idx + 9).trimEnd();
      out.push(readInclude(cartPath, fileName));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}
