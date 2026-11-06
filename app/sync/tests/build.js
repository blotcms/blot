describe("build", function () {
  // Set up a test blog before each test
  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;
  });

  beforeEach(function () {
    this.checkEntry = global.test.CheckEntry(this.blog.id);
    this.syncAndCheck = global.test.SyncAndCheck(this.blog.id);
  });

  it("hides date with timestamp from title if its in the file name", function (done) {
    const path = "/2018-10-02-02-35 Hello.png";
    const content = this.fake.file();

    const file = { path, content };
    const entry = { path, title: "Hello" };

    this.syncAndCheck(file, entry, done);
  });

  it("can publish an entry inside a folder with leading and trailing whitespace", function (done) {
    const path = "/ 2018 / Hello.txt";
    const content = "# Hello";

    const file = { path, content };
    const entry = { path, title: "Hello" };

    this.syncAndCheck(file, entry, done);
  });

  it("ignores files in templates folder", function (done) {
    this.syncAndCheck(
      [
        { path: "/Templates/foo.txt", content: this.fake.file() },
        { path: "/templates/bar.txt", content: this.fake.file() },
      ],
      [
        { path: "/Templates/foo.txt", ignored: true },
        { path: "/templates/bar.txt", ignored: true },
      ],
      done
    );
  });

  it("ignores files and files inside folders which start with an underscore", function (done) {
    this.syncAndCheck(
      [
        { path: "/Posts/_foo.txt", content: this.fake.file() },
        { path: "/_Pages/bar.txt", content: this.fake.file() },
        { path: "/Mean/_bar/Ba/t.txt", content: this.fake.file() },
      ],
      [
        { path: "/Posts/_foo.txt", ignored: true },
        { path: "/_Pages/bar.txt", ignored: true },
        { path: "/Mean/_bar/Ba/t.txt", ignored: true },
      ],
      done
    );
  });

  it("ignores dot files and files inside dot folders", function (done) {
    this.syncAndCheck(
      [
        { path: "/.foo.txt", content: this.fake.file() },
        { path: "/.pages/bar.txt", content: this.fake.file() },
        { path: "/mean/.bar/Ba/t.txt", content: this.fake.file() },
      ],
      [
        { path: "/.foo.txt", ignored: true },
        { path: "/.pages/bar.txt", ignored: true },
        { path: "/mean/.bar/Ba/t.txt", ignored: true },
      ],
      done
    );
  });

  it("hides date from title if its in the file name", function (done) {
    const path = "/2018/06-04 Hello.jpg";
    const content = this.fake.file();

    const file = { path, content };
    const entry = { path, title: "Hello" };

    this.syncAndCheck(file, entry, done);
  });

  it("incorporates slug metadata into a permalink format", function (done) {
    const ctx = this;
    require("models/blog").set(
      ctx.blog.id,
      { permalink: { format: "/post/{{slug}}" } },
      () => {
        const path = "/hey.txt";
        const content = "Slug: foo\n\nHey!";

        const file = { path, content };
        const entry = { path, url: "/post/foo" };

        ctx.syncAndCheck(file, entry, done);
      }
    );
  });

  it("uses slug metadata", function (done) {
    const path = "/hey.txt";
    const content = "Slug: foo\n\nHey!";

    const file = { path, content };
    const entry = { path, url: "/foo" };

    this.syncAndCheck(file, entry, done);
  });

  it("uses link metadata", function (done) {
    const path = "/hey.txt";
    const content = "Link: example.com/\n\nHey!";

    const file = { path, content };
    const entry = { path, url: "/example.com" };

    this.syncAndCheck(file, entry, done);
  });

  it("ignores link metadata if it contains a full URL", function (done) {
    const path = "/hey.txt";
    const content = "Link: http://example.com/\n\nHey!";

    const file = { path, content };
    const entry = { path, url: "/hey" };

    this.syncAndCheck(file, entry, done);
  });

  it("hides tags from title if its in the file name", function (done) {
    const path = "/[Tag] Hello.jpg";
    const content = this.fake.file();

    const file = { path, content };
    const entry = { path, title: "Hello" };

    this.syncAndCheck(file, entry, done);
  });

  it("rebuilds dependent entries", async function (done) {
    var path = "/post.txt";
    var content = "![](/image.png)";

    var imagePath = "/image.png";
    var imageContent = await this.fake.image();

    const files = [
      { path, content },
      { path: imagePath, content: imageContent },
    ];

    const entry = {
      path,
      html: (result) =>
        result.indexOf("cdn.") > -1 && result.indexOf(this.blog.id) > -1,
    };

    this.syncAndCheck(files, entry, done);
  });
});
