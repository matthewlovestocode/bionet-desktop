import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The window's page is built to plain files and loaded from disk, so every path in it is relative.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
