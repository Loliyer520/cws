import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 产物直接输出到 ../webui，由 cws server.js 静态托管（config.json webui.dir 默认 webui/）
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../webui",
    emptyOutDir: true,
  },
  server: {
    port: 1421,
    proxy: {
      // 本地开发：WS 与媒体代理转发到本机 cws
      "/ws": { target: "ws://localhost:8642", ws: true },
      "/oc-media": { target: "http://localhost:8642" },
    },
  },
});
