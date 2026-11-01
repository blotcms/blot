// The errors the store throws. Each has a `code` so a caller can tell them
// apart without matching on messages.

class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

// A key, object or pack that isn't there
class NotFoundError extends StoreError {
  constructor(message) {
    super(message, "NOT_FOUND");
  }
}

// Bytes that cannot be what they should be: a truncated or damaged pack,
// index, delta or manifest. Never returned as data.
class CorruptError extends StoreError {
  constructor(message) {
    super(message, "CORRUPT");
  }
}

// An object bigger than the caller allowed to be held in memory
class TooLargeError extends StoreError {
  constructor(message) {
    super(message, "TOO_LARGE");
  }
}

// The cache has no room left for a reservation (see cache.reserve)
class NoRoomError extends StoreError {
  constructor(message) {
    super(message, "NO_ROOM");
  }
}

// The manifest changed since the caller read it, or isn't fit to be written
class StaleManifestError extends StoreError {
  constructor(message) {
    super(message, "STALE_MANIFEST");
  }
}

module.exports = {
  StoreError,
  NotFoundError,
  CorruptError,
  TooLargeError,
  NoRoomError,
  StaleManifestError,
};
