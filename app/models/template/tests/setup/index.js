var create = require("models/template/index").create;
var getTemplateList = require("models/template/index").getTemplateList;
var setView = require("models/template/index").setView;
var dropView = require("models/template/index").dropView;
var getViewByURL = require("models/template/index").getViewByURL;
var build = require("build");
var Entry = require("models/entry");
var folder = require("storage/folder");

module.exports = function setup(options) {
  options = options || {};

  // Build the templates into Redis
  global.test.templates();

  // Create test blog before each test and remove it after
  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;

    // Write a file into the test blog folder and build it into an entry, so
    // specs can exercise file-backed template partials (e.g. {{> /pages/home.txt}}).
    this.set = async (path, contents) => {
      await folder.write(this.blog.id, path, contents);

      const entry = await build(this.blog, path);
      await Entry.set(this.blog.id, path, entry);
      return Entry.get(this.blog.id, path);
    };
  });

  // Create a test template
  if (options.createTemplate) {
    beforeEach(async function () {
      var test = this;
      var name = "template";
      await create(test.blog.id, name, {});
      var templates = await getTemplateList(test.blog.id);
      test.template = templates.filter(function (template) {
        return template.name === name && template.owner === test.blog.id;
      })[0];
    });

    beforeEach(function () {
      this.setView = (view) => setView(this.template.id, view);

      this.dropView = (view) => dropView(this.template.id, view);

      this.getViewByURL = (url) => getViewByURL(this.template.id, url);
    });
  }

  // Create a test view
  if (options.createView) {
    beforeEach(async function () {
      var test = this;
      var view = {
        name: "index.html",
        url: "/index",
        content: "<h1>Index page</h1>",
      };
      await setView(test.template.id, view);
      test.view = view;
    });
  }
};
