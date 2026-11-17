/// <reference types="vitest/config" />

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { isNotVoid } from "typed-assert";
import replace from "vite-plugin-filter-replace";
import fs from "node:fs";

function bundledGoogleApp() {
  if (process.env.VITEST) return null;
  const path =
    process.env.DAY_PLANNER_GOOGLE_APP_CONFIG ??
    "google-oauth-client.private.json";
  if (!fs.existsSync(path)) {
    if (process.env.DAY_PLANNER_GOOGLE_APP_CONFIG)
      throw new Error("The configured Google Desktop app file was not found.");
    return null;
  }
  const data = JSON.parse(fs.readFileSync(path, "utf-8")) as {
    installed?: { client_id?: unknown; client_secret?: unknown };
  };
  const client = data.installed;
  if (
    typeof client?.client_id !== "string" ||
    !client.client_id.endsWith(".apps.googleusercontent.com") ||
    typeof client.client_secret !== "string" ||
    !client.client_secret.trim()
  )
    throw new Error(
      "Google app configuration must be a Desktop OAuth download.",
    );
  return {
    clientId: client.client_id.trim(),
    clientSecret: client.client_secret.trim(),
  };
}

function replaceReduxRandomActionSeparator() {
  return {
    name: "replace-redux-random-action-separator",
    renderChunk(code: string) {
      const replaced = code.replace(
        /\.split\(""\)\.join\("\."\)/g,
        '.split("").join("_")',
      );

      if (replaced === code) {
        return null;
      }

      return { code: replaced, map: null };
    },
  };
}

export default defineConfig((env) => ({
  define: {
    registeredGoogleAppConfig: JSON.stringify(bundledGoogleApp()),
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "development",
    ),
  },
  resolve: process.env.VITEST
    ? {
        conditions: ["browser"],
      }
    : undefined,
  plugins: [
    replace([
      {
        filter: /release-notes\.ts|main\.ts|README\.md|CHANGELOG\.md/,
        replace: [
          {
            from: "changelogMd",
            to: JSON.stringify(fs.readFileSync("./CHANGELOG.md", "utf-8")),
          },
          {
            from: "currentPluginVersion",
            to: JSON.stringify(
              JSON.parse(fs.readFileSync("./package.json", "utf-8")).version,
            ),
          },
          {
            from: "envMode",
            to: JSON.stringify(env.mode),
          },
        ],
      },
    ]),
    replaceReduxRandomActionSeparator(),
    svelte({
      compilerOptions: {
        dev: env.mode === "development",
      },
    }),
  ],
  css: {
    preprocessorOptions: {
      scss: { includePaths: ["node_modules"] },
    },
  },
  build: {
    // todo: fix
    // sourcemap: "inline",
    lib: {
      entry: "src/main.ts",
      name: "main",
      fileName: () => "main.js",
      cssFileName: "styles",
      formats: ["cjs" as const],
    },
    minify: env.mode === "production",
    outDir: ".",
    rollupOptions: {
      output: {
        exports: "named" as const,
        assetFileNames: (assetInfo: { name?: string }) => {
          if (assetInfo.name === "style.css") {
            return "styles.css";
          }

          isNotVoid(assetInfo.name);

          return assetInfo.name;
        },
      },
      external: [
        "obsidian",
        "electron",
        "node:http",
        "@codemirror/state",
        "@codemirror/view",
      ],
    },
  },
  test: {
    testTimeout: 10 * 60 * 1000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.svelte.ts"],
    environment: "jsdom",
    setupFiles: ["vite-setup.ts"],
    coverage: {
      reporter: ["html"],
      provider: "v8",
      include: ["src/**/*.ts"],
    },
    alias: {
      obsidian: new URL("./__mocks__/obsidian.ts", import.meta.url).pathname,
    },
  },
}));
