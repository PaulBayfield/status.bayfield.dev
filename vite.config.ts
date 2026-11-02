import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  server: {
    port: 1460,
    strictPort: true,
    // The Worker (npm run server: wrangler dev) during development.
    proxy: {
      "/api": "http://127.0.0.1:8820",
    },
    watch: {
      ignored: ["**/server/**"],
    },
  },
});
