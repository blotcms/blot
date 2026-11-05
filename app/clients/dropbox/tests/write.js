describe("dropbox client", function () {
  // Create test user and tmp directory
  require("./setup")();

  var folder = require("storage/folder");
  var write = require("../write");

  beforeEach(function () {
    this.path = this.fake.path(".txt");
    this.path = this.fake.path(".txt");
    this.contents = this.fake.file();
  });

  afterEach(async function () {
    var contents = this.contents;
    expect(
      (await folder.read(this.blog.id, this.path)).toString("utf-8")
    ).toEqual(contents);

    let res;

    try {
      res = await this.client.filesDownload({ path: this.folder + this.path });
    } catch (err) {
      throw new Error(err);
    }

    // Check file exists in blog directory in Dropbox
    expect(res.fileBinary.toString("utf-8")).toEqual(contents);
  });

  xit("writes a file", function (done) {
    write(this.blog.id, this.path, this.contents, done);
  });
});
