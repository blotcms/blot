const path = require("path");
const fs = require("fs-extra");
const seedrandom = require("seedrandom");
const { performance } = require("perf_hooks");
const localPath = require("helper/localPath");
const config = require("config");
const { ensureMediaPool } = require("../lib/generate-media");
const { PhaseMonitor, summarizeDurations } = require("./util/metrics");
const { buildWorkload } = require("./util/workload");
const { expandSitemapUrls } = require("./util/sitemap");
const { runWithConcurrency } = require("./util/concurrency");
const { parseBenchmarkConfig } = require("./util/config");
const { buildBenchmarkResult } = require("./util/result");
const { runTagBurst } = require("./util/tagBurst");
const { runArchivesBurst } = require("./util/archivesBurst");
const { runSearchBurst } = require("./util/searchBurst");
const { runSitemapBurst } = require("./util/sitemapBurst");
const { runBacklinksBurst } = require("./util/backlinksBurst");
const { runNotFoundBurst } = require("./util/notFoundBurst");

// Reconstructs the subset of buildWorkload()'s return shape the render +
// burst phases and buildBenchmarkResult() actually read, from the manifest
// build-corpus.js wrote when it originally built these sites (corpusMode
// "build"). No files are (re)written in corpusMode "render" - they already
// exist from that build - so there's no per-file list to rebuild here.
function workloadFromManifest(manifest) {
  const sites = manifest.sites || [];
  const filesPerSite = sites.map((site) => site.filesWritten || 0);
  const totalFiles = filesPerSite.reduce((sum, n) => sum + n, 0);

  return {
    files: { length: totalFiles },
    filesPerSite,
    fixtureCount: manifest.fixtureCount || 0,
    distribution: manifest.config ? manifest.config.distribution : "skewed",
    tagsBySite: sites.map((site) => site.tags || []),
    searchKeywordsBySite: sites.map((site) => site.searchKeywords || []),
    hubPathBySite: sites.map((site) => site.hubPath || null),
  };
}

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

    const isCorpusRender = benchmarkConfig.corpusMode === "render";
    const isCorpusBuild = benchmarkConfig.corpusMode === "build";

    if (!isCorpusRender && blogs.length !== benchmarkConfig.sites) {
      throw new Error(
        `Expected ${benchmarkConfig.sites} benchmark sites but got ${blogs.length}`
      );
    }

    const rng = seedrandom(benchmarkConfig.seed);

    // The shared media pool (see lib/generate-media.js) is generated fresh
    // into data/blogs/_benchmark-media-pool - a fixed directory *inside*
    // config.blog_folder_dir, sibling to the per-blog folders, deliberately
    // NOT checked into git. Living inside data/blogs means it's swept up
    // for free by whatever already tars/restores data/blogs (see
    // build-corpus.js and benchmarks-render.yml), so a restored corpus's
    // hard links (see the write step below for why hard link, not symlink)
    // keep resolving without tracking a fourth artifact. Generated once and
    // reused for every post that wants a media file in this run.
    let mediaFiles = [];

    if (!isCorpusRender && benchmarkConfig.mediaFraction > 0) {
      const mediaPoolDir = path.join(
        config.blog_folder_dir,
        "_benchmark-media-pool"
      );
      mediaFiles = await ensureMediaPool(mediaPoolDir, benchmarkConfig.seed);
    }

    // corpusMode "render" skips workload generation entirely and instead
    // reconstructs an equivalent workload summary from the manifest written
    // by build-corpus.js when the corpus was built (see corpusSetup.js),
    // since the actual files already exist on disk/Redis from that build.
    const workload = isCorpusRender
      ? workloadFromManifest(this.corpusManifest)
      : buildWorkload(benchmarkConfig, blogs, rng, mediaFiles);

    if (isCorpusRender) {
      // Only --corpus-mode/--corpus-manifest-path are passed on the CLI for
      // a render-mode run, so benchmarkConfig.sites/files would otherwise
      // stay at the flat-mode defaults (5/1000) even though the actual
      // restored corpus has ~1000 sites/~160k posts - misleading both the
      // result JSON's config.sites/files and build.sites_total, and the PR
      // comment/history built from them. Read the real counts from what was
      // actually restored.
      benchmarkConfig.sites = blogs.length;
      benchmarkConfig.files = workload.files.length;
    }

    const buildPhaseMonitor = new PhaseMonitor({
      sampleIntervalMs: benchmarkConfig.cpuSampleIntervalMs,
    });

    const buildSiteDurations = blogs.map(() => 0);

    if (!isCorpusRender) {
      const writeTasks = workload.files.map((file) => ({
        ...file,
        blog: blogs[file.blogIndex],
      }));

      buildPhaseMonitor.start();

      await runWithConcurrency(writeTasks, benchmarkConfig.writeConcurrency, async (task) => {
        if (task.mediaPath != null) {
          // Hard-link into the shared media pool (scripts/benchmarks/fixtures/
          // media) instead of copying unique bytes per post, so even a
          // 160k-post corpus stays cheap to write/tar.
          //
          // NOTE: this is deliberately a *hard* link, not a symlink.
          // app/helper/assertNoSymlinks.js is called on every path inside a
          // blog folder during sync (see app/sync/update/index.js and
          // app/blog/routes/assets.js) and unconditionally rejects any
          // symlink - including the final path component itself - with
          // ELOOP. A hard link is indistinguishable from an ordinary file to
          // lstat(), so it passes that check, and because every post that
          // references the same pool file shares one inode, `tar` still only
          // stores that file's bytes once per archive (subsequent hard-linked
          // paths are recorded as link references), so data/blogs/ stays
          // small exactly like the symlink approach would have, without
          // tripping the no-symlinks guard.
          let blogDir = localPath(task.blog.id, "/");
          if (blogDir.endsWith("/")) blogDir = blogDir.slice(0, -1);
          const destPath = blogDir + task.path;
          await fs.ensureDir(path.dirname(destPath));
          await fs.remove(destPath);
          try {
            await fs.link(task.mediaPath, destPath);
          } catch (err) {
            // EXDEV: media pool and data/blogs live on different filesystems/
            // mounts (e.g. some local dev setups). Fall back to a plain copy -
            // more disk, but still correct.
            if (err.code === "EXDEV") {
              await fs.copy(task.mediaPath, destPath);
            } else {
              throw err;
            }
          }
        } else if (task.sourcePath != null) {
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
    } else {
      // Nothing to build - blogs already exist, fully built, from the
      // restored corpus. Start/stop immediately so the result JSON still has
      // a (all-zero) build section rather than needing special-casing
      // downstream; benchmarks-render.yml's history/regression tracking only
      // looks at render/burst metrics anyway.
      buildPhaseMonitor.start();
    }

    const buildPhaseMetrics = buildPhaseMonitor.stop();
    const buildDurations = summarizeDurations(buildSiteDurations);

    if (isCorpusBuild) {
      // build-corpus.js only needs the sites built and their manifest info
      // (workload.tagsBySite/searchKeywordsBySite/hubPathBySite/
      // filesPerSite) - it snapshots Redis + data/blogs + data/static
      // itself, so stop here rather than also rendering every page.
      global.__BLOT_BENCHMARK_RESULT = { corpus_build: true };
      global.__BLOT_CORPUS_WORKLOAD = workload;
      global.__BLOT_CORPUS_BLOGS = blogs.map((blog) => ({
        blogID: blog.id,
        handle: blog.handle,
      }));
      return;
    }

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

    console.log(
      "[benchmark] tag burst:",
      benchmarkConfig.tagBurstConcurrency,
      "distinct tag pages requested concurrently per site"
    );

    const tagBurst = await runTagBurst({
      blogs,
      tagsBySite: workload.tagsBySite,
      concurrency: benchmarkConfig.tagBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

    console.log(
      "[benchmark] archives burst:",
      benchmarkConfig.archivesBurstConcurrency,
      "concurrent /archives requests across",
      blogs.length,
      "site(s)"
    );

    const archivesBurst = await runArchivesBurst({
      blogs,
      concurrency: benchmarkConfig.archivesBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

    console.log(
      "[benchmark] search burst:",
      benchmarkConfig.searchBurstConcurrency,
      "distinct search queries requested concurrently per site"
    );

    const searchBurst = await runSearchBurst({
      blogs,
      keywordsBySite: workload.searchKeywordsBySite,
      concurrency: benchmarkConfig.searchBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

    console.log(
      "[benchmark] sitemap burst:",
      benchmarkConfig.sitemapBurstConcurrency,
      "concurrent /sitemap.xml requests across",
      blogs.length,
      "site(s)"
    );

    const sitemapBurst = await runSitemapBurst({
      blogs,
      concurrency: benchmarkConfig.sitemapBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

    console.log(
      "[benchmark] backlinks burst:",
      benchmarkConfig.backlinksBurstConcurrency,
      "concurrent requests to each site's hub entry"
    );

    const backlinksBurst = await runBacklinksBurst({
      blogs,
      hubPathBySite: workload.hubPathBySite,
      concurrency: benchmarkConfig.backlinksBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

    console.log(
      "[benchmark] not-found burst:",
      benchmarkConfig.notFoundBurstConcurrency,
      "concurrent requests to guaranteed-404 paths across",
      blogs.length,
      "site(s)"
    );

    const notFoundBurst = await runNotFoundBurst({
      blogs,
      concurrency: benchmarkConfig.notFoundBurstConcurrency,
      getForBlog: this.getForBlog.bind(this),
    });

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
      tagBurst,
      archivesBurst,
      searchBurst,
      sitemapBurst,
      backlinksBurst,
      notFoundBurst,
    });

    global.__BLOT_BENCHMARK_RESULT = result;

    if (!isCorpusRender) {
      expect(workload.files.length).toEqual(
        benchmarkConfig.files + workload.fixtureCount * blogs.length
      );
    }
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
    const totalDiskIoOps =
      result.build.disk_io.total_ops + result.render.disk_io.total_ops;
    const totalSeconds = totalWallMs / 1000;
    const label = (s) => ("  " + s).padEnd(26);
    const num = (n, width = 10) => String(n).padStart(width);

    console.log("");
    console.log(label("Requests per page") + num(benchmarkConfig.requestsPerPage, 8));
    console.log(label("Total CPU") + num(totalCpuPercent.toFixed(2), 8) + " %");
    console.log(label("Total Memory") + num(Math.round(totalMemoryMb), 8) + " mb");
    console.log(label("Total Disk I/O") + num(totalDiskIoOps, 8) + " ops");
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

    const bursts = [
      ["Tag burst", result.render.tag_burst],
      ["Archives burst", result.render.archives_burst],
      ["Search burst", result.render.search_burst],
      ["Sitemap burst", result.render.sitemap_burst],
      ["Backlinks burst", result.render.backlinks_burst],
      ["Not-found burst", result.render.not_found_burst],
    ];

    for (const [burstLabel, burst] of bursts) {
      console.log(
        label(`${burstLabel} inflation`) +
          num(
            burst.inflation_ratio === null
              ? "n/a"
              : burst.inflation_ratio.toFixed(2),
            8
          ) + "x"
      );
      console.log(
        label(`${burstLabel} p95`) +
          num(burst.burst_timing_ms.p95.toFixed(0), 8) +
          " ms"
      );
    }

    console.log("");
  });
});
