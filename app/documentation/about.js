var Express = require("express");
var notes = new Express.Router();
const { marked } = require("marked");
const fs = require("fs-extra");
const rootDir = require("helper/rootDir");

const NOTES_DIRECTORY = rootDir + "/app/views/about/notes";
let buildTOC = require("./tools/toc");


let TOC = buildTOC(NOTES_DIRECTORY);

const chokidar = require("chokidar");
const config = require("config");

if (config.environment === "development")
  chokidar
    .watch(NOTES_DIRECTORY, { cwd: NOTES_DIRECTORY })
    .on("all", () => (TOC = buildTOC(NOTES_DIRECTORY)));

notes.use(function (req, res, next) {
  res.locals.base = "/about";
  res.locals.selected = { about: "selected"};
  next();
});

notes.param("section", function (req, res, next) {
  res.locals.toc = TOC.map(section => {
    section.isSelected = req.params.section === section.id ? "selected" : false;
    return section;
  });

  res.locals.section = "/about/" + req.params.section;
  next();
});

notes.param("article", function (req, res, next) {
  res.locals.toc = TOC.map(section => {
    section.isSelected = req.params.section === section.id ? "selected" : false;
    section.items = section.items.map(article => {
      article.isSelected = req.params.article === article.id ? "selected" : false;
      return article;
    });
    return section;
  });

  next();
});

notes.get("/", function (req, res, next) {
  res.locals.showToc = true;
  res.locals.selected.aboutIndex = "selected";

  res.locals.toc = TOC.map(section => {
    section.isSelected = false;
    return section;
  });

  try {
    res.locals.body = marked.parse(
      fs.readFileSync(NOTES_DIRECTORY + "/README", "utf-8")
    );  
  } catch (e) {}

  next();
});

notes.get("/:section", function (req, res, next) {
  res.locals.toc = TOC.map(section => {
    section.isSelected = req.params.section === section.id ? "selected" : false;

    if (section.items) {
      section.items = section.items.map(article => {
        article.isSelected = false;
        return article;
      });
    }

    return section;
  });

  try {
    res.locals.body = marked.parse(
      fs.existsSync(NOTES_DIRECTORY + "/" + req.params.section + '.txt') ?
      fs.readFileSync(
        NOTES_DIRECTORY + "/" + req.params.section + ".txt",
        "utf-8"
      ) :
      fs.readFileSync(
        NOTES_DIRECTORY + "/" + req.params.section + "/README",
        "utf-8"
      )
    );  
  } catch (e) {}


  next();
});

// Hack to allow us to place some articles higher than
// others. This map allows us to retrieve
// notes/business/-principles.txt from disk correctly
const SORTING_MAP = {
  principles: "-principles",
  tools: "-tools",
  technique: "-technique"
};

notes.get("/:section/:article", function (req, res, next) {

  res.locals.toc = TOC.map(section => {
    section.isSelected = req.params.section === section.id ? "selected" : false;

    if (section.items) {
      section.items = section.items.map(article => {
        article.isSelected = req.params.article === article.id && req.params.section === section.id
         ? "selected" : false;
        return article;
      });
    }

    return section;
  });

  try {
    let article = SORTING_MAP[req.params.article] || req.params.article;
    res.locals.body = marked.parse(
      fs.readFileSync(
        NOTES_DIRECTORY + "/" + req.params.section + "/" + article + ".txt",
        "utf-8"
      )
    );
  } catch (e) {}
  next();
});

notes.get(["/", "/:section/:article", "/:section"], function (req, res, next) {
  // For some reason we couldn't find the file
  if (!res.locals.body) return next();

  res.render("about/template");
});
module.exports = notes;
