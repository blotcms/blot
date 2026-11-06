describe("template engine", function () {
  require("./util/setup")();

  it("renders the archives page", async function () {
    await this.write({ path: "/first.txt", content: "Foo" });

    await this.template(
      {
        "archives.html":
          "{{#archives}}{{#months}}{{#entries}}<p><a href='{{{url}}}'>{{title}}</a></p>{{/entries}}{{/months}}{{/archives}}",
      },
      {
        views: {
          "archives.html": {
            url: "/archives",
          },
        },
      }
    );

    const res = await this.get(`/archives`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "<p><a href='/first'>first</a></p>"
    );
  });
});
