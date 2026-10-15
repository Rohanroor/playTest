import { defineConfig } from "vite";

/**
 * ASCENSION build configuration.
 *
 * `base: "./"` keeps every asset reference relative so the bundle can be served
 * from any path - a user/org GitHub Pages site (https://user.github.io/repo/)
 * included, with no per-deployment rebuild.
 *
 * The WebAssembly core is built by `npm run wasm` (see the `prebuild`/`predev`
 * hooks in package.json) into public/wasm/sim.wasm and shipped as a static
 * asset; it is instantiated at runtime with correct MIME handling by the host.
 */
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    minify: "esbuild",
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    // Preview iframes must be allowed to embed the dev server. Deliberately no
    // COOP/COEP headers: the sim core is single-threaded, and cross-origin
    // isolation would block the page from being embedded in preview iframes.
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
  },
});
