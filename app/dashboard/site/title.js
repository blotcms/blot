const express = require("express");

const updateBlog = require("dashboard/util/update-blog");
const title = express.Router();

// The GET (/title) is the site's page with the Title row open
// (dashboard/site/index.js). A save goes back to the site's page, the row
// closed; an error reopens it.
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
