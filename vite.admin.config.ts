import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = import.meta.dirname;

export default defineConfig({
  root: path.resolve(projectRoot, "admin"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
      "@contracts": path.resolve(projectRoot, "contracts"),
      "@db": path.resolve(projectRoot, "db"),
    },
  },
  build: {
    outDir: path.resolve(projectRoot, "dist/admin"),
    emptyOutDir: true,
  },
});
