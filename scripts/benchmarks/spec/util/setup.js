const sharedSetup = require("../../../../app/blog/tests/util/sharedSetup");
const setupCorpusRender = require("./corpusSetup");

module.exports = function setupBenchmark(options = {}) {
  const benchmarkConfig = global.__BLOT_BENCHMARK_CONFIG || {};

  // corpusMode "render" runs against blogs from an already-built, restored
  // corpus (see corpusSetup.js) rather than creating fresh ones.
  if (benchmarkConfig.corpusMode === "render") {
    return setupCorpusRender(benchmarkConfig.corpusManifestPath);
  }

  const blogs = Number(options.blogs || benchmarkConfig.sites || 5);

  // corpusMode "build" (see build-corpus.js) needs every blog's Redis keys
  // and disk folders to survive past the spec's own afterEach hooks: the
  // host-side orchestrator only SAVEs Redis and tars data/blogs|static
  // *after* this whole `docker run` invocation exits, which is well after
  // sharedSetup's normal per-blog afterEach teardown would otherwise have
  // already deleted everything (afterEach runs at the end of this file's
  // single `it()`, not after the container process exits). Skip registering
  // that teardown here so the corpus snapshot captures real data.
  const skipTeardown = benchmarkConfig.corpusMode === "build";

  return sharedSetup({
    blogs,
    skipTeardown,
    ...options,
  });
};
