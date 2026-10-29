import eslint from "@eslint/js";

export default [
  { ignores: ["dist/**", ".validation/**", "node_modules/**", "docs/reference/**"] },
  eslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        process: "readonly",
        console: "readonly",
        window: "readonly",
        document: "readonly",
        XMLSerializer: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
];
