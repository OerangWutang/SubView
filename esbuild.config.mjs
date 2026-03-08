import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const modeArg = args.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : "public";
const watch = args.includes("--watch");
const isDev = mode === "dev";

const root = process.cwd();
const outdir = resolve(root, "dist");

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function copyIfExists(from, to) {
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true });
  }
}

function copyStaticAssets() {
  ensureDir(outdir);
  const manifestFile = isDev ? "manifest.dev.json" : "manifest.json";
  cpSync(resolve(root, manifestFile), resolve(outdir, "manifest.json"));

  copyIfExists(resolve(root, "src/popup/popup.html"), resolve(outdir, "popup.html"));
  copyIfExists(resolve(root, "src/options/options.html"), resolve(outdir, "options.html"));
  copyIfExists(resolve(root, "darkpatterns.json"), resolve(outdir, "darkpatterns.json"));
  copyIfExists(resolve(root, "icons"), resolve(outdir, "icons"));
}

if (existsSync(outdir)) {
  rmSync(outdir, { recursive: true, force: true });
}

const copyStaticAssetsPlugin = {
  name: "copy-static-assets",
  setup(buildApi) {
    buildApi.onEnd(() => {
      copyStaticAssets();
    });
  }
};

const buildOptions = {
  entryPoints: {
    contentScript: "src/content/contentScript.ts",
    background: "src/background/background.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts"
  },
  outdir,
  bundle: true,
  format: "iife",
  target: ["chrome114", "edge114"],
  sourcemap: isDev,
  logLevel: "info",
  plugins: [copyStaticAssetsPlugin]
};

if (watch) {
  copyStaticAssets();
  const buildContext = await context(buildOptions);
  await buildContext.watch();
  await buildContext.rebuild();
} else {
  await build(buildOptions);
}
