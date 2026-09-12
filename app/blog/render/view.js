const Blog = require("models/blog");
const blogDefaults = require("models/blog/defaults");
const renderMiddleware = require("./middleware");
const { getMetadata, getBlog } = require("../lib/models");

/**
 * Render a view for CDN manifest generation
 * @param {string} templateID - The template ID
 * @param {string} viewName - The name of the view to render
 * @returns {Promise<string|null>} - The rendered output or null if error/missing
 */
async function renderView(templateID, viewName) {
  try {
    const metadata = await getMetadata(templateID);
    if (!metadata) {
      return null; // Missing metadata - skip in manifest
    }

    if (!metadata.owner) {
      return null; // Missing owner - skip in manifest
    }

    const ownerID = metadata.owner;

    // Fetch or create blog object
    let blogData;
    if (ownerID === "SITE") {
      blogData = { id: "SITE" };
    } else {
      blogData = await getBlog({ id: ownerID });
      if (!blogData) {
        return null; // Missing blog - skip in manifest
      }
    }

    const blog = Blog.extend(Object.assign({}, blogDefaults, blogData));

    let renderedOutput = null;
    let renderError = null;

    const req = {
      blog: blog,
      preview: false,
      log: () => {},
      template: {
        locals: metadata.locals || {},
        id: templateID,
        cdn:
          metadata.cdn && typeof metadata.cdn === "object" ? metadata.cdn : {},
      },
      query: {},
      protocol: "https",
      headers: {},
    };

    const res = {
      locals: { partials: {} },
      header: () => {},
      set: () => {},
      send: (output) => {
        renderedOutput = output;
      },
      renderView: null, // Set by render middleware
    };

    await new Promise((resolve) => {
      renderMiddleware(req, res, (err) => {
        if (err) {
          renderError = err;
          return resolve();
        }
        resolve();
      });
    });

    if (renderError) {
      console.error(`Error rendering view ${viewName} for CDN:`, renderError);
      return null;
    }

    await new Promise((resolve) => {
      res.renderView(
        viewName,
        (err) => {
          // next callback - called on errors
          if (err) {
            if (err.code === "NO_VIEW") {
              // Missing view - skip in manifest (not an error)
              renderError = null;
            } else {
              renderError = err;
              console.error(`Error rendering view ${viewName} for CDN:`, err);
            }
          }
          resolve();
        },
        (err, output) => {
          // callback pattern - captures output directly
          if (err) {
            renderError = err;
            console.error(`Error rendering view ${viewName} for CDN:`, err);
          } else {
            renderedOutput = output;
          }
          resolve();
        }
      );
    });

    if (renderError) {
      return null;
    }

    if (renderedOutput === undefined || renderedOutput === null) {
      return null;
    }

    return typeof renderedOutput === "string"
      ? renderedOutput
      : String(renderedOutput);
  } catch (err) {
    console.error(`Error in renderView for ${viewName}:`, err);
    return null;
  }
}

module.exports = renderView;
