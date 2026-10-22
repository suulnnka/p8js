/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// p8js web shell. The VM/core are plain TS with .ts import specifiers
// (allowImportingTsExtensions) — Vite handles them natively.
export default defineConfig({
  // relative base so the build works under GitHub Pages project subpaths
  base: "./",
  build: {
    target: "es2022",
    // keep bios.bc as a static asset via ?url imports
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
  },
  test: {
    // Tests that compile bytecode spawn wsl.exe (p8luac). A cold WSL VM
    // takes ~8s to boot — well over vitest's 5s default.
    testTimeout: 30000,
  },
});
