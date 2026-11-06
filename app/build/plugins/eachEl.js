// This makes it easy to iterate over a
// cheerio element collection and perform
// some asynchronous task, a la forEach.

module.exports = async function eachEl($, tag, doThis) {
  const elements = $(tag);

  // Eventually I'd like to make this parallel
  // when forEach can handle paralell execution
  // for objects...
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    // The cheerio object contains other
    // shit. We only want img tag elements
    if (!el || el.name !== tag) continue;

    await doThis(el);
  }
};
