// The one signal for "no such file", whatever the backend. It carries
// code "ENOENT" so the existing err.code checks keep working.
class NotFoundError extends Error {
  constructor(message) {
    super(message || "Not found");
    this.name = "NotFoundError";
    this.code = "ENOENT";
    this.status = 404;
  }
}

module.exports = { NotFoundError };
