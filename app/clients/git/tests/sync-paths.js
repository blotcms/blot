// What ends up in the blog folder after a push, for awkward paths and file
// contents. Part of the regression suite for the git client (#2259): these
// specs only use a real git client over HTTP and look at the blog folder, so
// they must keep passing when the server side is rewritten.
describe("git client sync: paths and file contents", function () {
  // One blog, one clone for all the specs: each uses folders of its own and
  // ends with the clone, the server and the blog folder in agreement.
  require("./setup")({ clone: false, client: true, once: true });

  var fs = require("fs-extra");
  var crypto = require("crypto");
  var helpers = require("./setup/helpers");

  afterEach(async function () {
    await this.local.expectSynced();
  });

  async function expectBlogFiles(ctx, files) {
    for (var path of Object.keys(files)) {
      expect(await helpers.blogFile(ctx, path)).toEqual(
        Buffer.from(files[path]),
        "blog folder file " + path
      );
    }
  }

  it("keeps paths with non-ASCII characters", async function () {
    var files = {
      "/unicode/日本語/こんにちは世界.txt": "Hello in Japanese",
      "/unicode/café/crème brûlée.txt": "Accents",
      "/unicode/ünï/ŝ-ł.txt": "More accents",
      "/unicode/emoji 🎉/party 🎈.txt": "Emoji",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps paths with spaces", async function () {
    var files = {
      "/spaces/a folder with spaces/a file with spaces.txt": "Spaces",
      "/spaces/two  spaces/in  a row.txt": "Two spaces",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps paths with quotes", async function () {
    var files = {
      "/quotes/it's.txt": "Apostrophe",
      '/quotes/say "hello".txt': "Double quotes",
      "/quotes/`tick` $dollar &amp; (brackets) [square].txt": "Shell characters",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps paths with a leading dash", async function () {
    var files = {
      "/-dash.txt": "A file starting with a dash",
      "/-dir/-file.txt": "A folder and file starting with a dash",
      "/--double.txt": "Two dashes",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps deeply nested paths", async function () {
    var folders = [];

    for (var i = 0; i < 40; i++) folders.push("level" + i);

    var path = "/deep/" + folders.join("/") + "/bottom.txt";
    var files = { [path]: "Forty folders down" };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("handles a rename which only changes the case", async function () {
    await this.local.writeAndPush("/case/Readme.txt", "Same file, different case");

    await this.local.git(["mv", "case/Readme.txt", "case/README.txt"]);
    await this.local.commit("Rename Readme.txt to README.txt");
    await this.local.push();

    expect(await fs.readdir(this.blogDirectory + "/case")).toEqual(["README.txt"]);
    expect(await helpers.blogFile(this, "/case/README.txt")).toEqual(
      Buffer.from("Same file, different case")
    );
  });

  it("replaces a file with a directory, and a directory with a file, in one push", async function () {
    await this.local.commitFiles({
      "/swap/a-file.txt": "I am a file",
      "/swap/a-directory.txt/inner.txt": "I am inside a directory",
    });
    await this.local.push();

    expect((await fs.stat(this.blogDirectory + "/swap/a-file.txt")).isFile()).toBe(true);
    expect(
      (await fs.stat(this.blogDirectory + "/swap/a-directory.txt")).isDirectory()
    ).toBe(true);

    await this.local.remove("/swap/a-file.txt");
    await this.local.remove("/swap/a-directory.txt");
    await this.local.write("/swap/a-file.txt/inner.txt", "Now I am inside a directory");
    await this.local.write("/swap/a-directory.txt", "Now I am a file");
    await this.local.commit("Swap files and directories");
    await this.local.push();

    expect((await fs.stat(this.blogDirectory + "/swap/a-file.txt")).isDirectory()).toBe(true);
    expect(await helpers.blogFile(this, "/swap/a-file.txt/inner.txt")).toEqual(
      Buffer.from("Now I am inside a directory")
    );
    expect((await fs.stat(this.blogDirectory + "/swap/a-directory.txt")).isFile()).toBe(true);
    expect(await helpers.blogFile(this, "/swap/a-directory.txt")).toEqual(
      Buffer.from("Now I am a file")
    );
  });

  it("removes a directory from the blog folder when its last file is removed", async function () {
    await this.local.commitFiles({
      "/prune/only/nested/file.txt": "The only file in these folders",
      "/prune/sibling.txt": "Stays",
    });
    await this.local.push();

    await this.local.remove("/prune/only/nested/file.txt");
    await this.local.commit("Remove the only file");
    await this.local.push();

    // Git does not track empty directories, and neither does the blog folder:
    // the whole chain of now-empty folders is gone, the folder with a file is not
    expect(await helpers.blogHas(this, "/prune/only/nested")).toBe(false);
    expect(await helpers.blogHas(this, "/prune/only")).toBe(false);
    expect(await helpers.blogHas(this, "/prune/sibling.txt")).toBe(true);
  });

  it("keeps binary files byte for byte, and empty files", async function () {
    var binary = crypto.randomBytes(8192);

    // NUL bytes at the start, middle and end
    binary[0] = 0;
    binary[4096] = 0;
    binary[binary.length - 1] = 0;

    var files = {
      "/binary/data.bin": binary,
      "/binary/all-bytes.bin": Buffer.from(
        Array.from({ length: 256 }, function (_, i) {
          return i;
        })
      ),
      "/binary/empty.bin": "",
      "/binary/empty.txt": "",
      "/binary/windows lines.txt": "one\r\ntwo\r\nthree\r\n",
      "/binary/no final newline.txt": "no newline at the end",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps the bytes of a file with a filter attribute, whose driver is not configured", async function () {
    // Filter drivers are configured by the user in their own git config, never
    // by the repository, so a filter attribute names a driver the server
    // does not have and the file's committed bytes are what ends up in the folder
    var files = {
      "/.gitattributes": "/filtered/*.txt filter=shout\n",
      "/filtered/quiet.txt": "this text is not shouted\n",
    };

    await this.local.commitFiles(files);
    await this.local.push();

    await expectBlogFiles(this, files);
  });

  it("keeps the executable bit, and a change of it", async function () {
    var path = "/mode/run.sh";

    await this.local.write(path, "#!/bin/sh\necho hello\n");
    await fs.chmod(this.local.path(path), 0o755);
    await this.local.commit("Add an executable file");

    // git recorded the mode (this is the clone, not Blot's side)
    expect((await this.local.git(["ls-files", "--stage", "mode/run.sh"])).stdout).toMatch(
      /^100755 /
    );

    await this.local.push();

    expect((await fs.stat(this.blogDirectory + path)).mode & 0o100).toBe(0o100);

    // Only the mode changes, the content does not
    await fs.chmod(this.local.path(path), 0o644);
    await this.local.commit("Make it not executable");
    await this.local.push();

    expect((await fs.stat(this.blogDirectory + path)).mode & 0o111).toBe(0);
    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("#!/bin/sh\necho hello\n"));
  });
});
