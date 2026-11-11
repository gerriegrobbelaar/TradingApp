import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // The heaviest screens take 2.5 to 3.1 s unloaded; 5 s flaked under parallel load.
    testTimeout: 15000,
  },
});
