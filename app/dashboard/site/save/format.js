var Blog = require("models/blog");
var formJSON = require("helper/formJSON");
var extend = require("helper/extend");
var normalizeImageExif = require("models/blog/util/imageExif").normalize;
var normalizeConverters = require("models/blog/util/converters").normalize;

var WRITEABLE_SCHEME = {};

for (var i of Blog.scheme.WRITEABLE) {
  WRITEABLE_SCHEME[i] = Blog.scheme.TYPE[i];
}

function normalizeBooleanOption(value) {
  if (value === null || value === undefined || value === false || value === 0)
    return false;

  if (value === true || value === 1) return true;

  if (typeof value === "string") {
    var normalized = value.trim().toLowerCase();

    if (
      normalized === "" ||
      normalized === "false" ||
      normalized === "off" ||
      normalized === "0"
    )
      return false;

    if (normalized === "true" || normalized === "on" || normalized === "1")
      return true;
  }

  return Boolean(value);
}

const VALID_LINK_CARD_LAYOUTS = ["compact", "large"];

function normalizeLinkCardLayout(value) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (VALID_LINK_CARD_LAYOUTS.indexOf(normalized) > -1) {
      return normalized;
    }
  }

  return "compact";
}

function normalizeLinkCardOptions(linkCards, options) {
  if (!linkCards) return;

  if (!linkCards.options) linkCards.options = {};

  const shouldDefaultToCompact = Boolean(
    options &&
      options.defaultLayout &&
      linkCards.enabled &&
      !linkCards.options.layout
  );

  if (shouldDefaultToCompact) {
    linkCards.options.layout = "compact";
  }

  const layout = normalizeLinkCardLayout(linkCards.options.layout);

  linkCards.options.layout = layout;
  linkCards.options.layoutCompact = layout === "compact";
  linkCards.options.layoutLarge = layout === "large";
}

module.exports = function (req, res, next) {
  try {
    req.updates = formJSON(req.body, WRITEABLE_SCHEME);
  } catch (e) {
    return next(e);
  }

  if (req.body.hasMenu) {
    req.updates.menu = req.updates.menu || [];

    for (var i in req.updates.menu) {
      for (var x in req.blog.menu) {
        if (req.blog.menu[x].id === req.updates.menu[i].id) {
          extend(req.updates.menu[i]).and(req.blog.menu[x]);
        }
      }

      let linkURL = req.updates.menu[i].url;

      // Turns 'wikipedia.org/david' into 'https://wikipedia.org/david'
      if (
        linkURL.indexOf("/") > -1 &&
        !linkURL.startsWith("/") &&
        !linkURL.startsWith("http://") &&
        !linkURL.startsWith("https://") &&
        linkURL.slice(0, linkURL.indexOf("/")).indexOf('.') > -1        
      ) {
        req.updates.menu[i].url = "https://" + req.updates.menu[i].url;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.updates, "imageExif")) {
    req.updates.imageExif = normalizeImageExif(req.updates.imageExif, {
      fallback: req.blog && req.blog.imageExif ? req.blog.imageExif : "off",
    });
  }


  if (Object.prototype.hasOwnProperty.call(req.updates, "converters")) {
    var converterUpdates = req.updates.converters;

    if (
      converterUpdates &&
      typeof converterUpdates.img === "object" &&
      Object.prototype.hasOwnProperty.call(converterUpdates.img, "enabled")
    ) {
      converterUpdates.img = converterUpdates.img.enabled;
    }

    req.updates.converters = normalizeConverters(converterUpdates, {
      fallback: req.blog && req.blog.converters ? req.blog.converters : undefined,
    });

    extend(req.updates.converters).and(req.blog.converters || {});
  }


  if (req.updates.plugins) {
    // this bullshit below is because I haven't properly declared
    // the model for blog.plugins so formJSON needs a little help...
    for (var i in req.updates.plugins) {
      req.updates.plugins[i].enabled = normalizeBooleanOption(
        req.updates.plugins[i].enabled
      );
      if (!req.updates.plugins[i].options) req.updates.plugins[i].options = {};
    }

    if (req.updates.plugins.typeset) {
      for (var x in req.updates.plugins.typeset.options)
        req.updates.plugins.typeset.options[x] = normalizeBooleanOption(
          req.updates.plugins.typeset.options[x]
        );
    }

    extend(req.updates.plugins).and(req.blog.plugins);

    if (req.updates.plugins.linkCards) {
      normalizeLinkCardOptions(req.updates.plugins.linkCards, {
        defaultLayout: true,
      });
    }

    // We mpdify the analytics settings after the extend function because
    // the extend function will not overwrite existing conflicting providers
    // it'll produce {Google: 'selected', Clicky: 'selected'}...
    if (
      req.updates.plugins.analytics &&
      req.updates.plugins.analytics.options.provider
    ) {
      var provider = {};
      provider[req.updates.plugins.analytics.options.provider] = "selected";
      req.updates.plugins.analytics.options.provider = provider;
    }
  }
  next();
};
