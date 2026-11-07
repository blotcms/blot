describe("template", function () {
  require("./setup")({ createTemplate: true });

  var isOwner = require("../index").isOwner;

  it("exposes an isOwner method which checks who owns a template", async function () {
    var res = await isOwner(this.blog.id, this.template.id);
    expect(res).toBeTruthy();
  });

  it("exposes an isOwner method which checks who owns a template", async function () {
    var res = await isOwner(this.blog.id, "nonexistent:template");
    expect(res).toBeFalsy();
  });

  it("returns a promise when called without a callback", async function () {
    expect(await isOwner(this.blog.id, this.template.id)).toBe(true);
    expect(await isOwner(this.blog.id, "nonexistent:template")).toBe(false);
  });
});
