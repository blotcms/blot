const mustache = require("mustache");
const load = require("./load");
const loadPartials = require("./loadPartials");
const cheerio = require("cheerio");

const CACHE = {};

const render = async function (filePath, options, callback) {
  // if you call render('index') then 'this' is:
  // {
  //   defaultEngine: 'html',
  //   ext: '.html',
  //   name: 'index',
  //   root: '/express-mustache/tests/data',
  //   engine: [AsyncFunction: render],
  //   path: '/express-mustache/tests/data/index.html'
  // }
  // root === options.settings.views
  // filePath === /express-mustache/tests/data/index.html
  // and options is:
  // {
  //   settings: {
  //     'x-powered-by': true,
  //     .. express settings
  //   },
  //   .. your locals
  //   cache: false
  // }
  const { ext, name, root, path } = this;

  // options.cache seems to default to false
  // unless environment variable NODE_ENV=production
  const cache = options.cache === true ? CACHE : null;

  try {
    const layout = options.layout || options.settings.layout;
    const partials = await loadPartials(root, options, ext, cache);

    partials.body = layout
      ? await load(filePath, ext, root, cache)
      : partials.body;

    const templatePath = layout ? layout : filePath;
    const template = await load(templatePath, ext, root, cache);

    let result = mustache.render(template, options, partials);

    const transformers = [
      ...(options.settings.transformers || []),
      ...(options.transformers || [])
    ].filter(i => typeof i === "function");

    if (transformers.length) {
      const $ = cheerio.load(result, { decodeEntities: false }, false);
      for (const transformer of transformers) {
        transformer($);
      }
      result = $.html();
    }

    return callback(null, result);
  } catch (err) {
    // if (err.message.indexOf(" at ") > -1) {
    //   const index = parseInt(err.message.split(" ").pop());
    // }

    const error = new Error(
      "Error rendering " +
        filePath.slice(options.settings.views.length) +
        ": " +
        err.message
    );
    return callback(error);
  }
};

module.exports = render;
