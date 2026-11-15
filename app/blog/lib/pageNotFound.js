// What a blog answers for a URL that has nothing to show: the locals of the
// template's error.html, and the error a retriever throws for a listing page
// past the last one. The catch-all 404 handler and the error handler in
// routes/error.js both use the locals, so every 404 renders the same.
const NOT_FOUND_LOCALS = {
  title: "Page not found",
  message: "There is no page with this URL.",
  status: 404,
};

// statusCode makes retrieve/index.js re-throw it; status and pageNotFound
// make the error handler render the 404 page rather than the generic error.
function pageNotFoundError() {
  const error = new Error("Page not found");
  error.status = 404;
  error.statusCode = 404;
  error.pageNotFound = true;
  return error;
}

// Throws when pagination describes a page past the last one. Page 1 is never
// out of range, even with nothing to list. Not thrown while the error page
// itself renders (res.locals.error is set), since its own locals may list
// posts too and would fail on the same page number.
function assertPageInRange(res, pagination) {
  if (res && res.locals && res.locals.error) return;
  const current = Number(pagination && pagination.current);
  const total = Number(pagination && pagination.total);
  if (current > 1 && current > total) throw pageNotFoundError();
}

module.exports = { NOT_FOUND_LOCALS, pageNotFoundError, assertPageInRange };
