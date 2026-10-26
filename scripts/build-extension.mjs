import { build } from "esbuild";
await build({
  entryPoints: ["src/platform/background.ts"],
  outfile: "dist/background.js",
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: true,
});
