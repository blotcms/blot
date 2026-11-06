module.exports = function firstSentence(str) {
  if (!str || !str.trim()) return "";

  str = str.slice(0, 1000);

  str = str.trim();

  var lines = str.split("\n");

  str = lines[0];

  var sentenceArr = str.match(/[^.!?]+[.!?]+/g);

  if (sentenceArr && sentenceArr[0]) return sentenceArr[0];

  return str.slice(0, 1000);
};
