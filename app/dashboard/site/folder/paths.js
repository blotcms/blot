// Express 5 no longer has the "(*)" param that Express 4 used to match the rest
// of a path (/folder/:path(*)), so these are regular expressions with a named
// group. They give req.params.path what Express 4 gave it: everything after
// the prefix, URL-decoded, possibly empty, and keeping a trailing slash. A path
// that doesn't decode is a 400, as it was. They ignore case, as routes do.
module.exports = {
  // /folder/Posts/hello world.txt
  folder: /^\/folder\/(?<path>.*)\/?$/i,
  // /folder/remove/Posts/hello world.txt
  remove: /^\/folder\/remove\/(?<path>.*)\/?$/i,
  // /folder-download/Posts/hello world.txt, mounted with use()
  download: /^\/folder-download\/(?<path>.*)\/?(?=\/|$)/i,
};
