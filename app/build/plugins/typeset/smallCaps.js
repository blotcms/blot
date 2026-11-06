// typeset's smallCaps module (typeset 0.3.7, src/smallCaps.js, MIT, by David
// Merfield), unchanged except that the list of characters removeCruft strips
// is built once rather than for every word, which made this module most of
// the plugin's CPU time. Its output is identical: see tests/plugins/typeset.js.
const { dirname } = require("path");
// The html-entities typeset itself uses
const Entities = require(
  require.resolve("html-entities", {
    paths: [dirname(require.resolve("typeset/package.json"))],
  })
).AllHtmlEntities;
const entities = new Entities();

// Only numbers regex
const onlyNumbers = new RegExp("^\\d+$");

// Ensure the word has a length of more than 2 letters,
// does not contain punctation since exterior punctuation
// has been stripped by this point. If so, then see if the
// uppercase version of the word is indentical, if so it's
// very probably an acronym
function isAcronym(word) {
  return (
    word.length &&
    word.trim().length > 1 &&
    !onlyNumbers.test(
      word.replace(/[\.,-\/#!–$%°\^&\*;?:+′|@\[\]{}=\-_`~()]/g, "")
    ) &&
    word.replace(/[\.,-\/#!$%\^&\*;–?:+|@\[\]{}=\-_`~(′°)]/g, "") === word &&
    word.toUpperCase() === word
  );
}

// typeset rebuilds this list, encoding each item, for every word
const IGNORE = (function () {
  let ignore = "{}()-‘’[]!#$*&;:,.“”″′‘’\"'"
    .split("")
    .concat(["&quot;", "'s", "’s", "&#39;s"]);
  const encodedIgnore = ignore.slice(0);

  for (const x in encodedIgnore)
    encodedIgnore[x] = entities.encode(encodedIgnore[x]);

  return ignore.concat(encodedIgnore);
})();

function removeCruft(word) {
  const ignore = IGNORE;

  let trailing = "";
  let leading = "";

  for (let i = 0; i < ignore.length; i++) {
    const ignoreThis = ignore[i];
    const endOfWord = word.slice(-ignoreThis.length);

    if (endOfWord === ignoreThis) {
      trailing = ignoreThis + trailing;
      word = word.slice(0, -ignoreThis.length);
      i = 0;
      continue;
    }
  }

  for (let j = 0; j < ignore.length; j++) {
    const ignoreThat = ignore[j];
    const startOfWord = word.slice(0, ignoreThat.length);

    if (startOfWord === ignoreThat) {
      leading += ignoreThat;
      word = word.slice(ignoreThat.length);
      j = 0;
      continue;
    }
  }

  return [leading, word, trailing];
}

module.exports = (text) => {
  const wordList = text.split(" ");

  for (const i in wordList) {
    const brokenWord = removeCruft(wordList[i]);
    const word = brokenWord[1];
    const leading = brokenWord[0];
    const trailing = brokenWord[2];

    if (isAcronym(word)) {
      wordList[i] =
        leading + '<span class="small-caps">' + word + "</span>" + trailing;
    }
  }

  return wordList.join(" ");
};
