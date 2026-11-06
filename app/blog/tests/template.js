const fs = require("fs-extra");

describe("template engine", function () {
  require("./util/setup")();

  it("lists entries in reverse chronological", async function () {
    await this.write({ path: "/first.txt", content: "Foo" });
    await this.write({ path: "/second.txt", content: "Bar" });

    await this.template({
      "entries.html":
        "{{#entries}}<p><a href='{{{url}}}'>{{title}}</a></p>{{/entries}}",
    });

    const res = await this.get(`/`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "<p><a href='/second'>second</a></p><p><a href='/first'>first</a></p>"
    );
  });

  it("renders a list of posts with a given tag", async function () {
    await this.write({ path: "/[Foo]/first.txt", content: "Foo" });
    await this.write({ path: "/[Foo]/second.txt", content: "Bar" });

    await this.template({
      "tagged.html":
        "{{#tagged}}{{#entries}}<p><a href='{{{url}}}'>{{title}}</a></p>{{/entries}}{{/tagged}}",
    });

    const res = await this.get(`/tagged/foo`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "<p><a href='/second'>second</a></p><p><a href='/first'>first</a></p>"
    );
  });

  it("augments entry.next and entry.previous", async function () {
    await this.write({ path: "/first.txt", content: "Link: first\n\nFoo" });
    await this.write({
      path: "/second.txt",
      content: "Tags: foo\nLink: second\n\nSecond",
    });

    await this.template({
      "entry.html": `
        {{#entry}}
          {{{html}}} 
          {{^next.tagged.foo}}
          {{#next}}
          <p>Next: <a href='{{{url}}}'>{{title}}</a></p>
          {{/next}}
          {{/next.tagged.foo}}
        {{/entry}}
      `,
    });

    const res = await this.get(`/first`);

    expect(await res.text()).not.toContain("<a href='/second'>");
  });

  it("embeds the HTML for a given post as a partial template, including lowercase", async function () {
    await this.write({ path: "/hello.txt", content: "Foo" });

    // We're interested in testing lowercase because the Dropbox client
    // stores all files in lowercase.
    await this.template({
      "entries.html": "{{> /Hello.txt}} {{> /hello.txt}}",
    });

    const res = await this.get(`/`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "<p>foo</p><p>foo</p>"
    );
  });

  it("exposes the url query to the template view", async function () {
    await this.template({
      "foo.html": `{{request.query.bar}}`,
    });

    const res = await this.get(`/foo.html?bar=baz`);

    expect(await res.text()).toEqual("baz");
  });

  it("renders the query object", async function () {
    // this previously triggered a bug with the template engine
    await this.template({
      "foo.html": "{{query.bar}}",
    });

    const res1 = await this.get(`/foo.html?bar=baz`);

    expect((await res1.text()).trim()).toEqual("baz");
  });

  it("does not render templates with infinitely nested partials", async function () {
    await this.template(
      {
        "entries.html": "{{> first}}",
      },
      {
        views: {
          "entries.html": {
            partials: {
              first: "{{> second}}",
              second: "{{> first}}",
            },
          },
        },
      }
    );

    const res = await this.get(`/`);
    const body = await res.text();

    expect(res.status).toEqual(400);
    expect(body).toContain("Error with your template");
  });

  it("does not render templates when views include each other infinitely", async function () {
    await this.template({
      "entries.html": "{{> header.html}}",
      "header.html": "STALE",
    });

    expect(await this.text(`/`)).toBe("STALE");

    await this.template({
      "header.html": "{{> entries.html}}",
    });

    const res = await this.fetch(`/`);
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).toContain("Error with your template");
  });

  it("does not render the contents of an thumbnail block for posts without thumbnails", async function () {
    await this.write({
      path: "/hello.txt",
      content: "Hello",
    });

    await this.template({
      "entries.html":
        "{{#entries}}SHOULD {{#thumbnail}} NOT{{/thumbnail}}RENDER{{/entries}}",
    });

    const res = await this.get(`/`);

    expect((await res.text()).trim()).toEqual("SHOULD RENDER");
  });

  it("exposes exif data to the template view", async function () {
    // {
    //     ImageDescription: "                               ",
    //     Make: "NIKON",
    //     Model: "COOLPIX P6000",
    //     ExposureTime: "1/178",
    //     FNumber: 4.5,
    //     ISO: 64,
    //     Flash: "Off, Did not fire",
    //     FocalLength: 6,
    //   }
    await this.write({
      path: "/image.jpg",
      content: fs.readFileSync(
        require("path").join(
          __dirname,
          "/../../build/converters/img/tests/gps.jpg"
        )
      ),
    });

    await this.template({
      "entries.html":
        "{{#entries}}{{#exif}}{{Make}} {{Model}} {{ExposureTime}} {{FNumber}} {{ISO}} {{Flash}} {{FocalLength}} {{/exif}}{{/entries}}",
    });

    const res = await this.get(`/`);

    expect((await res.text()).trim()).toEqual(
      "NIKON COOLPIX P6000 1&#x2F;178 4.5 64 Off, Did not fire 6"
    );
  });

  it("does not render the contents of an exif block for posts without exif data", async function () {
    await this.write({
      path: "/hello.txt",
      content: "Hello",
    });

    await this.template({
      "entries.html":
        "{{#entries}}SHOULD {{#exif}} NOT{{/exif}}RENDER{{/entries}}",
    });

    const res = await this.get(`/`);

    expect((await res.text()).trim()).toEqual("SHOULD RENDER");
  });
});
