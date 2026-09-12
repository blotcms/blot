const moment = require("moment");
const asRetriever = require("../../lib/asRetriever");
require("moment-timezone");

module.exports = asRetriever(function (req, res) {
  return function () {
    const d = moment.utc(req.blog.cacheID).tz(req.blog.timeZone);

    // Section: {{#date}} YYYY {{/date}}
    const renderDate = function () {
      let [text, render] = arguments; // text = block contents

      try {
        text = text.trim();
        text = render(text);
        text = d.format(text);
      } catch (e) {
        text = "";
      }

      return text;
    };

    // Interpolation: {{date}}
    renderDate.toString = function () {
      let text = "";
      try {
        text = d.format(res.locals.date_display || "MMMM D, Y");
      } catch (e) {
        text = "";
      }
      return text;
    };

    return renderDate;
  };
});
