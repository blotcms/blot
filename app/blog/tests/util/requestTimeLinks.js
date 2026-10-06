// Specs for the request-time folder-link pass (app/blog/render/
// replaceFolderLinks) render templates whose views contain literal links to
// files in the blog's folder. When a view is saved, models/template/util/
// resolveFolderLinks wraps those literal links in {{#cdn}}, so the page would
// no longer reach the request-time pass with a literal link in it and the
// specs would be exercising the save-time path instead.
//
// Call this after setup() inside a describe block. It replaces this.template
// so that every view without Mustache of its own is served through a template
// local instead: the view becomes {{{local}}} and the markup is the local's
// value. resolveFolderLinks never reads a local, so the link only appears in
// the page once it has rendered, which is exactly what the request-time pass
// sees for markup that arrives at render time (an entry's html, a
// {{{variable}}}, a partial's output).
//
// Views containing Mustache are passed through untouched.
module.exports = function requestTimeLinks() {
  beforeEach(function () {
    const template = this.template;

    this.template = (views = {}, packageJSON = {}) => {
      const locals = { ...(packageJSON.locals || {}) };
      const routed = {};
      let index = 0;

      for (const viewName in views) {
        const content = views[viewName];

        if (typeof content !== "string" || content.indexOf("{{") > -1) {
          routed[viewName] = content;
          continue;
        }

        const local = "requestTimeView" + index++;

        locals[local] = content;
        routed[viewName] = "{{{" + local + "}}}";
      }

      return template(routed, { ...packageJSON, locals });
    };
  });
};
