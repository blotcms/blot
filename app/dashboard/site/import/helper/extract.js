module.exports = function Extract($, el) {
  return function (name, arr) {
    var result = [];

    var matches = $(el)
      .contents()
      .filter(function () {
        return this.name === name;
      });

    matches.each(function () {
      var html = $(this).html();

      if (html.indexOf("<![CDATA[") === 0) {
        html = html.slice("<![CDATA[".length, -3);
      } else {
        console.log("BEFORE UNESCAPING!", html);
        html = unescapeHTML(html);
        console.log("AFTER", html);
      }

      result.push(html);
    });

    result = result.filter(function (i) {
      return !!i;
    });

    if (result.length === 1 && !arr) return result[0];

    if (result.length === 0) return "";

    return result;
  };
};

// https://stackoverflow.com/questions/18749591/encode-html-entities-in-javascript/39243641#39243641

var htmlEntities = {
  nbsp: " ",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  copy: "©",
  reg: "®",
  lt: "<",
  gt: ">",
  quot: '"',
  amp: "&",
  apos: "'",
};

function unescapeHTML(str) {
  return str.replace(/&([^;]+);/g, function (entity, entityCode) {
    var match;

    if (entityCode in htmlEntities) {
      return htmlEntities[entityCode];
      /*eslint no-cond-assign: 0*/
    } else if ((match = entityCode.match(/^#x([\da-fA-F]+)$/))) {
      return String.fromCharCode(parseInt(match[1], 16));
    } else if ((match = entityCode.match(/^#(\d+)$/))) {
      return String.fromCharCode(~~match[1]);
    } else {
      return entity;
    }
  });
}
