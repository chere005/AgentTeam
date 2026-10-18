import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { lightThemePlugin } from "./ui/theme-light.ts";
export default defineConfig({
  root: "ui",
  base: "./",
  plugins: [react()],
  // Light theme: a light twin of every colour rule, derived from the dark styles (ui/theme-light.ts).
  css: { postcss: { plugins: [lightThemePlugin() as any] } },
  build: { outDir: "../dist/ui", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
