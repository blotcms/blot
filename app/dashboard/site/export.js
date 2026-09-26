const config = require("config");
const express = require("express");
const Export = express.Router();
const archiver = require('archiver');
const path = require("path");
const fs = require('fs-extra');
const assets = require("storage/assets");
const Template = require("models/template");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

Export.get("/", function (req, res) {
    res.locals.breadcrumbs.add("Export");
    res.render("dashboard/site/export");
});

Export.get("/download", async function (req, res, next) {
  try {
      // Read from Redis before any header is set or byte is piped, so an
      // outage can still become a 503 rather than a truncated zip
      const templates = await getAllTemplates(req.blog.id);

      // create a zip file of the template on the fly and send it to the user
      // then in a streaming fashion, append the files to the zip file
      // then send the zip file to the user
      res.setHeader('Content-Disposition', `attachment; filename=${req.blog.handle}-export.zip`);
      res.setHeader('Content-Type', 'application/zip');

      const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
      });

      // Handle errors
      archive.on('error', function(err) {
          if (res.headersSent) {
              console.log('Error while sending zip file to the user', err);
          } else {
              res.status(400).send({error: err.message});
          }
      });

      // Pipe the archive data to the response.
      archive.pipe(res);

      // walk the static folder and add all the files to the archive
      // inside a subfolder called 'static' in a recursive, async way
      const staticFolder = assets.path(req.blog.id);

      // walk the blog folder and add all the files to the archive
      // inside a subfolder called 'folder' in a recursive, async way
      const blogFolder = path.join(config.blog_folder_dir, req.blog.id);

      // use chokidar to recursively identify all the files in the blog folder
      // and then add them to the archive and stop the watcher

      // create a json file with path 'blog.json' to the archive which contains req.blog  
      const blogJSON = JSON.stringify(req.blog, null, 2);
      archive.append(blogJSON, { name: 'blog.json' });

      // iterate over all of the blog's templates and add them to the archive in a file called 'templates.json'
      
      try {
          await recursiveZip(blogFolder, archive, 'folder');
          await recursiveZip(staticFolder, archive, 'static');
      } catch (err) {
          console.log('error', err);
          if (res.headersSent) {
              console.log('Error while sending zip file to the user', err);
          } else {
              res.status(400).send({error: err.message});
          }
      }


      for (const template of templates) {
          await addTemplate(template.id, archive);
      }

      // Finalize the archive
      archive.finalize();
  } catch (err) {
    // The zip headers were set before Redis was touched; drop them so the
    // error page is not offered as a download
    if (!res.headersSent) {
      res.removeHeader("Content-Disposition");
      res.removeHeader("Content-Type");
    }
    next(err);
  }
});

const getAllTemplates = async (blogID) => {
    return new Promise((resolve, reject) => {
        Template.getTemplateList(blogID, function (err, templates) {
            if (err) return reject(err);
            // filter out templates which are not owned by the blog
            const blogTemplates = templates.filter(t => t.owner === blogID);
            resolve(blogTemplates);
        });
    });
}

const addTemplate = async (templateID, archive) => {
    return new Promise((resolve, reject) => {
        Template.getAllViews(templateID, function (err, views, template) {
            
            if (err || !views || !template) 
                return reject(err || new Error('No views or template found'));

            // Add the views to the archive
            for (const view in views) {
                if (!views[view].content) continue;
                archive.append(views[view].content, { name: 'templates/' + template.slug + '/' + view });
            }
    
            // append the template JSON as 'package.json'
            archive.append(JSON.stringify(template, null, 2), { name: 'templates/' + template.slug + '/package.json' });
            
            resolve();
        });
    });
};
  

const recursiveZip = async (dir, archive, destinationSubdirectory) => {

    const files = await fs.readdir(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fs.stat(filePath);

        if (stats.isFile()) {
            const destinationPath = path.join(destinationSubdirectory, file);
            archive.append(fs.createReadStream(filePath), { name: destinationPath });
        } else if (stats.isDirectory()) {
            const subdirectory = path.join(destinationSubdirectory, file);
            await recursiveZip(filePath, archive, subdirectory);
        }
    }
};


const Entries = require("models/entries");
const mustache = require("mustache");
const moment = require("moment");

require("moment-timezone");

const loadEntries = (blogID) => {
    return new Promise((resolve, reject) => {
        Entries.getAll(blogID, { onError: reject }, function (allEntries) {
            resolve(allEntries);
        });
    });
}



Export.get('/wordpress', async function (req, res, next) {
  try {

      const allEntries = await loadEntries(req.blog.id);

      allEntries.forEach((entry, index) => {
          entry.absoluteURL =
          req.blog.pretty.url +
          entry.url.split("/").map(encodeURIComponent).join("/");

          entry.xmlDate = moment.utc(entry.dateStamp).tz(req.blog.timeZone).format('ddd, DD MMM YYYY HH:mm:ss ZZ');
          // Stored HTML has build-time-baked %%BLOT_CDN%% links (see
          // app/build/plugins/folderAssets); this path bypasses
          // blog/render/middleware.js, which normally resolves them.
          entry.xmlBody = entry.body.split(BLOT_CDN_TOKEN).join(config.cdn.origin);

          entry.tags = entry.tags.map(tag => {
              return { tag };
          });
      });

      const locals = {
          blog: req.blog,
          blogURL: req.blog.pretty.url,
          handle: req.blog.handle,
          allEntries,
          updatedXmlDate: allEntries.length ? allEntries[0].xmlDate : moment().format('ddd, DD MMM YYYY HH:mm:ss ZZ')
      };  

      const result = mustache.render(XML, locals);

      // the response should initiate a download of the XML file
      res.setHeader('Content-Disposition', `attachment; filename=${req.blog.handle}-export.xml`);
      res.setHeader('Content-Type', 'application/xml');
      res.send(result);
  } catch (err) {
    next(err);
  }
});


const XML = `
<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title><![CDATA[ {{{blog.title}}}]]></title>
  <link>{{{blogURL}}}</link>
  <description><![CDATA[ {{{title}}} ]]></description>
  <pubDate>{{updatedXmlDate}}</pubDate>
  <language>en-US</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>{{{blogURL}}}</wp:base_site_url>
  <wp:base_blog_url>{{{blogURL}}}</wp:base_blog_url>
  <wp:author>
    <wp:author_id>1</wp:author_id>
    <wp:author_login><![CDATA[{{{handle}}}]]></wp:author_login>
    <wp:author_display_name><![CDATA[{{{title}}}]]></wp:author_display_name>
  </wp:author>
  {{#allEntries}}
  <item> 
    <title><![CDATA[ {{{title}}} ]]></title>
    <link>{{{absoluteURL}}}</link>
    <pubDate>{{xmlDate}}</pubDate>
    <wp:post_date>{{xmlDate}}</wp:post_date>
    <dc:creator><![CDATA[ {{{blog.title}}}]]></dc:creator>
    <guid isPermaLink="true">{{{absoluteURL}}}</guid>
    <description></description>    
    <content:encoded><![CDATA[ {{{xmlBody}}} ]]></content:encoded>
    <wp:post_name><![CDATA[{{name}}]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    {{#tags}}
    <category domain="category" nicename="{{tag}}"><![CDATA[{{tag}}]]></category>
    <category domain="post_tag" nicename="{{tag}}"><![CDATA[{{tag}}]]></category>
    {{/tags}}
  </item>
  {{/allEntries}}
</channel>
</rss>
`;

module.exports = Export;