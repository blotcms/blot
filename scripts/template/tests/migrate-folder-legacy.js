describe("scripts/template/migrate-folder-legacy", function () {
  const {
    rewriteFolderTags,
    rewritePartials,
    migrateTemplate,
  } = require("../migrate-folder-legacy");

  function rewrite(source) {
    return rewriteFolderTags(source).content;
  }

  describe("rewriteFolderTags", function () {
    it("rewrites every form of a tag naming folder", function () {
      expect(rewrite("{{folder}}")).toEqual("{{folder_legacy}}");
      expect(rewrite("{{{folder}}}")).toEqual("{{{folder_legacy}}}");
      expect(rewrite("{{& folder}}")).toEqual("{{& folder_legacy}}");
      expect(rewrite("{{#folder}}x{{/folder}}")).toEqual(
        "{{#folder_legacy}}x{{/folder_legacy}}"
      );
      expect(rewrite("{{^folder}}none{{/folder}}")).toEqual(
        "{{^folder_legacy}}none{{/folder_legacy}}"
      );
      expect(
        rewrite("{{#folder.contents}}{{name}}{{/folder.contents}}")
      ).toEqual(
        "{{#folder_legacy.contents}}{{name}}{{/folder_legacy.contents}}"
      );
      expect(rewrite("{{folder.path}}")).toEqual("{{folder_legacy.path}}");
    });

    it("keeps the whitespace inside tags", function () {
      expect(rewrite("{{# folder }}x{{/ folder }}")).toEqual(
        "{{# folder_legacy }}x{{/ folder_legacy }}"
      );
      expect(rewrite("{{  folder  }}")).toEqual("{{  folder_legacy  }}");
      expect(rewrite("{{{ folder }}}")).toEqual("{{{ folder_legacy }}}");
      expect(rewrite("{{ & folder }}")).toEqual("{{ & folder_legacy }}");
      expect(rewrite("{{#\tfolder\n}}x{{/\n folder\t}}")).toEqual(
        "{{#\tfolder_legacy\n}}x{{/\n folder_legacy\t}}"
      );
    });

    it("leaves keys that merely contain the word alone", function () {
      const source = [
        "{{folder_name}}",
        "{{#entry.folder}}{{/entry.folder}}",
        "{{#folders}}{{/folders}}",
        "{{my_folder}}",
        "{{folder_legacy}}",
        "{{{folderx}}}",
        "{{entry.folder.name}}",
      ].join("\n");

      const result = rewriteFolderTags(source);

      expect(result.content).toEqual(source);
      expect(result.changes).toEqual([]);
    });

    it("leaves text, comments and partials outside tags alone", function () {
      const source =
        'folder {{! folder }} <a href="/folder">folder</a> {{> folder}} {{!folder}}';

      expect(rewrite(source)).toEqual(source);
    });

    it("handles a custom delimiter, and changing back", function () {
      expect(
        rewrite(
          "{{=<% %>=}}<%#folder%>x<%/folder%> {{folder}} <%={{ }}=%>{{folder}}"
        )
      ).toEqual(
        "{{=<% %>=}}<%#folder_legacy%>x<%/folder_legacy%> {{folder}} <%={{ }}=%>{{folder_legacy}}"
      );
      expect(rewrite("{{=[[ ]]=}}[[ # folder ]]x[[ / folder ]]")).toEqual(
        "{{=[[ ]]=}}[[ # folder_legacy ]]x[[ / folder_legacy ]]"
      );
    });

    it("rewrites nested and repeated sections, closing tags included", function () {
      const source =
        "{{#folder}}{{#contents}}{{#folder}}{{name}}{{/folder}}{{/contents}}{{/folder}}";

      expect(rewrite(source)).toEqual(
        "{{#folder_legacy}}{{#contents}}{{#folder_legacy}}{{name}}{{/folder_legacy}}{{/contents}}{{/folder_legacy}}"
      );
    });

    it("keeps surrounding text and line breaks exactly", function () {
      const source =
        "<ul>\r\n  {{#folder}}\r\n  <li>{{name}}</li>\r\n  {{/folder}}\r\n</ul>\n{{folder}}";

      expect(rewrite(source)).toEqual(
        "<ul>\r\n  {{#folder_legacy}}\r\n  <li>{{name}}</li>\r\n  {{/folder_legacy}}\r\n</ul>\n{{folder_legacy}}"
      );
    });

    it("reports each tag with its line and the sections it sits in", function () {
      const result = rewriteFolderTags(
        "a\n{{#folder}}\n{{#entry}}{{folder}}{{/entry}}\n{{/folder}}"
      );

      expect(result.changes).toEqual([
        {
          line: 2,
          before: "{{#folder}}",
          after: "{{#folder_legacy}}",
          inside: [],
        },
        {
          line: 3,
          before: "{{folder}}",
          after: "{{folder_legacy}}",
          inside: ["folder", "entry"],
        },
        {
          line: 4,
          before: "{{/folder}}",
          after: "{{/folder_legacy}}",
          inside: [],
        },
      ]);
    });

    it("is idempotent", function () {
      const once = rewrite("{{#folder}}{{name}}{{/folder}}{{folder.x}}");

      expect(rewrite(once)).toEqual(once);
      expect(rewriteFolderTags(once).changes).toEqual([]);
    });

    it("throws on a template Mustache cannot parse", function () {
      expect(() => rewriteFolderTags("{{#folder}}")).toThrow();
    });

    it("handles an empty template", function () {
      expect(rewriteFolderTags("").content).toEqual("");
    });
  });

  describe("rewritePartials", function () {
    it("rewrites string partials and nested ones, and leaves null markers", function () {
      const partials = {
        "/file.txt": null,
        a: "{{#folder}}x{{/folder}}",
        b: { content: "{{folder}}", partials: { c: "{{folder.y}}" } },
        d: "{{folder_name}}",
      };
      const result = rewritePartials(partials);

      expect(result.partials).toEqual({
        "/file.txt": null,
        a: "{{#folder_legacy}}x{{/folder_legacy}}",
        b: {
          content: "{{folder_legacy}}",
          partials: { c: "{{folder_legacy.y}}" },
        },
        d: "{{folder_name}}",
      });
      expect(result.changes.map((change) => change.partial)).toEqual([
        "a",
        "a",
        "b",
        "b > c",
      ]);
      // the input is not changed
      expect(partials.a).toEqual("{{#folder}}x{{/folder}}");
    });

    it("handles no partials", function () {
      expect(rewritePartials(undefined)).toEqual({
        partials: {},
        changes: [],
      });
    });
  });

  describe("migrateTemplate", function () {
    const Template = require("models/template");
    const folder = require("storage/folder");
    require("clients");

    require("models/template/tests/setup")({ createTemplate: true });

    afterEach(async function () {
      await folder.remove(this.blog.id, "/Templates");
      await folder.remove(this.blog.id, "/templates");
    });

    async function listing(test) {
      const list = await Template.getTemplateList(test.blog.id);
      return list.find((template) => template.id === test.template.id);
    }

    it("moves a view to folder_legacy through the model and keeps its other fields", async function () {
      await Template.setView(this.template.id, {
        name: "feed.rss",
        url: "/feed.rss",
        locals: { color: "red" },
        content:
          "<root>{{#folder}}{{#contents}}{{name}}{{/contents}}{{/folder}}{{title}}</root>",
      });
      await Template.setView(this.template.id, {
        name: "other.html",
        content: "{{#folder_name}}{{/folder_name}}",
      });

      const before = await Template.getView(this.template.id, "feed.rss");
      expect(before.retrieve.folder).toBeDefined();

      const result = await migrateTemplate(this.blog, await listing(this), {
        apply: true,
      });

      expect(result.failures).toEqual([]);
      expect(result.changed).toEqual(1);

      const after = await Template.getView(this.template.id, "feed.rss");

      expect(after.content).toEqual(
        "<root>{{#folder_legacy}}{{#contents}}{{name}}{{/contents}}{{/folder_legacy}}{{title}}</root>"
      );
      expect(after.retrieve.folder).toBeUndefined();
      expect(after.retrieve.folder_legacy).toBeDefined();
      expect(after.url).toEqual("/feed.rss");
      expect(after.locals).toEqual({ color: "red" });
      expect((await this.getViewByURL("/feed.rss")).viewName).toEqual(
        "feed.rss"
      );

      const untouched = await Template.getView(this.template.id, "other.html");
      expect(untouched.content).toEqual("{{#folder_name}}{{/folder_name}}");
    });

    it("changes nothing in a dry run, and nothing on a second run", async function () {
      const original = "{{#folder}}{{name}}{{/folder}}";

      await Template.setView(this.template.id, {
        name: "list.js",
        content: original,
      });

      const dry = await migrateTemplate(this.blog, await listing(this), {
        apply: false,
      });

      expect(dry.changed).toEqual(1);
      expect(
        (await Template.getView(this.template.id, "list.js")).content
      ).toEqual(original);

      await migrateTemplate(this.blog, await listing(this), { apply: true });
      const again = await migrateTemplate(this.blog, await listing(this), {
        apply: true,
      });

      expect(again.changed).toEqual(0);
      expect(again.failures).toEqual([]);
    });

    it("rewrites a locally edited template's folder files too", async function () {
      const dir = "/Templates/local";
      const content = "{{#folder}}{{name}}{{/folder}}";

      await folder.write(this.blog.id, dir + "/list.js", content);
      await Template.readFromFolder(this.blog.id, dir);

      const template = (await Template.getTemplateList(this.blog.id)).find(
        (item) => item.slug === "local"
      );

      expect(template.localEditing).toEqual(true);

      const result = await migrateTemplate(this.blog, template, {
        apply: true,
      });

      expect(result.failures).toEqual([]);

      const expected = "{{#folder_legacy}}{{name}}{{/folder_legacy}}";

      expect(
        (await folder.read(this.blog.id, dir + "/list.js")).toString()
      ).toEqual(expected);

      const view = await Template.getView(template.id, "list.js");
      expect(view.content).toEqual(expected);
      expect(view.retrieve.folder).toBeUndefined();

      // a sync rebuilds the template from the folder, and keeps the change
      await Template.readFromFolder(this.blog.id, dir);
      const rebuilt = await Template.getView(template.id, "list.js");
      expect(rebuilt.content).toEqual(expected);
      expect(rebuilt.retrieve.folder).toBeUndefined();
    });
  });
});
