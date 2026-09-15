const fs = require("fs-extra");
const path = require("path");
const config = require("config");
const mustache = require("mustache");
const { marked } = require("marked");
const html = require("./html");

const viewsDirectory = path.join(__dirname, "../../views/templates");
const outputDirectory = path.join(config.views_directory, "templates");
const templatesSourceDirectory = path.join(__dirname, "../../templates/source");

const NAME_MAP = { cv: "CV" };

const categories = [
  {
    name: "Writing",
    slug: "blogging",
    templates: [
      "blog",
      "fieldnotes",
      "hypertext",
      "index",
      "journal",
      "keynote",
      "magazine",
      "notebook",
      "text",
      "wireframe",
      "zine",
    ],
  },
  {
    name: "Photos",
    slug: "photography",
    templates: ["album", "gallery", "links", "portfolio"],
  },
  {
    name: "Personal",
    slug: "personal",
    templates: [
      "blog",
      "cv",
      "fieldnotes",
      "hypertext",
      "index",
      "journal",
      "keynote",
      "notebook",
      "portfolio",
      "profile",
      "text",
      "wireframe",
      "zine",
    ],
  },
  {
    name: "Organizations",
    slug: "organizations",
    templates: ["documentation", "event", "organization"],
  },
  {
    name: "Portfolio",
    slug: "portfolio",
    templates: ["album", "cv", "gallery", "portfolio", "profile", "studio"],
  },
  {
    name: "Editorial",
    slug: "editorial",
    templates: ["blog", "fieldnotes", "journal", "magazine", "text", "zine"],
  },
  {
    name: "Notes",
    slug: "notes",
    templates: ["fieldnotes", "hypertext", "index", "journal", "keynote", "links", "notebook"],
  },
];

const cdn = () => (text, render) => `{{#cdn}}${render(text)}{{/cdn}}`;

const DEFAULT_FOLDER_PREVIEW = `Pages
  About.txt
  Contact.docx
  Home.txt
  Link.webloc
  Secret.txt
Posts`;

const MAX_VISIBLE_FOLDERS_PER_LEVEL = 3;

const isDotfile = (name = "") => name.startsWith(".");

const sanitizePreviewTree = (nodes = []) => {
  const sanitizedNodes = nodes
    .filter((node) => node && !isDotfile(node.name))
    .map((node) => {
      const sanitizedNode = {
        ...node,
        children: sanitizePreviewTree(node.children || []),
      };

      return sanitizedNode;
    });

  let visibleFolderCount = 0;

  for (const node of sanitizedNodes) {
    if (node.type !== "directory") continue;

    visibleFolderCount += 1;
    if (visibleFolderCount > MAX_VISIBLE_FOLDERS_PER_LEVEL) {
      node.collapsed = true;
      node.children = [];
    }
  }

  return sanitizedNodes;
};

const formatTreeForPreview = (nodes = [], indent = "") =>
  nodes
    .map((node) => {
      const collapse = node.collapsed ? "" : "";
      const line = `${indent}${node.name}${collapse}`;
      const children = (node.children || []).length
        ? `\n${formatTreeForPreview(node.children, `${indent}  `)}`
        : "";
      return line + children;
    })
    .join("\n");

const loadManifest = () => {
  const manifestPath = path.join(config.views_directory, "folders", "manifest.json");
  if (!fs.existsSync(manifestPath)) return {};
  return fs.readJsonSync(manifestPath);
};

const loadPartials = async () => {
  const partials = {};

  const localPartials = (await fs.readdir(viewsDirectory)).filter((file) => file.endsWith(".html"));
  for (const file of localPartials) {
    const key = file.replace(/\.html$/, "");
    partials[key] = await fs.readFile(path.join(viewsDirectory, file), "utf8");
  }

  const breadcrumbs = path.join(__dirname, "../../views/partials/breadcrumbs.html");
  if (await fs.pathExists(breadcrumbs)) {
    partials.breadcrumbs = await fs.readFile(breadcrumbs, "utf8");
  }

  return partials;
};

const loadTemplates = async () => {
  const items = (await fs.readdir(templatesSourceDirectory)).filter((i) => !i.startsWith(".") && !i.endsWith(".md"));

  const templates = [];

  for (const slug of items) {
    const packagePath = path.join(templatesSourceDirectory, slug, "package.json");
    if (!(await fs.pathExists(packagePath))) continue;

    const pkg = await fs.readJson(packagePath);
    templates.push({
      name: NAME_MAP[slug] || slug[0].toUpperCase() + slug.slice(1),
      slug,
      demo_folder: (pkg.locals && pkg.locals.demo_folder) || "david",
      source: `https://github.com/davidmerfield/Blot/tree/master/app/templates/source/${slug}`,
    });
  }

  return templates.sort((a, b) => a.slug.localeCompare(b.slug));
};

const renderView = async (viewName, data, destination, partials) => {
  const template = await fs.readFile(path.join(viewsDirectory, viewName), "utf8");
  const rendered = mustache.render(template, data, partials);
  const transformed = await html(rendered, { path: destination });
  await fs.outputFile(path.join(outputDirectory, destination), transformed);
};

module.exports = async () => {
  const manifest = loadManifest();
  const partials = await loadPartials();
  const templates = await loadTemplates();

  await renderView(
    "index.html",
    {
      allTemplates: templates,
      categories,
      cdn,
    },
    "index.html",
    partials
  );

  for (const category of categories) {
    await renderView(
      "index.html",
      {
        category: category.slug,
        categories: categories.map((c) => ({ ...c, selected: c.slug === category.slug ? "selected" : "" })),
        allTemplates: templates.filter((t) => category.templates.includes(t.slug)),
        cdn,
      },
      `for-${category.slug}/index.html`,
      partials
    );
  }

  for (const template of templates) {
    const zip_name = `${template.demo_folder}.zip`;
    const zip = `/folders/${zip_name}`;
    const readmePath = path.join(templatesSourceDirectory, template.slug, "README");

    // Because build runs on CI on Github actions, config.host is not available so we delegate to the template to replace it with the host
    // at render time.
    const templateData = {
      ...template,
      preview_host:
        template.demo_folder === template.slug
          ? `${template.demo_folder}.{{host}}`
          : `preview-of-${template.slug}-on-${template.demo_folder}.{{host}}`,
      zip,
    };

    templateData.preview = `${config.protocol}${templateData.preview_host}`;

    if (await fs.pathExists(readmePath)) {
      templateData.README = marked.parse(await fs.readFile(readmePath, "utf8"));
    }

    const treeEntry = manifest[template.demo_folder] || {};
    const previewTree = sanitizePreviewTree(treeEntry.displayTree || treeEntry.fullTree || []);
    templateData.folder_preview = previewTree.length
      ? formatTreeForPreview(previewTree)
      : DEFAULT_FOLDER_PREVIEW;

    await renderView("template.html", { template: templateData, cdn }, `${template.slug}/index.html`, partials);
  }
};

module.exports.sanitizePreviewTree = sanitizePreviewTree;
module.exports.formatTreeForPreview = formatTreeForPreview;
module.exports.loadTemplates = loadTemplates;
