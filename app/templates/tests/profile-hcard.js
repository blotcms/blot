const fs = require("fs");
const path = require("path");
const mustache = require("mustache");

describe("profile homepage h-card", function () {
  const template = fs.readFileSync(
    path.join(__dirname, "../source/profile/entries.html"),
    "utf8"
  );

  const partials = {
    title: "{{title}}",
    navigation: "",
    footer: "",
    "post-list": "",
  };

  function render(view) {
    return mustache.render(template, view, partials);
  }

  function hcard(html) {
    const match = html.match(/<header class="h-card">([\s\S]*?)<\/header>/);
    expect(match).not.toBeNull();
    return match[1];
  }

  it("omits the avatar image when avatar is missing", function () {
    const html = hcard(render({ title: "David", description: "Writer" }));
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/src=""/);
  });

  it("omits the avatar image when avatar is empty", function () {
    const html = hcard(
      render({ title: "David", description: "Writer", avatar: "" })
    );
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/src=""/);
  });

  it("keeps an h-card u-url when avatar is missing", function () {
    const html = hcard(render({ title: "David", description: "Writer" }));
    expect(html).toMatch(/<a class="u-url" href="\/" rel="me">David<\/a>/);
  });

  it("renders the avatar and u-url when avatar is present", function () {
    const html = hcard(
      render({
        title: "David",
        description: "Writer",
        avatar: "/avatar.jpg",
      })
    );
    expect(html).toMatch(/id="avatar"/);
    expect(html).toMatch(/class="u-photo"/);
    expect(html).toMatch(/src="\/avatar.jpg"/);
    expect(html).toMatch(/<a class="u-url" href="\/" rel="me">David<\/a>/);
  });
});
