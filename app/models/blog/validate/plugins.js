module.exports = function (blogID, plugins, callback) {
  // For some reason (perhaps Disqus UI) we ran into an
  // issue where people's shortname included the Disqus
  // domain. This validator will strip the domain.
  if (
    plugins &&
    plugins.disqus &&
    plugins.disqus.options &&
    plugins.disqus.options.shortname
  ) {
    let shortname = plugins.disqus.options.shortname;
    let suffix = ".disqus.com";

    if (shortname.endsWith(suffix) && shortname.length > suffix.length)
      shortname = shortname.slice(0, -suffix.length);

    plugins.disqus.options.shortname = shortname;
  }

  callback(null, plugins);
};
