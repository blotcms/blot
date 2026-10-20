import { build } from "esbuild";

await build({
  entryPoints: [new URL("browser.jsx", import.meta.url).pathname],
  outfile: new URL("dist/toolbar.js", import.meta.url).pathname,
  bundle: true,
  format: "iife",
  minify: true,
  // Agentation 3.1.2 gates React-tree inspection on this build constant.
  // Its API has no reactComponents prop. DOM selectors still work normally.
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
