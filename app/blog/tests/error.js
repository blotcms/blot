describe("errors", function () {
  const config = require("config");
  const { set } = require("models/redirects");
  const promisify = require("util").promisify;

  const setRedirects = promisify(set);

  require("./util/setup")();

  it("redirects when a redirect is set", async function () {
    await setRedirects(this.blog.id, [{ from: "/redirect", to: "/" }]);

    const res = await this.get("/redirect", { redirect: "manual" });
    const body = await res.text();
    const location = res.headers.get("location");
    expect(res.status).toEqual(301);
    expect(body).toContain("Redirecting to /");
    expect(location).toEqual("/");
  });

  it("returns a nice error when the template does not exist", async function () {
    await this.blog.update({ template: "INVALID" });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(404);
    // todo: improve this error message
    expect(body).toContain("Cannot GET /");
  });

  it("returns a nice error when the blog has no template", async function () {
    await this.blog.update({ template: "" });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(404);
    // todo: improve this error message
    expect(body).toContain("Cannot GET /");
  });

  it("returns a nice error when the template has an issue and the request is on a preview domain", async function () {
    await this.template({
      "entries.html": "{{#unclosed}}tag",
    });

    const res = await this.fetch(
      config.protocol +
        "preview-of-my-local-on-" +
        this.blog.handle +
        "." +
        config.host
    );
    const body = await res.text();

    expect(res.status).toEqual(400);
    // todo: improve this error message
    expect(body).toContain("Error with your template");
    expect(body).toContain("unclosed");

    const mainRes = await this.get("/");
    const mainBody = await mainRes.text();

    expect(mainRes.status).toEqual(400);
    expect(mainBody).not.toContain("unclosed");
  });
});
