const path = require("path");
const fs = require("fs-extra");

// Used to extract title text from Markdown title tags in note source files
const HASH_TITLE_REGEX = /# (.*)/;
const DASH_TITLE_REGEX = /(.*)\n[=-]+\n/;

const extractName = (path, contents) => {
  const hashTitle = HASH_TITLE_REGEX.exec(contents);
  const dashTitle = DASH_TITLE_REGEX.exec(contents);

  if (hashTitle && hashTitle[1]) {
    return hashTitle[1];
  } else if (dashTitle && dashTitle[1]) {
    return dashTitle[1];
  } else {
    return withoutExtension(path.split("/").pop());
  }
};

const removeLeadingDash = (name) => (name[0] === "-" ? name.slice(1) : name);

const withoutExtension = (name) => path.parse("/" + name).name;

const removeIgnorableItems = (name) =>
  name[0] !== "." && name[0] !== "_" && name !== "README";

const buildTOC = (NOTES_DIRECTORY) =>
  fs
    .readdirSync(NOTES_DIRECTORY)
    .filter(removeIgnorableItems)
    .map((section) => {
      return {
        name: section.includes('.txt') ? section[0].toUpperCase() + section.slice(1, -4)
          : section[0].toUpperCase() + section.slice(1),
        id: withoutExtension(section), 
        items: fs.statSync(NOTES_DIRECTORY + '/' + section).isDirectory()
          ? fs
          .readdirSync(NOTES_DIRECTORY + "/" + section)
          .filter(removeIgnorableItems)
          .map((article) => {
            const contents = fs.readFileSync(
              NOTES_DIRECTORY + "/" + section + "/" + article,
              "utf-8"
            );
            return {
              name: extractName(
                NOTES_DIRECTORY + "/" + section + "/" + article,
                contents
              ),
              id: withoutExtension(article),
              slug:
                "/about/" +
                withoutExtension(section) +
                "/" +
                removeLeadingDash(withoutExtension(article)),
            };
          }) : [],
        slug: "/about/" + path.parse("/" + section).name,
      };
    });

module.exports = buildTOC;
