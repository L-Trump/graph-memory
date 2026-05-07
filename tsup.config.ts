import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
