const fs = require("fs-extra");
const config = require("config");
const yaml = require("yaml");
const cheerio = require("cheerio");
const mustache = require("mustache");

const rootDirectory = config.blot_directory + "/app";
const toolsDirectory = rootDirectory + "/views/how/tools";
const outputDirectory = config.views_directory + "/how/tools";
const html = require("./html");
// Returns mustache code that will be replaced with a CDN URL
const cdn = () => (text, render) => '{{#cdn}}' + render(text) + '{{/cdn}}';

const renderTemplate = async (name, data, destination) => {
  const template = await fs.readFile(toolsDirectory + "/" + name, "utf8");
  const result = await html(mustache.render(template, data));
  await fs.outputFile(outputDirectory + "/" + (destination || name), result);
};

const fetch = require("node-fetch");

const fetchIcon = async (link, name, icon) => {
  const existingIcon = fs
    .readdirSync(toolsDirectory + "/icons")
    .find(f => f.startsWith(name + "."));

  if (existingIcon) {
    return "/icons/" + existingIcon;
  }

  // load the HTML at the link and determine the icon
  const response = await fetch(link);

  if (!response.ok) {
    console.log("Failed to fetch", link);
    return null;
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const { hostname, protocol } = new URL(link);

  icon = icon ||
    $("link[rel='apple-touch-icon']").attr("href") ||
    $("link[rel='shortcut icon']").attr("href") ||
    $("link[rel='SHORTCUT ICON']").attr("href") ||
    $("link[rel='icon']").attr("href") ||
    protocol + "//" + hostname + "/favicon.ico";

  // Resolve relative icon URLs against the page URL before downloading.
  if (!icon.startsWith("data:")) icon = new URL(icon, link).href;

  // we already have a data URL
  if (icon.startsWith("data:")) {
    const iconExtension = icon.split(";")[0].split("/")[1];
    const iconPath = toolsDirectory + "/icons/" + name + "." + iconExtension;
    const data = icon.split(",")[1].replace(/%22/g, '"');
    const iconBuffer = Buffer.from(data, "base64");
    //
    await fs.outputFile(iconPath, iconBuffer);

    return "/icons/" + name + "." + iconExtension;
  }

  try {
  const iconResponse = await fetch(icon);

  if (!iconResponse.ok) {
    console.log("Failed to fetch icon", icon);
    return null;
  }

  const iconBuffer = await iconResponse.buffer();
  const iconExtension = icon.split(".").pop().split("?")[0];
  const iconPath = toolsDirectory + "/icons/" + name + "." + iconExtension;

  await fs.outputFile(iconPath, iconBuffer);

  return "/icons/" + name + "." + iconExtension;
  } catch (e) {
    console.log("Failed to fetch icon", icon);
    return null;
  }
};

const load = async relativePath => {
  try {
    return await fs.readFile(toolsDirectory + "/" + relativePath, "utf8");
  } catch (e) {}
  return "";
};

const main = async () => {

  // This directory contains only generated pages. Empty it before rebuilding
  // so deleted tools and categories cannot survive a watcher rebuild or a
  // restored cache refresh.
  await fs.emptyDir(outputDirectory);

  const categories = (await fs.readdir(toolsDirectory)).filter(
    f => f.indexOf(".") === -1 && f !== "icons" && f !== "README"
  );


  const result = { categories: [], tools: [] };

  for (const category of categories) {
    const description = await load(category + "/index.html");
    const $ = cheerio.load(description || "<p></p>");

    const title =
      $("h1").text() ||
      (category[0].toUpperCase() + category.slice(1)).replace(/-/g, " ");

    const tools = (
      await Promise.all(
        (await fs.readdir(toolsDirectory + "/" + category))
          .filter(f => f.indexOf(".") !== 0 && f !== "index.html")
          .map(async tool => await loadTool(category, tool))
      )
    ).sort((a, b) => b.updated - a.updated);

     // tools sorted by either popular then updated date
     const top_tools = tools.slice().sort((a, b) => {
        if (a.popular && b.popular) {
          return b.updated - a.updated;
        } else if (a.popular) {
          return -1;
        } else if (b.popular) {
          return 1;
        } else {
          return b.updated - a.updated;
        }
    }).slice(0, 6);

    result.categories.push({ title, description, slug: 'all-' + category, tools, top_tools });
    result.tools = result.tools.concat(tools);
  }

  // sort categories by the number of tools
  result.categories.sort((a, b) => b.tools.length - a.tools.length);

  result.tools.sort((a, b) => b.updated - a.updated);

  await renderTemplate("index.html", {...result, cdn});

  for (const category of result.categories) {
    await renderTemplate(
      "index.html",
      {
        categories: result.categories.map(c => {
          return { ...c, selected: c.slug === category.slug ? "selected" : "" };
        }),
        description: category.description,
        tools: category.tools,
        cdn,
        category
      },
      category.slug + "/index.html"
    );
  }

  for (const tool of result.tools) {
    await renderTemplate(
      "tool.html",
      {
        ...tool,
        cdn,
        category: result.categories.find(c => c.slug === tool.category),
        related: result.categories
          .find(c => c.slug === 'all-' + tool.category)
          .tools.filter(t => t.slug !== tool.slug)
          .slice(0, 3)
      },
      tool.slug + "/index.html"
    );
  }

  return result;

};

const parseYAML = html => {
  if (html.indexOf("---") === -1) return {};
  const parsed = yaml.parse(html.split("---")[1] || "");
  // lowercase all keys from parsed
  const result = {};
  for (const key in parsed) {
    result[key.toLowerCase()] = parsed[key];
  }

  return result;
};

const loadTool = async (category, tool) => {
  const html = await load(category + "/" + tool);
  const updated = new Date(
    (await fs.stat(toolsDirectory + "/" + category + "/" + tool)).mtime
  );

  const metadata = parseYAML(html);

  const $ = cheerio.load(html.replace(/---[\s\S]*?---/, ""));

  // sometimes the HTML file has YAML frontmatter inside '---' fencing

  const slug = tool.replace(".html", "");
  const title =
    $("h1").text() ||
    (slug[0].toUpperCase() + slug.slice(1)).replace(/-/g, " ");

    const subtitle = $("h2:first-of-type").text() || "";

  $("h1").remove();

  const result = {
    title,
    subtitle,
    category,
    html: $.html(),
    updated,
    slug,
    ...metadata
  };

  if (result.link) {
    result.icon = await fetchIcon(result.link, result.slug, result.icon);
    if (result.icon) {
      // copy the icon to the output directory
      await fs.copy(
        toolsDirectory + result.icon,
        outputDirectory + result.icon
      );
    } else {
      throw new Error("Failed to fetch icon for " + title);
    }
  }


  // transform specific properties
  if (result.platforms)
    result.platforms = result.platforms.split(",").map(p => {
      return { name: p.trim() };
    });

  if (result.files) {
    result.files = result.files.split(",").map(f => {
      return { name: f, slug: f.trim().toLowerCase().replace(/\s/g, "-") };
    });
  }

  return result;
};

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = main;
