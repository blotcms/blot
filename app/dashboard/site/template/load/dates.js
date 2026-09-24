var moment = require("moment");
require("moment-timezone");

var displays = [
  "D/M/Y",
  "M/D/Y",
  "Y/M/D",
  "MMMM D, Y",
  "MMMM D, Y [at] h:mma",
  "D MMMM Y",
  "Y-MM-DD",
  "Y-MM-DD HH:mm"
];

module.exports = function (req, res, next) {
  let date_display = req.template.locals.date_display;
  let hide_dates = req.template.locals.hide_dates;
  const hideDatesValue = "__hide_dates__";

  res.locals.hide_dates_value = hideDatesValue;

  if (date_display) {
    var displayFormats = [
      {
        value: hideDatesValue,
        selected: hide_dates ? "selected" : "",
        date: "Hide dates"
      }
    ];
    const hasMatchingFormat = displays.includes(date_display);

    displays.forEach(function (display, index) {
      var now = moment.utc(Date.now()).tz(req.blog.timeZone).format(display);

      displayFormats.push({
        value: display,
        selected:
          !hide_dates &&
          (display === date_display || (!hasMatchingFormat && index === 0))
            ? "selected"
            : "",
        date: now
      });
    });

    res.locals.displayFormats = displayFormats;
  } else {
    res.locals.displayFormats = false;
  }

  res.locals.show_hide_dates = hide_dates !== undefined;
  res.locals.hide_dates = hide_dates;

  res.locals.show_date_options =
    res.locals.show_hide_dates && res.locals.displayFormats.length;

  next();
};
