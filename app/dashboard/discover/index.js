const express = require("express");
const config = require("config");
const Blog = require("models/blog");
const Entry = require("models/entry");
const Discover = require("models/discover");

// The pages behind the links in the maintainer's daily email (#2639):
//
// - /sites/discover/add/:token, mounted before authentication. A one-time
//   token from the email is all it needs. GET shows the card and the photos
//   to choose from and changes nothing, since mail scanners open links; the
//   POST uses the token up and adds the post.
// - /sites/discover, the "Manage Discover" page, for the maintainer's own
//   account only (config.admin.uid).

const add = express.Router();
const manage = express.Router();

// Resolves to what the confirm page needs for a token, or null when the
// token has expired or been used
async function load(ref) {
  if (!ref) return null;

  const blog = await Blog.get({ id: ref.blogID });
  const entry = blog ? await Entry.get(ref.blogID, ref.entryID) : null;

  return {
    ref,
    blog,
    entry,
    candidates: Discover.photos.candidates(ref.blogID, entry),
  };
}

// Why the post can't go on Discover, or null when it can
function refusal(loaded) {
  const { blog, entry } = loaded;
  if (!blog || blog.isDisabled) return "The site no longer exists.";
  if (blog.includeInDiscover !== true)
    return "The site has turned off Discover.";
  if (!entry || entry.deleted || entry.draft || entry.scheduled || !entry.url)
    return "The post is not published.";
  return null;
}

function expired(res) {
  res.status(410);
  res.locals.title = "Add to Discover";
  res.render("dashboard/discover/discover-add", { expired: true });
}

function refuse(res, message) {
  res.status(400);
  res.locals.title = "Add to Discover";
  res.render("dashboard/discover/discover-add", { refused: message });
}

add.get("/:token", async (req, res, next) => {
  try {
    const loaded = await load(await Discover.token.read(req.params.token));

    if (!loaded) return expired(res);

    const [preview] = await Discover.cards([
      {
        id: "",
        blogID: loaded.ref.blogID,
        entryID: loaded.ref.entryID,
        photos: [],
        added: Date.now(),
      },
    ]);

    res.locals.title = "Add to Discover";
    res.render("dashboard/discover/discover-add", {
      token: req.params.token,
      refused: refusal(loaded),
      already: await Discover.has(loaded.ref.blogID, loaded.ref.entryID),
      preview,
      maxPhotos: Discover.photos.MAX_PHOTOS,
      candidates: loaded.candidates.map((source, index) => ({
        source,
        src: Discover.photos.url(loaded.ref.blogID, source),
        checked: index === 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

add.post("/:token", async (req, res, next) => {
  try {
    const loaded = await load(await Discover.token.read(req.params.token));

    if (!loaded) return expired(res);

    const refused = refusal(loaded);
    if (refused) return refuse(res, refused);

    let chosen = req.body.photo || [];
    if (!Array.isArray(chosen)) chosen = [chosen];

    chosen = chosen.filter(
      (source, index) =>
        loaded.candidates.indexOf(source) !== -1 &&
        chosen.indexOf(source) === index
    );

    if (chosen.length > Discover.photos.MAX_PHOTOS)
      return refuse(
        res,
        "Choose at most " + Discover.photos.MAX_PHOTOS + " photos."
      );

    const { blogID, entryID } = loaded.ref;
    const photos = await Discover.photos.derive(
      blogID,
      Discover.postID(blogID, entryID),
      chosen
    );

    // Two requests can get this far with one token; only one may add
    if (!(await Discover.token.consume(req.params.token))) return expired(res);

    await Discover.add(blogID, entryID, photos);

    res.locals.title = "Added to Discover";
    res.render("dashboard/discover/discover-added", {
      manage: "/sites/discover",
    });
  } catch (err) {
    next(err);
  }
});

function isMaintainer(req) {
  return !!(config.admin.uid && req.user && req.user.uid === config.admin.uid);
}

manage.use((req, res, next) => {
  if (!isMaintainer(req)) {
    const err = new Error("Page not found");
    err.status = 404;
    return next(err);
  }
  next();
});

manage.get("/", async (req, res, next) => {
  try {
    const { posts, next: more } = await Discover.list({
      all: true,
      limit: 100,
      before: req.query.before,
    });

    res.locals.title = "Manage Discover";
    res.locals.breadcrumbs.add("Discover", "/sites/discover");
    res.render("dashboard/discover/discover-manage", {
      posts,
      more: more ? "/sites/discover?before=" + more : "",
    });
  } catch (err) {
    next(err);
  }
});

manage.post("/remove", async (req, res, next) => {
  try {
    if (typeof req.body.id === "string" && req.body.id)
      await Discover.remove(req.body.id);
    res.redirect("/sites/discover");
  } catch (err) {
    next(err);
  }
});

manage.post("/remove-site", async (req, res, next) => {
  try {
    if (
      typeof req.body.blogID === "string" &&
      /^blog_\w+$/.test(req.body.blogID)
    )
      await Discover.removeBlog(req.body.blogID);
    res.redirect("/sites/discover");
  } catch (err) {
    next(err);
  }
});

module.exports = { add, manage };
