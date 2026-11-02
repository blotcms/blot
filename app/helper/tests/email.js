describe("email templates", function () {
  const fs = require("fs");
  const path = require("path");
  const Mustache = require("mustache");
  const { marked } = require("marked");

  const root = path.join(__dirname, "../email");
  const templates = ["admin", "user", "newsletters"].flatMap((dir) =>
    fs.existsSync(path.join(root, dir))
      ? fs
          .readdirSync(path.join(root, dir))
          .filter((name) => name.endsWith(".txt"))
          .map((name) => path.join(dir, name))
      : []
  );

  // A double-stache variable, e.g. {{event}}, but not {{{event}}} or a
  // section tag such as {{#urgent}}, {{^singular}} or {{/urgent}}
  const ESCAPED_VARIABLE = /(?<!\{)\{\{\s*[a-zA-Z.][\w.]*\s*\}\}(?!\})/;

  it("has templates to check", function () {
    expect(templates.length).toBeGreaterThan(0);
  });

  // See app/helper/email/README.md: the subject is plain text and marked
  // escapes code itself, so an HTML-escaped value shows up as &#x3D; there
  templates.forEach((template) => {
    it(template + " uses {{{triple}}} in its subject and code", function () {
      const lines = fs.readFileSync(path.join(root, template), "utf-8").split("\n");
      const subject = lines[0];
      const code = (lines.slice(2).join("\n").match(/```[\s\S]*?```|`[^`\n]*`/g) || []).filter(
        (span) => ESCAPED_VARIABLE.test(span)
      );

      expect(ESCAPED_VARIABLE.test(subject))
        .withContext("subject: " + subject)
        .toBe(false);
      expect(code).toEqual([]);
    });
  });

  it("renders SERVER_START without escaping the event", function () {
    const text = fs.readFileSync(path.join(root, "admin/SERVER_START.txt"), "utf-8");
    const lines = text.split("\n");
    const locals = {
      container: "blue/node-b",
      event: "restarted (Exited pid=153 code=null signal=SIGKILL)"
    };

    expect(Mustache.render(lines[0], locals)).toBe(
      "blue/node-b server restarted (Exited pid=153 code=null signal=SIGKILL)"
    );
    expect(marked.parse(Mustache.render(lines.slice(2).join("\n"), locals))).toContain(
      "logs blue/node-b | grep"
    );
  });
});
