describe("models/404", function () {
  const fourOhFour = require("models/404");

  global.test.blog();

  it("lists a recorded 404 as active until it is ignored", async function () {
    await fourOhFour.set(this.blog.id, "/missing");

    let { list, ignored } = await fourOhFour.list(this.blog.id);
    expect(list.map((item) => item.url)).toEqual(["/missing"]);
    expect(ignored).toEqual([]);

    await fourOhFour.ignore(this.blog.id, "/missing");

    ({ list, ignored } = await fourOhFour.list(this.blog.id));
    expect(list).toEqual([]);
    expect(ignored.map((item) => item.url)).toEqual(["/missing"]);
  });

  it("lists the most recent 404 first", async function () {
    await fourOhFour.set(this.blog.id, "/first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fourOhFour.set(this.blog.id, "/second");

    const { list } = await fourOhFour.list(this.blog.id);
    expect(list.map((item) => item.url)).toEqual(["/second", "/first"]);
  });
});
