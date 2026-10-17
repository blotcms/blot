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

  it("matches the decoded file name of a baked folder link, not its prefix", async function (done) {
    const fs = require("fs-extra");
    const path = "/post.txt";

    fs.outputFileSync(this.blogDirectory + "/Café pic.jpg", "image");
    fs.outputFileSync(this.blogDirectory + "/l'été.jpg", "image");
    const entry = await this.set(path, "![](Café%20pic.jpg) ![](l'%C3%A9t%C3%A9.jpg)");

    expect(entry.html).toContain("Caf%C3%A9%20pic.jpg");
    expect(entry.html).toContain("l%27%C3%A9t%C3%A9.jpg");
    expect((await this.search("café pic.jpg")).map((r) => r.id)).toEqual([path]);
    expect((await this.search("été")).map((r) => r.id)).toEqual([path]);
    expect(await this.search("folder")).toEqual([]);

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
});
