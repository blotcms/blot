var TYPES = {
    undefined: "undefined",
    number: "number",
    boolean: "boolean",
    string: "string",
    "[object AsyncFunction]": "function",
    "[object Function]": "function",
    "[object RegExp]": "regexp",
    "[object Array]": "array",
    "[object Date]": "date",
    "[object Error]": "error",
  },
  TOSTRING = Object.prototype.toString;

module.exports = function type(o, is) {
  if (is !== undefined) return type(o) === is;

  return TYPES[typeof o] || TYPES[TOSTRING.call(o)] || (o ? "object" : "null");
};
