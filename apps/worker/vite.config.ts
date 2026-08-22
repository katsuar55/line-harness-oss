import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/**
 * build 時の commit SHA を埋める (2026-08-23)。
 * HTML に `<meta name="x-build">` として出て、実機の版判定と
 * post-deploy-check の照合に使われる (utils/build-info.ts)。
 * git が使えない環境 (CI の shallow clone 等) でも build は止めない — 'unknown' に落とす。
 */
function buildSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA.trim();
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [cloudflare()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
});
