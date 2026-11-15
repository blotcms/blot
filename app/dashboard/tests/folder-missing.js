describe("dashboard folder viewer, missing path", function () {
  global.test.site({ login: true });

  it("answers 404 for a path that is not in the folder", async function () {
    const res = await this.fetch(
      `/sites/${this.blog.handle}/folder/no/such/path`
    );

    expect(res.status).toBe(404);
  });

  it("still shows a path that exists", async function () {
    await this.write({ path: "/real/file.txt", content: "hello" });

    const res = await this.fetch(`/sites/${this.blog.handle}/folder/real`);

    expect(res.status).toBe(200);
  });
});
