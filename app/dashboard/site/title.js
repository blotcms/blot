const express = require("express");

const updateBlog = require("dashboard/util/update-blog");
const title = express.Router();

// The Title page, linked from the summary card on the site's page. A save
// goes back to the site's page; an error stays here.
title.use((req, res, next) => {
  res.locals.breadcrumbs.add("Title", "title");
  next();
});

title.get("/", (req, res) => {
  res.render("dashboard/site/title", {
    title: "Title · " + req.blog.pretty.label,
  });
});

title.route("/").post(async (req, res) => {
  try {
    const changes = await updateBlog(req.blog.id, {
      title: req.body.title,
    });

    if (changes && changes.includes("title")) {
      res.message(res.locals.dashboardBase, "Saved changes to title");
    } else {
      res.redirect(res.locals.dashboardBase);
    }
  } catch (error) {
    res.message(req.baseUrl, error);
  }
});

module.exports = title;
