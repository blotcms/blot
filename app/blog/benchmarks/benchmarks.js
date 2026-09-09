const path = require("path");
const fs = require("fs-extra");
const seedrandom = require("seedrandom");
const { performance } = require("perf_hooks");
const localPath = require("helper/localPath");
const { PhaseMonitor, summarizeDurations } = require("./util/metrics");
const { buildWorkload } = require("./util/workload");
const { expandSitemapUrls } = require("./util/sitemap");
const { runWithConcurrency } = require("./util/concurrency");
const { parseBenchmarkConfig } = require("./util/config");
const { buildBenchmarkResult } = require("./util/result");

describe("blog benchmarks", function () {
  require("./util/setup")();

  global.test.timeout(20 * 60 * 1000);

  it("measures build and render performance", async function () {
    const benchmarkConfig = parseBenchmarkConfig(
      global.__BLOT_BENCHMARK_CONFIG || {}
    );

    const blogs = Array.isArray(this.blogs) && this.blogs.length
      ? this.blogs
      : this.blog
      ? [this.blog]
      : [];

    if (blogs.length !== benchmarkConfig.sites) {
      throw new Error(
        `Expected ${benchmarkConfig.sites} benchmark sites but got ${blogs.length}`
      );
    }

    const rng = seedrandom(benchmarkConfig.seed);
    const workload = buildWorkload(benchmarkConfig, blogs, rng);

    const buildPhaseMonitor = new PhaseMonitor({
      sampleIntervalMs: benchmarkConfig.cpuSampleIntervalMs,
    });

    const writeTasks = workload.files.map((file) => ({
      ...file,
      blog: blogs[file.blogIndex],
    }));

    const buildSiteDurations = [];

    buildPhaseMonitor.start();

    await runWithConcurrency(writeTasks, benchmarkConfig.writeConcurrency, async (task) => {
      if (task.sourcePath != null) {
        let blogDir = localPath(task.blog.id, "/");
        if (blogDir.endsWith("/")) blogDir = blogDir.slice(0, -1);
        const destPath = blogDir + task.path;
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(task.sourcePath, destPath);
      } else {
        await task.blog.write({ path: task.path, content: task.content });
      }
    });

    await Promise.all(
      blogs.map(async (blog, index) => {
        const startedAt = performance.now();
        await blog.rebuild();
        buildSiteDurations[index] = performance.now() - startedAt;
      })
    );

    const buildPhaseMetrics = buildPhaseMonitor.stop();
    const buildDurations = summarizeDurations(buildSiteDurations);

    const renderPhaseMonitor = new PhaseMonitor({
      sampleIntervalMs: benchmarkConfig.cpuSampleIntervalMs,
    });

    const renderDurations = [];
    const renderFailures = [];
    const siteSummaries = [];
    const renderTasks = [];
    const bytesPerSite = new Array(blogs.length).fill(0);

    for (let index = 0; index < blogs.length; index++) {
      const blog = blogs[index];
      const sitemapRes = await this.getForBlog(blog, "/sitemap.xml", {
        redirect: "manual",
      });

      if (sitemapRes.status !== 200) {
        throw new Error(
          `Failed to fetch sitemap.xml for ${blog.handle}: status=${sitemapRes.status}`
        );
      }

      const sitemapXML = await sitemapRes.text();
      const sitemapPaths = await expandSitemapUrls(
        blog,
        sitemapXML,
        this.getForBlog.bind(this)
      );

      if (!sitemapPaths.length) {
        throw new Error(`No sitemap paths found for blog ${blog.handle}`);
      }

      const n = benchmarkConfig.requestsPerPage;
      console.log(
        "[benchmark]",
        blog.handle,
        `${sitemapPaths.length} sitemap pages × ${n} =>`,
        sitemapPaths.length * n,
        "render tasks"
      );

      siteSummaries.push({
        blog_id: blog.id,
        handle: blog.handle,
        files_written: workload.filesPerSite[index] || 0,
        sitemap_page_count: sitemapPaths.length,
      });

      for (const path of sitemapPaths) {
        for (let r = 0; r < n; r++) {
          renderTasks.push({ blogIndex: index, blog, path });
        }
      }
    }

    console.log(
      "[benchmark] total render tasks (Total requests):",
      renderTasks.length
    );

    renderPhaseMonitor.start();

    await runWithConcurrency(
      renderTasks,
      benchmarkConfig.renderConcurrency,
      async ({ blogIndex, blog, path }) => {
        const startedAt = performance.now();
        const res = await this.getForBlog(blog, path, { redirect: "manual" });
        const body = await res.arrayBuffer();

        const elapsedMs = performance.now() - startedAt;
        renderDurations.push(elapsedMs);
        bytesPerSite[blogIndex] += body.byteLength;

        if (res.status >= 400) {
          renderFailures.push({ blogIndex, path, status: res.status });
        }
      }
    );

    const renderPhaseMetrics = renderPhaseMonitor.stop();
    const renderTiming = summarizeDurations(renderDurations);

    siteSummaries.forEach((summary, index) => {
      summary.rendered_pages = renderTasks.filter(
        (task) => task.blog.id === summary.blog_id
      ).length;
      summary.non_2xx = renderFailures.filter(
        (failure) => blogs[failure.blogIndex].id === summary.blog_id
      ).length;
      summary.rendered_bytes = bytesPerSite[index] || 0;
    });

    const renderBytesTotal = bytesPerSite.reduce((sum, n) => sum + n, 0);

    const result = buildBenchmarkResult({
      benchmarkConfig,
      workload,
      buildPhaseMetrics,
      buildDurations,
      buildSiteDurations,
      renderPhaseMetrics,
      renderTiming,
      renderBytesTotal,
      siteSummaries,
      renderTasks,
      renderFailures,
    });

    global.__BLOT_BENCHMARK_RESULT = result;

    expect(workload.files.length).toEqual(
      benchmarkConfig.files + workload.fixtureCount * blogs.length
    );
    expect(renderTasks.length).toBeGreaterThan(0);
    expect(renderFailures.length).toEqual(0);

    const totalWallMs =
      result.build.timing_ms.total + result.render.timing_ms.total;
    const totalCpuMs =
      result.build.cpu.user_ms +
      result.build.cpu.system_ms +
      result.render.cpu.user_ms +
      result.render.cpu.system_ms;
    const totalCpuPercent =
      totalWallMs > 0 ? (totalCpuMs / totalWallMs) * 100 : 0;
    const totalMemoryMb = Math.max(
      result.build.memory_mb.peak_rss,
      result.render.memory_mb.peak_rss
    );
    const totalSeconds = totalWallMs / 1000;
    const label = (s) => ("  " + s).padEnd(26);
    const num = (n, width = 10) => String(n).padStart(width);

    console.log("");
    console.log(label("Requests per page") + num(benchmarkConfig.requestsPerPage, 8));
    console.log(label("Total CPU") + num(totalCpuPercent.toFixed(2), 8) + " %");
    console.log(label("Total Memory") + num(Math.round(totalMemoryMb), 8) + " mb");
    console.log(label("Total requests") + num(result.render.sitemap_pages_total, 8));
    console.log("");
    console.log(label("Total time") + num(totalSeconds.toFixed(1), 8) + " seconds");
    console.log(
      label("Mean build time") +
        num(result.build.timing_ms.mean.toFixed(0), 8) +
        " ms per site"
    );
    console.log(
      label("Mean blog render time") +
        num(result.render.timing_ms.mean.toFixed(0), 8) +
        " ms per page"
    );
    console.log(
      label("Mean output size") +
        num((result.render.bytes.mean_per_page / 1024).toFixed(1), 8) +
        " kb per page"
    );
    console.log("");
  });
});
