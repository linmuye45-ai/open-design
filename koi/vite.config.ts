import { defineConfig } from "vite";

// 相对 base，便于部署到 GitHub Pages / 任意子路径静态托管
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
  },
  // 允许任意主机预览（沙箱/隧道环境下访问）
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  test: {
    globals: true,
    environment: "node",
  },
});
