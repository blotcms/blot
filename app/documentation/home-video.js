// The homepage's video thumbnail: a small Mac desktop, drawn with pane, with
// the My site folder in Finder, a few icons loose on the desktop and the site
// in Safari. The scene is laid out at 1280 x 720 and scaled down to the card
// in CSS (css/home.css); js/home-video.js plays the loop (a pointer picks a
// file, the site scrolls down and back up). Built once per process.

const pane = require("helper/pane");
const { url: cdnURL } = require("./tools/cdn-url-helper");

// The site Safari shows. It goes straight into the browser window rather
// than into pane's sandboxed iframe: that page has an opaque origin, which
// the CDN's images don't load in, and an iframe per homepage view is heavy.
// photos is the album template's screenshot; css/home.css crops four of its
// pictures out of it.
const site = (photos) =>
  `<div class="home-video-site" style="--home-video-photos: url(${photos})">` +
  `<header><b>My site</b><span>Archive</span><span>About</span></header>` +
  `<article><h4>Trip to France</h4><time>Today</time>` +
  `<p>Four days on the Normandy coast, mostly walking. The light changes every hour and the tide goes out further than you think.</p>` +
  `<div class="home-video-photos"><i></i><i></i><i></i><i></i></div>` +
  `<p>We stayed in Étretat, ate too many apples and took the long way back through the orchards.</p></article>` +
  `<hr>` +
  `<article><h4>Reading list</h4><time>2 November</time>` +
  `<p>Books for the winter, in no particular order.</p></article>` +
  `</div>`;

const cache = new Map();

function scene(photos) {
  if (cache.has(photos)) return cache.get(photos);

  const desktop = pane.folder("Notes/\nEssay.docx\nRecipes/", {
    view: "desktop",
    title: "Desktop",
    os: "mac",
    theme: "light",
  }).html;

  const finder = pane.folder(
    "Pages/\nDrafts/\nTrip to France.docx\nAbout.txt",
    {
      view: "icons",
      title: "My site",
      os: "mac",
      theme: "light",
      width: "300px",
      height: "340px",
    }
  ).html;

  // No page given, so pane leaves the window's page area empty for the site
  const browser = pane
    .browser({
      url: "https://mysite.blot.im",
      title: "My site",
      os: "mac",
      theme: "light",
      width: "812px",
      height: "608px",
    })
    .html.replace(
      '<div class="pane-page"></div>',
      `<div class="pane-page">${site(photos)}</div>`
    );

  const html =
    `<div class="home-video-desktop">${desktop}</div>` +
    `<div class="home-video-finder">${finder}</div>` +
    `<div class="home-video-browser">${browser}</div>` +
    `<svg class="home-video-pointer" data-home-video-pointer viewBox="0 0 16 20" width="26" height="33"><path d="M1 1v15l4-3.5 3 6.5 2.5-1.2-3-6.3H14z" fill="#fff" stroke="#121212" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  cache.set(photos, html);
  return html;
}

// For the pages that show the thumbnail (partials/video-thumbnail.html): the
// homepage and the documentation page
module.exports = function homeVideo(req, res, next) {
  res.locals.homeVideo = scene(cdnURL("/images/examples/album/0.png"));
  next();
};
