var withCallback = require("helper/withCallback");

// This makes it easy to iterate over a
// cheerio element collection and perform
// some asynchronous task, a la forEach.

// Eventually I'd like to make this parallel
// when forEach can handle paralell execution
// for objects...
async function each_el($, tag, doThis) {
  const elements = $(tag);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    // The cheerio object contains other
    if (!el || el.name !== tag) continue;

    await new Promise(function (resolve, reject) {
      doThis(el, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

module.exports = withCallback(each_el);
