import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The quality build hands its output to tests through HX_QUALITY_BUILD; local builds stay in pages/dist.
const outDir = process.env.HX_QUALITY_BUILD ? join(process.env.HX_QUALITY_BUILD, "pages") : "dist";

export default defineConfig({
    plugins: [react()],
    build: { outDir, emptyOutDir: true },
    server: { proxy: { "/api": process.env.HX_CTX_WORKER_URL ?? "http://127.0.0.1:8787" } },
});
