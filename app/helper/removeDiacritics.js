const ensure = require("helper/ensure");

// modified from here: https://gist.github.com/mathewbyrne/1280286
// also using https://help.ivanti.com/res/help/en_US/IA/2021/Admin/Content/35149.htm
module.exports = function removeDiacritics(str) {
  if (!str) return "";

  ensure(str, "string");

  str = decodeURIComponent(str); // lol we shouldnt do this
  str = str.toLowerCase();

  var swaps = [
    { from: "œ", to: "oe" },
    { from: "ö", to: "oe" },
    { from: "æ", to: "ae" },
    { from: "ä", to: "ae" },
    { from: "å", to: "aa" },
    { from: "þ", to: "th" },
    { from: "ü", to: "ue" },
    { from: "ß", to: "ss" },
  ];

  for (const item of swaps) {
    const { from, to } = item;
    str = str.replace(new RegExp(from, "g"), to);
  }

  var from = "àáâãåāçćčèéêëēėęîïíīįìłñńôòóøōõśšûùúūųŵÿýŷžźż";
  var to = "aaaaaaccceeeeeeeiiiiiilnnoooooossuuuuuwyyyzzz";

  for (var i = 0, l = from.length; i < l; i++)
    str = str.replace(new RegExp(from.charAt(i), "g"), to.charAt(i));

  str = encodeURIComponent(str);

  return str;
};
