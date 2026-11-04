// ESLint (flat config). Correctness rules only: no stylistic rules, since
// formatting is a separate decision and would touch every file.
//
// Existing violations are recorded in eslint-suppressions.json, so CI fails
// only on new ones. When you fix some, run `npm run lint -- --prune-suppressions`
// to drop them from the file.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "data/**",
      "app/views-built/**",
      "coverage/**",
      ".nyc_output/**",
      ".benchmarks/**",
      "scripts/development/agentation/**",
      // Mustache templates that only become JavaScript once rendered
      "app/templates/source/**",
      "app/build/plugins/analytics/public.js",
      // Vendored and minified third-party code
      "**/*.min.js",
      "app/views/dashboard/template/js/codemirror/**",
      "app/views/js/instant.page.js",
      "app/views/js/localforage.js",
      "app/views/js/sortable.js",
      "app/views/js/tagify.js",
      "app/views/js/reconnecting-event-source.js",
      "app/views/js/tz_detect.js",
      "app/build/plugins/zoom/public.js",
      "app/build/converters/webloc/biginteger.js",
      "app/build/converters/webloc/bplist.js",
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Callback-style code routinely names unused (err, ...) arguments
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },

  // ES modules: the macserver's package.json sets "type": "module"
  {
    files: ["**/*.mjs", "app/clients/icloud/macserver/**/*.js"],
    languageOptions: { sourceType: "module" },
  },

  // Dashboard and documentation scripts, bundled for the browser by esbuild
  // (app/documentation/build/js.js) as CommonJS modules
  {
    files: ["app/views/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Plugin scripts injected into blog pages
  {
    files: ["app/build/plugins/*/public.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },

  // Jasmine specs
  {
    files: [
      "**/tests/**/*.js",
      "**/tests.js",
      "scripts/benchmarks/spec/**/*.js",
    ],
    languageOptions: {
      globals: { ...globals.jasmine },
    },
  },
];
