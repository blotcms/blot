describe("entry.search (large dataset)", function () {
  // Split from search.js so CI can run these slow, large-fixture specs on
  // other lanes in parallel (scripts/tests/ci/plan.js packs whole files).
  require("./setup")();

  // Some of these tests take a while to run, so we need to increase the timeout
  global.test.timeout(60 * 1000);

  it("returns results within timeout even with large dataset", async function (done) {
    await this.setMany(
      Array.from({ length: 1000 }, (_, i) => ({
        path: `/post${i}.txt`,
        contents: `Hello, world ${i}! Some more content to search through.`,
      })),
      32
    );

    const startTime = Date.now();
    const results = await this.search("Hello");
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    expect(results.length).toEqual(25);
  
    done();
  });
});
