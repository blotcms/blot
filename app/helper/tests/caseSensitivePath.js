describe("caseSensitivePath ", function () {
  var resolveCaseInsensitivePathToFile = require("../caseSensitivePath");
  var fs = require("fs-extra");
  var os = require("os");

  // The helper reads a real directory, so give it one of its own
  beforeEach(async function () {
    this.cwd = await fs.mkdtemp(os.tmpdir() + "/blot-case-sensitive-path-");
  });

  afterEach(async function () {
    await fs.remove(this.cwd);
  });

  it("resolves case insensitive paths to a file", async function () {
    var cwd = this.cwd;

    for (var i = 0; i < 100; i++) {
      var truePath = global.test.fake.path(Date.now().toString() + ".txt");
      var randomizedPath = addSlashes(randomizeCase(truePath));
      fs.outputFileSync(cwd + truePath, "");

      var resolvedPath = await resolveCaseInsensitivePathToFile(
        cwd,
        randomizedPath
      );

      expect(resolvedPath).toEqual(cwd + truePath);
      fs.emptyDirSync(cwd);
    }
  });
});

function addSlashes(path) {
  path = path
    .split("/")
    .map(function (str) {
      if (coinFlip()) str = str + "/";

      if (coinFlip()) str = "/" + str;

      return str;
    })
    .join("/");
  return path;
}

function coinFlip() {
  return Math.random() > 0.5;
}

function randomizeCase(str) {
  return str
    .split("/")
    .map(function (s) {
      for (var i = 0; i < s.length; i++) {
        if (Math.random() > 0.5) {
          s = s.split(s[i]).join(s[i].toLowerCase());
        } else {
          s = s.split(s[i]).join(s[i].toUpperCase());
        }
      }
      return s;
    })
    .join("/");
}
