const express = require("express");
const Blog = require("models/blog");
const Entry = require("models/entry");
const Discover = require("models/discover");
const featured = require("documentation/featured");
const { decorate } = require("documentation/discover");

// The page behind the "Add to Discover" links in the maintainer's daily
// email (#2639): /sites/discover/add/:token, mounted before authentication.
// A one-time token from the email is all it needs. GET shows a preview of the
// card and the photos to choose from and changes nothing, since mail scanners
// open links; the POST uses the token up and adds the post. Everything else
// (removing posts, profiles) is done with the scripts in scripts/discover.
//
// The preview is the card as /discover will show it. GET takes the form's
// choices as a query (?preview=1&photo=…&showText=1), so the "Update preview"
// button works without JavaScript; the page's script fetches that page as the
// choices change and swaps the card in.

const add = express.Router();

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

// Why the post can't go on Discover, or null when it can. A site with the
// setting off can still be added: adding turns it on, as scripts/discover/add.js
// does, and the page says so first.
function refusal(loaded) {
  const { blog, entry } = loaded;
  if (!blog || blog.isDisabled) return "The site no longer exists.";
  if (!entry || entry.deleted || entry.draft || entry.scheduled || !entry.url)
    return "The post is not published.";
  return null;
}

// The photos chosen in a form or query, in the order they appear in the
// post, without duplicates or any that aren't the post's
function chosen(value, candidates) {
  const list = new Set(
    (Array.isArray(value) ? value : [value]).filter(
      (item) => typeof item === "string"
    )
  );
  return candidates.filter((source) => list.has(source));
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

// Resolves to the card for the choices, as /discover would render it. The
// photos are the post's own until the POST derives the resized copies.
async function preview(loaded, photos, showText) {
  const [card] = await Discover.cards([
    {
      id: "",
      blogID: loaded.ref.blogID,
      entryID: loaded.ref.entryID,
      photos: photos.map((source) => ({ source, path: source })),
      showText,
      added: Date.now(),
    },
  ]);

  const sites = ((await featured.load()) || {}).sites;
  decorate([card], sites);
  return card;
}

add.get("/:token", async (req, res, next) => {
  try {
    const loaded = await load(await Discover.token.read(req.params.token));

    if (!loaded) return expired(res);

    // Until the form is submitted, the first photo is chosen
    const submitted = req.query.preview === "1";
    const photos = submitted
      ? chosen(req.query.photo, loaded.candidates)
      : loaded.candidates.slice(0, 1);
    const showText = submitted && !!req.query.showText;
    const tooMany = photos.length > Discover.photos.MAX_PHOTOS;
    const { blog } = loaded;

    res.locals.title = "Add to Discover";
    res.render("dashboard/discover/discover-add", {
      token: req.params.token,
      refused: refusal(loaded),
      already: await Discover.has(loaded.ref.blogID, loaded.ref.entryID),
      // The setting is off: false when the site turned it off, missing for
      // sites made before Discover which haven't had it turned on
      settingOff: !!blog && blog.includeInDiscover !== true,
      turnedOff: !!blog && blog.includeInDiscover === false,
      preview: await preview(
        loaded,
        photos.slice(0, Discover.photos.MAX_PHOTOS),
        showText
      ),
      tooMany,
      showText,
      maxPhotos: Discover.photos.MAX_PHOTOS,
      candidates: loaded.candidates.map((source) => ({
        source,
        src: Discover.photos.url(loaded.ref.blogID, source),
        checked: photos.indexOf(source) !== -1,
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

    const sources = chosen(req.body.photo, loaded.candidates);

    if (sources.length > Discover.photos.MAX_PHOTOS)
      return refuse(
        res,
        "Choose at most " + Discover.photos.MAX_PHOTOS + " photos."
      );

    const { blogID, entryID } = loaded.ref;
    const photos = await Discover.photos.derive(
      blogID,
      Discover.postID(blogID, entryID),
      sources
    );

    // Two requests can get this far with one token; only one may add
    if (!(await Discover.token.consume(req.params.token))) return expired(res);

    // Discover leaves out the posts of sites with the setting off
    if (loaded.blog.includeInDiscover !== true)
      await Blog.set(blogID, { includeInDiscover: true });

    await Discover.add(blogID, entryID, photos, {
      showText: !!req.body.showText,
    });

    res.locals.title = "Added to Discover";
    res.render("dashboard/discover/discover-added");
  } catch (err) {
    next(err);
  }
});

module.exports = { add };
