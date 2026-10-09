const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const config = require("config");
const { container } = require("../build/locals");

// Git pushes can be hundreds of MB over a slow connection, so /clients/git/end/
// gets longer body limits than the rest of /clients. nginx refuses a location
// which sets client_max_body_size twice, so check the rendered config rather
// than the template.
describe("proxy git push limits", function () {
  const directory = path.join(__dirname, "../config");
  const partials = {};

  fs.readdirSync(directory)
    .filter((file) => file.endsWith(".conf"))
    .forEach((file) => {
      partials[file] = fs.readFileSync(path.join(directory, file), "utf8");
    });

  const rendered = mustache.render(
    "{{> blot-site.conf}}",
    container({ env: {}, config }),
    partials
  );

  // The text of a top-level location block in blot-site.conf
  function location(prefix) {
    const start = rendered.indexOf("\nlocation " + prefix + " {");
    expect(start).not.toBe(-1);
    return rendered.slice(start, rendered.indexOf("\n}", start));
  }

  function occurrences(block, directive) {
    return block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(directive + " "));
  }

  it("raises the body timeout and size for git requests only", function () {
    const git = location("/clients/git/end/");

    expect(occurrences(git, "client_body_timeout")).toEqual([
      "client_body_timeout 60s;",
    ]);
    expect(occurrences(git, "client_max_body_size")).toEqual([
      "client_max_body_size 2000M;",
    ]);
  });

  it("uses the same upstream and transfer settings as /clients", function () {
    const git = location("/clients/git/end/");
    const clients = location("/clients");

    expect(git).toMatch(/set \$upstream_server blot_node;/);
    expect(clients).toMatch(/set \$upstream_server blot_node;/);

    [
      "proxy_pass",
      "proxy_read_timeout",
      "proxy_send_timeout",
      "limit_rate",
      "proxy_buffering",
      "proxy_request_buffering",
    ].forEach((directive) => {
      expect(occurrences(git, directive).length).toBe(1);
      expect(occurrences(git, directive)).toEqual(
        occurrences(clients, directive)
      );
    });
  });

  it("leaves /clients and the other huge locations at 1000M", function () {
    ["/clients", "/dashboard", "/sites"].forEach((prefix) => {
      const block = location(prefix);

      expect(occurrences(block, "client_max_body_size")).toEqual([
        "client_max_body_size 1000M;",
      ]);
      expect(occurrences(block, "client_body_timeout")).toEqual([]);
    });
  });

  it("sets no directive twice in any location", function () {
    const locations = rendered.split(/\nlocation /).slice(1);

    locations.forEach((block) => {
      const body = block.slice(0, block.indexOf("\n}"));

      [
        "client_max_body_size",
        "client_body_timeout",
        "proxy_read_timeout",
      ].forEach((directive) => {
        expect(occurrences(body, directive).length).toBeLessThan(2);
      });
    });
  });

  it("is not shadowed by a regex location", function () {
    // A regex location beats a prefix location, so none may match git requests
    const lines = rendered.match(/\nlocation ~\*? [^\n]*/g);

    lines.forEach((line) => {
      const pattern = line
        .replace(/^\nlocation ~\*? /, "")
        .replace(/ \{$/, "");
      const url = "/clients/git/end/example.git/git-receive-pack";

      expect(new RegExp(pattern, "i").test(url)).toBe(false);
    });
  });
});
