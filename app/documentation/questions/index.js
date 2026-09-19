const Express = require("express");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const Email = require("helper/email");
const cookieParser = require('cookie-parser');

const lookup = (tag) =>
  map[tag] || (tag[0].toUpperCase() + tag.slice(1)).replace(/-/g, " ");

const map = {
  "json-feed": "JSON Feed",
};

const Questions = new Express.Router();
const moment = require("moment");

const { tags, create, update, list, get, search } = require("models/question");
const render = require("./render");
const Paginator = require("./paginator");
const config = require("config");
const flush = require("documentation/tools/flush-cache");

Questions.use(
  ["/ask", "/:id"],
  require("dashboard/util/session"),
  require("dashboard/util/parse"),
  cookieParser(),
  require("dashboard/util/csrf")
);

Questions.get("/search", async (req, res, next) => {
  try {
    const query = req.query.query;

    if (query) {
      res.locals.questions = await search({ query });
      res.locals.query = query;
    } else {
      res.locals.questions = [];
    }
  } catch (e) {
    // A cached empty result would outlive the outage, so surface it as a 503
    if (isRedisUnavailableError(e)) return next(e);
    res.locals.questions = [];
  }

  // don't cache
  res.set("Cache-control", "private");
  res.render("questions/search");
});

Questions.use(async (req, res, next) => {
  try {
    const result = await tags();
    res.locals.popular_tags = result.tags;
    next();
  } catch (err) {
    next(err);
  }
});

Questions.use(function (req, res, next) {
  res.locals.base = "/questions";
  res.locals["show-question-sidebar"] = true;
  res.locals["hide-on-this-page"] = true;
  // The rest of these pages should not be cached
  next();
});

Questions.get("/feed.rss", async function (req, res, next) {
  try {
    res.locals.url = config.protocol + config.host;
    res.locals.title = "Questions";
    const { questions } = await list({ sort: "by_created" });

    res.locals.topics = questions;

    // We preview one line of the topic body on the question index page
    res.locals.topics.forEach(function (topic) {
      const { body, summary } = render(topic.body);
      topic.summary = summary;
      topic.body = body;
      topic.url = res.locals.url + "/questions/" + topic.id;
      topic.author = "Anonymous";
      topic.date = moment(new Date(parseInt(topic.created_at))).format(
        "ddd, DD MMM YYYY HH:mm:ss ZZ"
      );
    });

    const template = await require("fs-extra").readFile(
      req.app.get("views") + "/questions/_feed.rss",
      "utf-8"
    );
    const result = require("mustache").render(template, res.locals);

    res.set("Content-type", "text/xml;charset=UTF-8");
    res.set("Pragma", "public");
    res.set("Cache-control", "private");
    res.set("Expires", "-1");

    res.send(result);
  } catch (err) {
    next(err);
  }
});

// Handle topic listing
// Topics are sorted by datetime of last reply, then by topic creation date
Questions.get(["/", "/page-:page"], async function (req, res, next) {
  try {
    const page = req.params.page ? parseInt(req.params.page) : 1;

    if (!Number.isInteger(page)) {
      return next();
    }

    const { questions, stats } = await list({ page, page_size: 20 });

    res.locals.topics = questions;

    // We preview one line of the topic body on the question index page
    res.locals.topics.forEach(function (topic) {
      const { body, summary } = render(topic.body);
      topic.body = body;
      topic.summary = summary;
      topic.singular = topic.number_of_replies === 1;

      topic.tags = topic.tags.map((tag) => {
        return { tag, slug: tag };
      });
    });

    res.locals.title = page > 1 ? `Page ${page} - Questions` : "Questions";
    res.locals.paginator = Paginator(
      page,
      stats.page_size,
      stats.total,
      "/questions"
    );

    res.render("questions");
  } catch (err) {
    next(err);
  }
});

// Topics are sorted by datetime of last reply, then by topic creation date
Questions.get(
  ["/replies", "/replies/page-:page"],
  async function (req, res, next) {
    try {
      const page = req.params.page ? parseInt(req.params.page) : 1;

      if (!Number.isInteger(page)) {
        return next();
      }

      const { questions, stats } = await list({
        page,
        page_size: 20,
        sort: "by_number_of_replies",
      });

      res.locals.breadcrumbs = res.locals.breadcrumbs.slice(0, 1);

      res.locals.topics = questions;

      // We preview one line of the topic body on the question index page
      res.locals.topics.forEach(function (topic) {
        const { body, summary } = render(topic.body);
        topic.body = body;
        topic.summary = summary;
        topic.singular = topic.number_of_replies === 1;

        topic.tags = topic.tags.map((tag) => {
          return { tag, slug: tag };
        });
      });

      res.locals.title = page > 1 ? `Page ${page} - Questions` : "Questions";
      res.locals.paginator = Paginator(
        page,
        stats.page_size,
        stats.total,
        "/questions/replies"
      );

      res.render("questions");
    } catch (err) {
      next(err);
    }
  }
);

Questions.route(["/tags", "/tags/page-:page"]).get(async function (
  req,
  res,
  next
) {
  try {
    const page = req.params.page ? parseInt(req.params.page) : 1;

    if (page && !Number.isInteger(page)) {
      return next();
    }

    const result = await tags({ page });

    res.locals.title = page > 1 ? `Page ${page} - Tags` : "Tags";
    res.locals.tags = result.tags;
    res.locals.paginator = Paginator(
      page,
      result.stats.page_size,
      result.stats.total,
      "/questions/tags"
    );
    res.render("questions/tags");
  } catch (err) {
    next(err);
  }
});

// Handle topic viewing and creation
Questions.route("/ask")
  .get(function (req, res) {
    res.locals.authenticated = req.session && req.session.uid;
    res.render("questions/ask");
  })
  .post(async (req, res, next) => {
    try {
      const author = req.session.uid;
      const title = req.body.title;
      const tags = req.body.tags;
      const body = req.body.body;
      const email = req.body.email;
      // Disallow empty title or body.
      // TODO: show error message, do not lose form data
      if (title.trim().length === 0 || body.trim().length === 0)
        return next(new Error("Title and body must be set"));
      else {
        // if the user is not logged in, send an email to the admin
        // to manually post the question
        if (!req.session || !req.session.uid) {
          const questionURL =
            config.protocol +
            config.host +
            "/sites/log-in?then=" +
            encodeURIComponent(
              "/questions/ask?title=" +
                encodeURIComponent(title) +
                "&body=" +
                encodeURIComponent(body)
            );
          Email.QUESTION(null, {
            title,
            body,
            questionURL,
            email,
            replyTo: email,
          });
          res.send("OK");
        } else {
          const { id } = await create({ author, title, body, tags });
          const questionURL = config.protocol + config.host + "/questions/" + id;
          Email.QUESTION_PUBLISHED(author, { title, body, questionURL });
          flush();
          res.redirect("/questions/" + id);
        }
      }
    } catch (err) {
      next(err);
    }
  });

// Handle new reply to topic
Questions.route("/:id/new").post(async (req, res, next) => {
  try {
    if (!req.session || !req.session.uid)
      return res.redirect(`/log-in?then=/questions/${req.params.id}/new`);
    const author = req.session.uid;
    const body = req.body.body;
    if (body.trim().length === 0) res.redirect("/questions/" + req.params.id);
    else {
      await create({ author, body, parent: req.params.id });
      const question = await get(req.params.id);
      if (question) {
        const questionURL = config.protocol + config.host + "/questions/" + req.params.id;
        Email.QUESTION_REPLY_PUBLISHED(null, { title: question.title, body, questionURL });
      }
      flush();
      res.redirect("/questions/" + req.params.id);
    }
  } catch (err) {
    next(err);
  }
});

Questions.route("/:id/edit")
  .get(async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!req.session || !req.session.uid) {
        req.log("Redirecting to login", id);
        return res.redirect(`/log-in?then=/questions`);
      }

      req.log("Retrieving question", id);
      res.locals.topic = await get(id);
      req.log("Retrieved question", id);
      res.render("questions/edit");
    } catch (err) {
      next(err);
    }
  })
  .post(async (req, res, next) => {
    try {
      const id = req.params.id;

      if (!req.session || !req.session.uid)
        return res.redirect(`/log-in?then=/questions/${id}/edit`);

      const title = req.body.title || "";
      const body = req.body.body;
      const tags = (req.body.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const question = await update(id, { title, body, tags });
      flush();

      res.redirect("/questions/" + (question.parent ? question.parent : id));
    } catch (err) {
      next(err);
    }
  });

Questions.route("/:id").get(async (req, res, next) => {
  try {
    const id = req.params.id;
    const topic = await get(id);

    if (!topic) return next();

    if (topic.parent) return res.redirect(`/questions/${topic.parent}`);

    topic.body = render(topic.body).body;
    topic.reply_count = topic.replies.length;

    res.locals.breadcrumbs[res.locals.breadcrumbs.length - 1].label = topic.title;
    topic.tags = topic.tags.map((tag) => {
      return { tag, slug: tag };
    });

    res.locals.title = topic.title;
    res.locals.topics = topic.replies
      .filter((reply) => !!reply.body)
      .map((reply) => {
        reply.body = render(reply.body).body;
        reply.answered = moment(reply.created_at).fromNow();
        reply.answeredDateStamp = moment(reply.created_at).valueOf();
        return reply;
      });

    res.locals.topic = topic;
    res.render("questions/topic");
  } catch (err) {
    next(err);
  }
});

Questions.get(
  ["/tagged", "/tagged/:tag", "/tagged/:tag/page-:page"],
  async (req, res, next) => {
    try {
      // Pagination data

      if (!req.params.tag) return res.redirect(req.baseUrl + "/tags");

      if (req.params.page === "1")
        return res.redirect(req.baseUrl + `/tagged/${req.params.tag}`);

      const page = req.params.page ? parseInt(req.params.page) : 1;
      const tag = req.params.tag;

      if (!Number.isInteger(page)) {
        return next();
      }

      if (!tag) {
        return next();
      }

      res.locals.prettyTag = lookup(tag);
      res.locals.breadcrumbs = res.locals.breadcrumbs.slice(0, 1).concat({
        label: lookup(tag),
        url: "/questions/tagged/" + tag,
      });

      const { questions, stats } = await list({ tag, page });

      const topics = questions;

      // We preview one line of the topic body on the question index page
      topics.forEach(function (topic) {
        const { body, summary } = render(topic.body);
        topic.body = body;
        topic.summary = summary;

        if (topic.tags)
          topic.tags = topic.tags.map((tag) => ({ tag, slug: tag }));

        topic.asked = moment(topic.created_at).fromNow();
        topic.askedDateStamp = moment(topic.created_at).valueOf();
      });

      res.locals.tag = tag;
      res.locals.title = page > 1 ? `Page ${page} - Questions` : "Questions";
      res.locals.topics = topics;
      res.locals.paginator = Paginator(
        page,
        stats.page_size,
        stats.total,
        "/questions/tagged/" + tag
      );
      res.render("questions");
    } catch (err) {
      next(err);
    }
  }
);

module.exports = Questions;
