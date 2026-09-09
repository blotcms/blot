const makeSlug = require("helper/makeSlug");
const slugForName = require("models/template/util/slugForName");
const createTemplate = require("./create-template");
const { MAX_DEDUPLICATION_ATTEMPTS } = require("./constants");

// Template.create derives the id from makeSlug(name).slice(0, 30)
const MAX_SLUG_LENGTH = 30;

// A suffix appended to a name whose slug already fills those 30 characters
// leaves them unchanged, so every attempt derives the same id, collides
// again, and the retry loop burns all its attempts before giving up on a name
// which should simply have become 'name 2'.
//
// Room is made by trimming the base, never the formatted result: trimming the
// whole thing would eat the suffix first, so a duplicate would lose the word
// 'copy' that says what it is.
const withSuffix = (base, counter, formatAttempt) => {
  let trimmed = String(base).trim();

  // Nothing to protect — this attempt is the bare name
  if (formatAttempt(trimmed, counter) === trimmed) return trimmed;

  while (
    trimmed.length > 1 &&
    makeSlug(formatAttempt(trimmed, counter)).length > MAX_SLUG_LENGTH
  ) {
    trimmed = trimmed.slice(0, -1).trim();
  }

  return formatAttempt(trimmed, counter);
};

// Template.create() has no collision handling of its own: it returns an error
// with code EEXISTS when a template with the same derived ID already exists.
// Note the ID is derived from the *name*, not the slug, so callers which want
// the two to agree should pass a slug derived from the same name.
//
// `name` is the base a caller starts from, and formatAttempt turns it and the
// attempt number into the name to try. By default the first attempt is the
// base itself and later ones append a counter; duplication adds ' copy'.
// The slug always follows the name, so callers do not pass one.
const defaultFormatAttempt = (base, counter) =>
  counter > 1 ? `${base} ${counter}` : base;

async function createTemplateWithUniqueName ({
  owner,
  name,
  startCounter = 1,
  formatAttempt = defaultFormatAttempt,
  exhaustedMessage = "Unable to create a template with a unique name after multiple attempts",
  ...properties
}) {
  if (!owner) {
    throw new Error("An owner is required to create a template");
  }

  if (!name) {
    throw new Error("A name is required to create a template");
  }

  let counter = Math.max(startCounter, 1);
  let attemptName = withSuffix(name, 1, formatAttempt);
  let attempts = 0;

  while (attempts < MAX_DEDUPLICATION_ATTEMPTS) {
    attempts++;

    try {
      return await createTemplate({
        ...properties,
        owner,
        name: attemptName,
        slug: slugForName(owner, attemptName),
      });
    } catch (error) {
      if (
        error &&
        error.code === "EEXISTS" &&
        attempts < MAX_DEDUPLICATION_ATTEMPTS
      ) {
        counter = Math.max(counter, 1) + 1;
        attemptName = withSuffix(name, counter, formatAttempt);
        continue;
      }

      throw error;
    }
  }

  const err = new Error(exhaustedMessage);
  err.code = "EEXISTS";
  throw err;
}

module.exports = createTemplateWithUniqueName;
