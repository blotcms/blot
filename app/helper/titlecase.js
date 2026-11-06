// Based on https://github.com/bdougherty/better-title-case

const { URL } = require("url");

const smallWords = [
  "a",
  "an",
  "and",
  "at",
  "but",
  "by",
  "for",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "so",
  "the",
  "to",
  "up",
  "yet",
  "v",
  "v.",
  "via",
  "vs",
  "vs.",
];

const containers = ["(", "[", "{", '"', `'`, "_"];

function isUrl(text) {
  try {
    const parsedUrl = new URL(text);
    return Boolean(parsedUrl.hostname);
  } catch (error) {
    return false;
  }
}

function capitalize(string) {
  if (string.length === 0) {
    return string;
  }

  const letters = [...string];
  const firstLetter = letters.shift();

  if (containers.includes(firstLetter)) {
    return `${firstLetter}${capitalize(letters)}`;
  }

  return `${firstLetter.toUpperCase()}${letters.join("")}`;
}

function titlecase(
  string = "",
  { excludedWords = [], useDefaultExcludedWords = true } = {}
) {
  if (string.toUpperCase() === string) {
    string = string.toLowerCase();
  }

  if (useDefaultExcludedWords) {
    excludedWords.push(...smallWords);
  }

  const words = string.split(/(\s+)/);

  let previousWord = "";
  // skip any 'words' which do not contain any letters
  // e.g. emojis, punctuation, etc.
  const firstWordIndex = words.findIndex((word) => word.match(/[a-z]/i));
  const lastWordIndex = words
    .slice()
    .reverse()
    .findIndex((word) => word.match(/[a-z]/i));

  const re = {
    isEmail: /.+@.+\..+/,
    isFilePath: /^(\/[\w.]+)+/,
    isFileName: /^\w+\.\w{1,3}$/,
    hasInternalCapital: /(?![-‑–—])[a-z]+[A-Z].*/,

    hasHyphen: /[-‑–—]/g,
  };
  const capitalizedWords = words.map((word, index) => {
    if (word.match(/\s+/)) {
      return word;
    }

    const isFirstWord = index === firstWordIndex;
    const isLastWord = index === lastWordIndex;

    const startOfSubPhrase = previousWord.endsWith(":");
    previousWord = word;

    if (
      re.isEmail.test(word) ||
      isUrl(word) ||
      re.isFilePath.test(word) ||
      re.isFileName.test(word) ||
      re.hasInternalCapital.test(word)
    ) {
      return word;
    }

    const hasHyphen = word.match(re.hasHyphen);
    if (hasHyphen) {
      const isMultiPart = hasHyphen.length > 1;
      const [hyphenCharacter] = hasHyphen;

      return word
        .split(hyphenCharacter)
        .map((subWord) => {
          if (
            isMultiPart &&
            excludedWords.indexOf(subWord.toLowerCase()) !== -1
          ) {
            return subWord;
          }

          return capitalize(subWord);
        })
        .join(hyphenCharacter);
    }

    if (word.indexOf("/") !== -1) {
      return word.split("/").map(capitalize).join("/");
    }

    if (isFirstWord || isLastWord) {
      return capitalize(word);
    }

    if (!startOfSubPhrase && excludedWords.indexOf(word.toLowerCase()) !== -1) {
      return word.toLowerCase();
    }

    return capitalize(word);
  });

  return capitalizedWords.join("");
}

module.exports = titlecase;
