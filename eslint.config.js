import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.wrangler/**", "docs/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.es2022 } } },
  {
    files: ["packages/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  { files: ["apps/web/**/*.{ts,tsx,js}"], languageOptions: { globals: { ...globals.browser } } },
  { files: ["apps/*/scripts/**/*.mjs"], languageOptions: { globals: { ...globals.node } } },
);
