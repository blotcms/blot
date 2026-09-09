const sharedSetup = require("../../tests/util/sharedSetup");

module.exports = function setupBenchmark(options = {}) {
  const benchmarkConfig = global.__BLOT_BENCHMARK_CONFIG || {};
  const blogs = Number(options.blogs || benchmarkConfig.sites || 5);

  return sharedSetup({
    blogs,
    ...options,
  });
};
