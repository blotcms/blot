describe("linebreaks plugin", function () {
  require("./util/setup")();

  beforeEach(function () {
    this.blog.plugins.linebreaks = { enabled: true, options: {} };
  });

  // I'm not sure why we need to reset this but it's neccessary
  // we should be creating a new blog object for each test but
  // this appears to not be the case
  afterEach(function () {
    this.blog.plugins.linebreaks = { enabled: false, options: {} };
  });

  it("will preserve linebreaks if enabled", async function () {
    const contents = "A line\nwith a break";
    const path = "/hello.txt";
    const html = "<p>A line<br>\nwith a break</p>";

    await this.buildAndCheck({ path, contents }, { html });
  });
});
