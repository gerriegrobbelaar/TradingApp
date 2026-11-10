import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Scratch database for the migration test (applies 0001-0003, adds rows, then 0004).
          d1Databases: ["MIGRATE_DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values; real ones are a Workers var and secrets (see README.md).
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            SESSION_SECRET: "test-session-secret-0123456789abcdef-xyz",
            OAUTH_REDIRECT_URI: "https://app.test/api/auth/callback",
            EXACT_CLIENT_ID: "test-exact-client-id",
            EXACT_CLIENT_SECRET: "test-exact-client-secret",
            EXACT_REDIRECT_URI: "https://app.test/api/connections/exact/callback",
            // 32 bytes, base64. Test-only.
            TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
