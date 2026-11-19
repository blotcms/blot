// Renders an error inside the dashboard's layout (sidebar and breadcrumbs
// kept), with a heading for the status and a way back. If the layout itself
// can't render, as when the error left the page's locals half built, it falls
// back to the standalone error page.
module.exports = function renderError(err, req, res) {
  const status = err.status || 400;
  const notFound = status === 404;

  res.locals.errorTitle = notFound ? "Page not found" : "Something went wrong";
  res.locals.errorText = notFound
    ? "There's no page at this address. It may have moved, or the link may be mistyped."
    : "Blot couldn't complete your request. Try again, and contact support if it keeps happening.";
  res.locals.title = res.locals.errorTitle;
  // A missing page has nothing to debug (the stack is shown in development)
  if (notFound) res.locals.error = null;

  res.status(status);
  res.render("dashboard/error", function (renderErr, html) {
    if (!renderErr) return res.send(html);
    console.error("Error page failed to render:", renderErr.message);
    res.locals.layout = "";
    res.render("error");
  });
};
