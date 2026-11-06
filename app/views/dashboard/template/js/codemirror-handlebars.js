// Blot's Handlebars mode for CodeMirror 5. It is based on CodeMirror's own
// mode/handlebars/handlebars.js (MIT, https://codemirror.net/5/LICENSE) and
// adds triple-stache ({{{...}}}) tags, which Blot templates use for unescaped
// output. Load it instead of codemirror/mode/handlebars/handlebars.js.

const CodeMirror = require("codemirror");
require("codemirror/addon/mode/simple.js");
require("codemirror/addon/mode/multiplex.js");


CodeMirror.defineSimpleMode("handlebars-tags", {
  start: [
    { regex: /\{\{\{/, push: "handlebars_triple", token: "tag" },
    { regex: /\{\{!--/, push: "dash_comment", token: "comment" },
    { regex: /\{\{!/, push: "comment", token: "comment" },
    { regex: /\{\{/, push: "handlebars", token: "tag" },
  ],
  handlebars: [
    { regex: /\}\}/, pop: true, token: "tag" },

    // Double and single quotes
    { regex: /"(?:[^\\"]|\\.)*"?/, token: "string" },
    { regex: /'(?:[^\\']|\\.)*'?/, token: "string" },

    // Handlebars keywords
    { regex: />|[#/]([A-Za-z_]\w*)/, token: "keyword" },
    { regex: /(?:else|this)\b/, token: "keyword" },

    // Numeral
    { regex: /\d+/i, token: "number" },

    // Atoms like = and .
    { regex: /=|~|@|true|false/, token: "atom" },

    // Paths
    { regex: /(?:\.\.\/)*(?:[A-Za-z_][\w.]*)+/, token: "variable-2" },
  ],
  handlebars_triple: [
    { regex: /\}\}\}/, pop: true, token: "tag" },
    { regex: /"(?:[^\\"]|\\.)*"?/, token: "string" },
    { regex: /'(?:[^\\']|\\.)*'?/, token: "string" },
    { regex: />|[#/]([A-Za-z_]\w*)/, token: "keyword" },
    { regex: /(?:else|this)\b/, token: "keyword" },
    { regex: /\d+/i, token: "number" },
    { regex: /=|~|@|true|false/, token: "atom" },
    { regex: /(?:\.\.\/)*(?:[A-Za-z_][\w.]*)+/, token: "variable-2" },
  ],
  dash_comment: [
    { regex: /--\}\}/, pop: true, token: "comment" },

    // Commented code
    { regex: /./, token: "comment" },
  ],
  comment: [
    { regex: /\}\}/, pop: true, token: "comment" },
    { regex: /./, token: "comment" },
  ],
  meta: {
    blockCommentStart: "{{--",
    blockCommentEnd: "--}}",
  },
});

CodeMirror.defineMode("handlebars", function (config, parserConfig) {
  var inner = CodeMirror.getMode(config, "handlebars-tags");
  if (!parserConfig || !parserConfig.base) return inner;

  var base = CodeMirror.getMode(config, parserConfig.base);
  return CodeMirror.multiplexingMode(
    base,
    { open: "{{{", close: "}}}", mode: inner, parseDelimiters: true }, // triple first
    { open: "{{", close: "}}", mode: inner, parseDelimiters: true }
  );
});

