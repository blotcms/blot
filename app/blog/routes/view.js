const { getViewByURL } = require("../lib/models");

module.exports = async function view(req, res, next) {
  try {
    const template = req?.blog?.template;

    if (!template) return next();

    // If you don't decode the URL here, you'll see issues
    // with URLs containing special characters e.g. %20 or %2F
    // We intentionally do minimal processing in getViewsByURL
    let url = req.url;
    try {
      url = decodeURIComponent(req.url);
    } catch (e) {
      url = req.url;
    }

    const { viewName, params } = await getViewByURL(template, url);

    if (!viewName) return next();

    // Overwrite the request params with the params parsed from the URL
    if (params) {
      req.params = params;
    }

    // expose the query and params to the view
    // DON'T set query directly because a lot of templates rely
    // on the previous mapping of req.query.q to res.locals.query
    res.locals.request = { query: req.query, params: req.params };

    return res.renderView(viewName, next);
  } catch (err) {
    return next(err);
  }
};
