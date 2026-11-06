describe("verify-domain-setup", function () {
  require("./util/setup")();

  it("returns the handle of the blog", async function () {
    const res = await this.get("/verify/domain-setup");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toEqual(this.blog.handle);
  });
});
