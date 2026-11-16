import { existsSync, lstatSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Whether the Bionet packages are linked to a checkout of biolibs (scripts/local-packages.mjs).
const scene = new URL("./node_modules/@biolibs/bionet-scene", import.meta.url);
const local = existsSync(scene) && lstatSync(scene).isSymbolicLink();

// The window's page is built to plain files and loaded from disk, so every path in it is relative.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
  // A linked package sits in another folder with a React of its own beside it. Left alone, the page
  // would load two Reacts and every hook would fail. So a linked package is treated as if it were
  // where its link is, and what it imports is found in this app.
  resolve: local ? { preserveSymlinks: true, dedupe: ["react", "react-dom", "three", "@react-three/fiber", "@react-three/drei", "@react-three/postprocessing"] } : {},
});
