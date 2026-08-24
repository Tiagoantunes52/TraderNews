import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next bundles an eslint-plugin-react whose React VERSION
    // DETECTION still calls context.getFilename(), removed in ESLint 10 — every
    // lint run died with "contextOrFilename.getFilename is not a function" on
    // every file. Pinning the version skips detection entirely; keep it in sync
    // with package.json's react major.
    settings: { react: { version: "19.2" } },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees are checkouts of this repo; ESLint 10 resolves config from
    // the linted FILE's directory, so files in there load the worktree's own
    // (possibly older) config and crash the whole run.
    ".claude/**",
  ]),
]);

export default eslintConfig;
