const CONTAINER_NAME = require("config").container;

var CLF_MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(num) {
  var str = String(num);

  return (str.length === 1 ? "0" : "") + str;
}

module.exports = function clfdate() {
  var dateTime = new Date();

  var date = dateTime.getDate();
  var hour = dateTime.getHours();
  var mins = dateTime.getMinutes();
  var secs = dateTime.getSeconds();
  var year = dateTime.getFullYear();
  var offset = dateTime.getTimezoneOffset() / 60;

  if (offset > 0) {
    offset = "-" + pad2(offset) + "00";
  } else {
    offset = "+" + pad2(offset) + "00";
  }

  var month = CLF_MONTH[dateTime.getMonth()];

  return (
    "[" +
    pad2(date) +
    "/" +
    month +
    "/" +
    year +
    ":" +
    pad2(hour) +
    ":" +
    pad2(mins) +
    ":" +
    pad2(secs) +
    " " +
    offset +
    "]" +
    (CONTAINER_NAME ? " [" + CONTAINER_NAME + "]" : "")
  );
};
