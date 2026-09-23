const fs = require("fs-extra");
const path = require("path");
const config = require("config");
const mustache = require("mustache");
const { marked } = require("marked");
const { execFileSync } = require("child_process");
const html = require("./html");
const renderFolder = require("../tools/finder/render_folder");

const viewsDirectory = path.join(__dirname, "../../views/templates");
const outputDirectory = path.join(config.views_directory, "templates");
const templatesSourceDirectory = path.join(__dirname, "../../templates/source");

const NAME_MAP = { cv: "CV" };

// Categories now deliberately mirror the Examples audience filters
// (Writers, Artists, Researchers, Photographers, Designers) rather than
// staying a separate "form" taxonomy - Developers has no template-form
// counterpart here, so it's linked to from Research instead. A template
// commonly belongs to more than one category.
const categories = [
  {
    name: "Writing",
    slug: "writing",
    templates: ["blog", "journal", "magazine", "text", "zine", "notebook", "fieldnotes", "index", "links"],
  },
  {
    name: "Art",
    slug: "art",
    templates: ["portfolio", "gallery", "album", "zine", "studio", "cv"],
  },
  {
    name: "Research",
    slug: "research",
    templates: ["documentation", "fieldnotes", "hypertext", "index", "links", "notebook", "keynote", "cv"],
  },
  {
    name: "Photography",
    slug: "photography",
    templates: ["album", "gallery", "portfolio", "event"],
  },
  {
    name: "Design",
    slug: "design",
    templates: ["portfolio", "profile", "studio", "wireframe", "keynote", "organization", "event", "cv"],
  },
];

// Cross-links from a template's category to the matching Examples
// audience filter. This is the connective tissue the marketing plan
// asks for, kept as links rather than merging the two catalogues
// outright - Design is the one category with no exact audience match
// of its own name, so it points at Designers same as the others.
const EXAMPLES_LINKS = {
  writing: [{ slug: "writers", label: "Writers" }],
  art: [{ slug: "artists", label: "Artists" }],
  research: [
    { slug: "researchers", label: "Researchers" },
    { slug: "developers", label: "Developers" },
  ],
  photography: [{ slug: "photographers", label: "Photographers" }],
  design: [{ slug: "designers", label: "Designers" }],
};

const sidebarsDirectory = path.join(viewsDirectory, "sidebars");

// A category's sidebar is a standalone HTML fragment (see
// app/views/templates/sidebars/) so it can be edited without touching
// this build script. Optional per category - a slug with no matching
// file (or the unfiltered "All" page) simply gets no sidebar.
const sidebarForCategory = (slug) => {
  const sidebarPath = path.join(sidebarsDirectory, `${slug}.html`);
  if (!fs.existsSync(sidebarPath)) return null;
  return fs.readFileSync(sidebarPath, "utf8");
};

const relatedExampleCategoriesForTemplate = (slug) => {
  const seen = new Map();

  for (const category of categories) {
    if (!category.templates.includes(slug)) continue;
    for (const link of EXAMPLES_LINKS[category.slug] || []) {
      if (seen.has(link.slug)) continue;
      seen.set(link.slug, { ...link, href: `/examples/${link.slug}` });
    }
  }

  return [...seen.values()];
};

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

const folderPreviewForTemplate = (template, manifest = loadManifest()) => {
  const treeEntry = manifest[template.demo_folder] || {};
  const previewTree = sanitizePreviewTree(treeEntry.displayTree || treeEntry.fullTree || []);

  return previewTree.length
    ? formatTreeForPreview(previewTree)
    : DEFAULT_FOLDER_PREVIEW;
};

const folderHTMLForTemplate = (template, manifest) =>
  renderFolder(
    folderPreviewForTemplate(template, manifest),
    ["folder", "home-folder-preview"],
    template.name
  );

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

// "Latest" sorting is driven by each template's most recent commit,
// so it stays accurate without a value anyone has to remember to update.
const REPO_ROOT = path.join(__dirname, "../../../");

const getLatestCommitTimestamp = (dir) => {
  try {
    const output = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", dir],
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim();

    if (!output) return 0;
    return parseInt(output, 10) * 1000;
  } catch (e) {
    // No .git directory (e.g. a production image built without history)
    // or git isn't installed — fall back to "unknown", sorted last.
    return 0;
  }
};

const formatUpdatedLabel = (msAgo) => {
  if (!Number.isFinite(msAgo) || msAgo < 0) return null;

  const DAY = 24 * 60 * 60 * 1000;
  const days = Math.floor(msAgo / DAY);

  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
};

const loadTemplates = async () => {
  const items = (await fs.readdir(templatesSourceDirectory)).filter((i) => !i.startsWith(".") && !i.endsWith(".md"));

  const templates = [];

  for (const slug of items) {
    const packagePath = path.join(templatesSourceDirectory, slug, "package.json");
    if (!(await fs.pathExists(packagePath))) continue;

    const pkg = await fs.readJson(packagePath);
    const latest_commit = getLatestCommitTimestamp(
      path.join(templatesSourceDirectory, slug)
    );

    templates.push({
      name: NAME_MAP[slug] || slug[0].toUpperCase() + slug.slice(1),
      slug,
      demo_folder: (pkg.locals && pkg.locals.demo_folder) || "david",
      source: `https://github.com/blotcms/blot/tree/master/app/templates/source/${slug}`,
      // Estimated for now (see package.json) — there's no usage tracking
      // to derive this from yet.
      popularity: typeof pkg.popularity === "number" ? pkg.popularity : 0,
      latest_commit,
      updated_label: formatUpdatedLabel(Date.now() - latest_commit),
    });
  }

  const manifest = loadManifest();

  return templates
    .sort((a, b) => b.latest_commit - a.latest_commit)
    .map((template) => ({
      ...template,
      folder_preview: folderPreviewForTemplate(template, manifest),
      folder_html: folderHTMLForTemplate(template, manifest),
    }));
};

const renderView = async (viewName, data, destination, partials) => {
  const template = await fs.readFile(path.join(viewsDirectory, viewName), "utf8");
  const rendered = mustache.render(template, data, partials);
  const transformed = await html(rendered, { path: destination });
  await fs.outputFile(path.join(outputDirectory, destination), transformed);
};

const listRelativeFiles = async (root) => {
  if (!(await fs.pathExists(root))) return [];
  const files = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) files.push(path.relative(root, abs));
    }
  };
  await walk(root);
  return files;
};

const pruneEmptyDirectories = async (root) => {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    await pruneEmptyDirectories(abs);
    const left = await fs.readdir(abs).catch(() => null);
    if (left && left.length === 0) await fs.remove(abs);
  }
};

module.exports = async () => {
  const manifest = loadManifest();
  const partials = await loadPartials();
  const templates = await loadTemplates();

  // The generic copier in build/index.js does not publish anything under
  // templates/: the initial pass returns immediately, and the watcher only
  // calls this function. Copy every source file it does not bake (live views
  // such as search.html and fonts.html, plus partials). index.html is both
  // a source file and a baked output, so it is not copied raw — renderView
  // below replaces the previous baked page only after rendering succeeds.
  // fs.copy merges, so also delete published files that are no longer in
  // source and are not a baked output. Otherwise a removed view stays
  // reachable and the next cache save keeps it.
  const bakedOutputs = [
    "index.html",
    ...categories.map((category) => path.join(`for-${category.slug}`, "index.html")),
    ...templates.map((template) => path.join(template.slug, "index.html")),
  ];
  const sourceFiles = await listRelativeFiles(viewsDirectory);
  const keep = new Set([
    ...sourceFiles.filter((rel) => rel !== "index.html"),
    ...bakedOutputs,
  ]);

  await fs.ensureDir(outputDirectory);
  for (const rel of await listRelativeFiles(outputDirectory)) {
    if (!keep.has(rel)) await fs.remove(path.join(outputDirectory, rel));
  }
  await pruneEmptyDirectories(outputDirectory);

  await fs.copy(viewsDirectory, outputDirectory, {
    filter: (src) => path.relative(viewsDirectory, src) !== "index.html",
  });

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
        sidebar: sidebarForCategory(category.slug),
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

    templateData.folder_preview = folderPreviewForTemplate(template, manifest);
    templateData.relatedExampleCategories = relatedExampleCategoriesForTemplate(template.slug);

    await renderView("template.html", { template: templateData, cdn }, `${template.slug}/index.html`, partials);
  }
};

module.exports.sanitizePreviewTree = sanitizePreviewTree;
module.exports.formatTreeForPreview = formatTreeForPreview;
module.exports.loadTemplates = loadTemplates;
module.exports.categories = categories;
