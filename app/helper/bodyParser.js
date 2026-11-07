// body-parser 2 leaves req.body undefined when a request has no body of the
// type the parser handles, where body-parser 1 (and Express 4) left it as {}.
// Handlers read req.body.x, so every parser in Blot goes through here, which
// keeps req.body as {}.
//
// Every option body-parser 1.20 defaulted is set explicitly below, so the
// parsing doesn't change with body-parser's defaults. Callers override what
// they need (limit, type, parameterLimit).
const parsers = require("body-parser");

const DEFAULTS = {
  json: {
    inflate: true,
    limit: "100kb",
    strict: true,
    type: "application/json",
  },
  urlencoded: {
    extended: false,
    inflate: true,
    limit: "100kb",
    parameterLimit: 1000,
    type: "application/x-www-form-urlencoded",
  },
  raw: {
    inflate: true,
    limit: "100kb",
    type: "application/octet-stream",
  },
};

function wrap(parser) {
  return function bodyParser(req, res, next) {
    parser(req, res, function (err) {
      if (!err && req.body === undefined) req.body = {};
      next(err);
    });
  };
}

function create(kind) {
  return function (options) {
    return wrap(parsers[kind](Object.assign({}, DEFAULTS[kind], options)));
  };
}

module.exports = {
  json: create("json"),
  urlencoded: create("urlencoded"),
  raw: create("raw"),
};
