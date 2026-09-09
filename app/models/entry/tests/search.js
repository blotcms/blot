describe("entry.search", function () {
  require("./setup")();

  // Some of these tests take a while to run, so we need to increase the timeout
  global.test.timeout(60 * 1000);

  it("works with a single entry", async function (done) {
    const path = "/post.txt";
    const contents = `Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, world!`;

    const check = results => {
      expect(results.length).toEqual(1);
      expect(results[0].id).toEqual(path);
    };

    await this.set(path, contents);

    // Exact match
    check(await this.search("Hello"));

    // Lowercase
    check(await this.search("hello"));

    // With extra whitespace
    check(await this.search("  hello  "));

    // With multiple terms
    check(await this.search("hello world"));

    // File name
    check(await this.search("post.txt"));

    // Custom metadata values
    check(await this.search("metadata"));

    // Tags
    check(await this.search("apple"));

    done();
  });

  it("works with two entries", async function (done) {
    const path1 = "/post.txt";
    const contents1 = `Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, you!`;

    const path2 = "/post2.txt";
    const contents2 = `Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, me!`;

    const check = results => {
      // sort results by id
      results.sort((a, b) => a.id.localeCompare(b.id));

      expect(results.length).toEqual(2);
      expect(results[0].id).toEqual(path1);
      expect(results[1].id).toEqual(path2);
    };

    await this.set(path1, contents1);
    await this.set(path2, contents2);

    // Exact match
    check(await this.search("Hello"));

    // Lowercase
    check(await this.search("hello"));

    done();
  });

  it("supports non-latin characters", async function (done) {
    const path = "/post.txt";
    const contents = `Custom: Metadata hello!
    Tags: apple, pear, orange
    
    你好，世界！`;

    const check = results => {
      expect(results.length).toEqual(1);
      expect(results[0].id).toEqual(path);
    };

    await this.set(path, contents);

    // Exact match
    check(await this.search("你好"));

    // Lowercase
    check(await this.search("你好"));

    done();
  });

  it("ignores deleted entries", async function (done) {
    const path = "/post.txt";
    const contents = `Hello, world!`;

    await this.set(path, contents);

    expect((await this.search("Hello")).length).toEqual(1);

    await this.remove(path);

    expect((await this.search("Hello")).length).toEqual(0);

    done();
  });

  it("ignores draft entries", async function (done) {
    const path = "/post.txt";
    const contents = `Draft: true

    Hello, world!`;

    await this.set(path, contents);

    expect((await this.search("Hello")).length).toEqual(0);

    done();
  });

  it("ignores entries with Search: no metadata", async function (done) {
    const path = "/post.txt";
    const contents = `Search: no
    Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, world!`;

    const check = results => {
      expect(results.length).toEqual(0);
    };

    await this.set(path, contents);

    // Exact match
    check(await this.search("Hello"));

    done();
  });


  it("ignores entries with mixed-case Search metadata set to no", async function (done) {
    const path = "/post-mixed-search.txt";
    const contents = `SeArCh: no
    Hello, world!`;

    await this.set(path, contents);

    expect((await this.search("Hello")).length).toEqual(0);

    done();
  });

  it("includes pages with Search: yes metadata", async function (done) {
    const path = "/Pages/About.txt";
    const contents = `Search: yes
    Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, world!`;

    const check = results => {
      expect(results.length).toEqual(1);
      expect(results[0].id).toEqual(path);
    };

    await this.set(path, contents);

    // Exact match
    check(await this.search("Hello"));

    done();
  });

  it("includes pages with Search: true metadata", async function (done) {
    const path = "/Pages/About.txt";
    const contents = `Search: true
    Custom: Metadata hello!
    Tags: apple, pear, orange
    
    Hello, world!`;

    const check = results => {
      expect(results.length).toEqual(1);
      expect(results[0].id).toEqual(path);
    };

    await this.set(path, contents);

    // Exact match
    check(await this.search("Hello"));

    done();
  });

  it("requires boths terms to be present in multi-term search", async function (done) {
    await this.set("/post.txt", `Hello, world!`);

    await this.set("/second.txt", `Hello, goodbye!`);

    expect((await this.search("Hello world")).length).toEqual(1);

    done();
  });

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

  it("returns results within timeout even with large dataset", async function (done) {
    await this.setMany(
      Array.from({ length: 1000 }, (_, i) => ({
        path: `/post${i}.txt`,
        contents: `Hello, world ${i}! Some more content to search through.`,
      }))
    );

    const startTime = Date.now();
    const results = await this.search("Hello");
    const duration = Date.now() - startTime;
  
    expect(duration).toBeLessThanOrEqual(4100);
    expect(results.length).toEqual(25);
  
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
      }))
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
      }))
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
