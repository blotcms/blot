// ESLint (flat config). Correctness rules only: formatting is Prettier's job
// (the "prettier" key of package.json). Run both with
// scripts/development/lint.sh, which passes this file with --config and gives
// Prettier the ignores below too.
const js = require("@eslint/js");
const globals = require("globals");
const promise = require("eslint-plugin-promise");

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
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // `try { ... } catch (e) {}` is the idiom for best-effort cleanup
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The async library is gone (#2559): use async/await
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value='async']",
          message: "Use async/await instead of the async library.",
        },
      ],
    },
  },

  // promise/prefer-await-to-callbacks (eslint-plugin-promise), so callback
  // style can't come back where it has been removed (#2559). Only folders with
  // no violations are listed, and folders join the list as phase 3 converts
  // them. Specs are left out. The rule also flags any parameter named
  // callback, cb or done, and error-first handlers such as .catch((err) =>
  // ...), so a folder whose only hits are Express next or stream callbacks
  // stays off the list rather than carrying eslint-disable comments.
  {
    files: [
      "app/blog/lib/asRetriever.js",
      "app/blog/middleware/**/*.js",
      "app/blog/render/load/**/*.js",
      "app/blog/render/middleware.js",
      "app/blog/render/replaceFolderLinks/**/*.js",
      "app/blog/render/retrieve/**/*.js",
      "app/blog/render/view.js",
      "app/blog/static/**/*.js",
      "app/build/converters/docx/**/*.js",
      "app/build/converters/html/**/*.js",
      "app/build/converters/markdown/**/*.js",
      "app/build/converters/odt/**/*.js",
      "app/build/converters/org/**/*.js",
      "app/build/converters/rtf/**/*.js",
      "app/build/converters/webloc/**/*.js",
      "app/build/dependencies/**/*.js",
      "app/build/plugins/**/*.js",
      "app/build/prepare/**/*.js",
      "app/cdn/**/*.js",
      "app/clients/git/store/objectStore/**/*.js",
      "app/clients/google-drive/serviceAccount/**/*.js",
      "app/clients/google-drive/sync/**/*.js",
      "app/clients/icloud/routes/site/middleware/**/*.js",
      "app/clients/icloud/sync/**/*.js",
      "app/clients/icloud/util/**/*.js",
      "app/dashboard/account/util/**/*.js",
      "app/dashboard/site/save/**/*.js",
      "app/dashboard/site/template/load/**/*.js",
      "app/documentation/questions/**/*.js",
      "app/documentation/tools/finder/**/*.js",
      "app/documentation/tools/typeset/**/*.js",
      "app/helper/egress/**/*.js",
      "app/helper/lock/**/*.js",
      "app/models/404/**/*.js",
      "app/models/blog/bumpCacheID.js",
      "app/models/blog/create.js",
      "app/models/blog/remove.js",
      "app/models/blog/set.js",
      "app/models/blog/setStatus.js",
      "app/models/blog/util/**/*.js",
      "app/models/blog/validate/**/*.js",
      "app/models/entries/**/*.js",
      "app/models/file/**/*.js",
      "app/models/ignoredFiles/**/*.js",
      "app/models/question/**/*.js",
      "app/models/redirects/**/*.js",
      "app/models/tags/**/*.js",
      "app/models/template/fullViewCache.js",
      "app/models/template/getFullView.js",
      "app/models/template/package.js",
      "app/models/template/readFromFolder.js",
      "app/models/template/removeEnabledFromAllTemplates.js",
      "app/models/user/create.js",
      "app/models/user/validate/**/*.js",
      "app/site/**/*.js",
      // app/sync/index.js, establishSyncLock.js and messenger.js keep the
      // sync(blogID, (err, folder, done) => ...) contract for now
      "app/sync/fix/**/*.js",
      "app/sync/hold.js",
      "app/sync/lock-diagnostics-state.js",
      "app/sync/lock-diagnostics.js",
      "app/sync/lock.js",
      "app/sync/rebuild.js",
      "app/sync/renames.js",
      "app/sync/update/**/*.js",
      "scripts/deploy/**/*.js",
      "scripts/development/lint/**/*.js",
      "scripts/folder-links/**/*.js",
      "scripts/probe/**/*.js",
      "scripts/questions/**/*.js",
      "scripts/security/**/*.js",
      "scripts/test/**/*.js",
    ],
    ignores: [
      "**/tests/**",
      "**/tests.js",
      // Scripts that run in the visitor's browser, where .catch((err) => ...)
      // is not a callback API of ours
      "app/build/plugins/*/public.js",
      // isDraft and injectScript still take callbacks
      "app/sync/update/drafts.js",
    ],
    plugins: { promise },
    rules: { "promise/prefer-await-to-callbacks": "error" },
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
      // `test` is the spec helper scripts/tests sets up as a global
      globals: { ...globals.jasmine, test: "readonly" },
    },
  },
];
