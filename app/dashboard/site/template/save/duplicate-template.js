const createTemplateWithUniqueName = require("./create-template-with-unique-name");

// Making room for ' copy' in a name whose slug already fills the 30
// characters an id is derived from, and keeping the stored slug in step with
// that id, are both handled by createTemplateWithUniqueName.

const COPY_NAME_PATTERN = /^(.*?)(?: copy(?: (\d+))?)$/;
const COPY_SLUG_PATTERN = /^(.*?)(?:-copy(?:-(\d+))?)$/;

function parseCopyName(name) {
  const match = (name || "").trim().match(COPY_NAME_PATTERN);

  if (match) {
    return {
      base: match[1].trim(),
      counter: match[2] ? parseInt(match[2], 10) : 1,
    };
  }

  return {
    base: (name || "").trim(),
    counter: 1,
  };
}

function parseCopySlug(slug) {
  const match = (slug || "").match(COPY_SLUG_PATTERN);

  if (match) {
    return {
      base: match[1],
      counter: match[2] ? parseInt(match[2], 10) : 1,
    };
  }

  return {
    base: slug || "",
    counter: 1,
  };
}

async function duplicateTemplate({ owner, template }) {
  if (!template || !template.id) {
    throw new Error("A template is required to duplicate");
  }

  if (!owner) {
    throw new Error("An owner is required to duplicate a template");
  }

  const { base: nameBase, counter: nameCounter } = parseCopyName(template.name);
  // Only the counter: the slug now follows whatever name we settle on
  const { counter: slugCounter } = parseCopySlug(template.slug);

  return createTemplateWithUniqueName({
    owner,
    // The base is the name without ' copy'. The suffix is added by
    // formatAttempt, so making room for it never trims it away and leaves a
    // copy which does not say that it is one.
    name: nameBase,
    formatAttempt: (base, counter) =>
      counter > 1 ? `${base} copy ${counter}`.trim() : `${base} copy`.trim(),
    cloneFrom: template.id,
    // 'Original copy 3' starts counting from 3, so the next free name is 4
    startCounter: Math.max(nameCounter, slugCounter, 1),
    exhaustedMessage: "Unable to duplicate template after multiple attempts",
  });
}

module.exports = duplicateTemplate;
module.exports._internal = {
  parseCopyName,
  parseCopySlug,
};
