// Maps 'Unclosed section "entriess" at 1446' to
// 'Unclosed section "entriess" at position 4 on line 12'
module.exports = function improveMustacheErrorMessage(err, contents) {
  try {
    const regex = /at (\d+)$/gm;
    const found = [...err.message.matchAll(regex)][0];
    const position = parseInt(found[1]);
    const messageWithoutLocation = err.message.slice(0, found.index).trim();
    const lines = contents.slice(0, position).split("\n");
    const lineNumber = lines.length;
    const linePosition = lines[lineNumber - 1].length;
    return `${messageWithoutLocation} at position ${linePosition} on line ${lineNumber}`;
  } catch (e) {
    // We could not rewrite the message, so report the original rather than
    // the failure to rewrite it
    return err.message;
  }
};
