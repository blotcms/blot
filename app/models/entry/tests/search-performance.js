describe("entry.search (performance)", function () {
  // Split from search.js so CI can run these slow, large-fixture specs on
  // other lanes in parallel (scripts/tests/ci/plan.js packs whole files).
  require("./setup")();

  // Some of these tests take a while to run, so we need to increase the timeout
  global.test.timeout(60 * 1000);

  it("returns a maximum of 25 results", async function (done) {
    await this.setMany(
      Array.from({ length: 100 }, (_, i) => ({
        path: `/post${i}.txt`,
        contents: `Hello, world ${i}!`,
      }))
    );

    expect((await this.search("Hello")).length).toEqual(25);

    done();
  });

  it("handles timeout with extremely large text content", async function (done) {
    let largeContent = "Start ";
    for (let i = 0; i < 100000; i++) {
      largeContent += `word${i} `;
    }
    largeContent += " End";
  
    await this.set("/large.txt", largeContent);
  
    const startTime = Date.now();
    const results = await this.search("word50000");
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    expect(results.length).toBeLessThan(2);
  
    done();
  });
  
  it("maintains performance with complex multi-term searches", async function (done) {
    await this.setMany(
      Array.from({ length: 100 }, (_, i) => ({
        path: `/complex${i}.txt`,
        contents: `
        Title: Complex Post ${i}
        Tags: tag${i}, common1, common2
        Custom: custom${i}

        This is a complex post with multiple searchable terms.
        It contains various words like specific${i} and common words.
        Some entries will have unique${i} terms while others share terms.
      `,
      }))
    );

    const startTime = Date.now();
    const results = await this.search("complex specific50 unique50");
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    expect(results.length).toEqual(1);
  
    done();
  });
  
  it("returns partial results if timeout occurs mid-search", async function (done) {
    await this.setMany(
      Array.from({ length: 500 }, (_, i) => ({
        path: `/slow${i}.txt`,
        contents: `
        Title: Slow Search Test ${i}
        Tags: ${Array(100).fill(`tag${i}`).join(", ")}
        Custom: ${Array(100).fill(`custom${i}`).join(" ")}

        ${Array(100).fill(`This is entry ${i}`).join(" ")}
      `,
      })),
      32
    );

    const startTime = Date.now();
    const results = await this.search("entry");
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    expect(results.length).toBeLessThanOrEqual(50);
    expect(results.length).toBeGreaterThan(0);
  
    done();
  });
  
  it("performs well with concurrent searches", async function (done) {
    await this.setMany(
      Array.from({ length: 200 }, (_, i) => ({
        path: `/concurrent${i}.txt`,
        contents: `Post ${i} with some searchable content`,
      })),
      32
    );

    const startTime = Date.now();
    const searches = [
      this.search("Post"),
      this.search("searchable"),
      this.search("content"),
      this.search("Post searchable"),
      this.search("nonexistent")
    ];
  
    const results = await Promise.all(searches);
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    results.forEach(result => {
      expect(result.length).toBeLessThanOrEqual(50);
    });
  
    done();
  });
});
