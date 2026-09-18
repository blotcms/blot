// A Unicode Private Use Area character used to mark a hard line break
// (see loosenDisplayMath.js) that was inserted purely to isolate display
// math on its own line, so the katex plugin can tell it apart from a <br>
// that was actually present in the author's content (see
// build/plugins/katex/index.js). It's never legitimate user content, and is
// always stripped from the rendered output.
module.exports = "";
