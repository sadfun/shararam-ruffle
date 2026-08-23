import { defineConfig } from "vite";

export default defineConfig({
  // duckdb-wasm workers + wasm are served from node_modules in dev and
  // copied into the bundle on build.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  build: { target: "es2022", chunkSizeWarningLimit: 6000 },
  server: { port: 5178 }
});
