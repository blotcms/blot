# Templates to create


Blog
Portfolio
Photo
Magazine
Reference
Documentation
CV / Personal

Useful fiddles:

Pure css gradually collapsing nav:
  useful for tag lists on archives page?
  https://codepen.io/kylegach/pen/RRkpEL

Pure css collapsing hamburger nav:
  https://jsfiddle.net/ejg2sfoc/5/

Template selection
- archive - optimized for an archive of photos, links, quotes
  index shows big grid of posts
  type is sans-serif (plex sans)
  possible source folders:
  http://filingcabinet.blot.im/

- feed (default) - general purpose
  index shows stream of posts truncated
  type is sans-serif (system? http://lunchtype.com?)
  possible source folders:
  - https://www.svenseebeck.com/
  - https://www.baty.blog/
  - https://www.inthemargins.ca/
  references:
  https://craigmod.com/roden/021/
  https://cargocollective.com/andromeda/Niobium-crystals-with-cube
  
- photos - optimized for a photoblog
  index shows medium grid posts in columns but not rows
  type is sans-serif (system? https://fonts.floriankarsten.com/space-grotesk?)
  I like the placeholder images: http://nicholascope.com/
  possible source folders: 
  - https://ylukem.com/

- essays - optimized for longform essays
  index shows title list of posts, perhaps teaser
  type is serif (Charter)
  possible source folders:
  - https://www.schuth.xyz/archives
  - https://chrbutler.com/about
  - http://cinebloc.blot.im/
  
- portfolio - optimized for a portfolio of work
  index shows medium-sized grid of posts in columns and rows
  type is sans-serif (? Open sans ?)
  Tell [Andrew](https://mail.google.com/mail/u/0/#inbox/FMfcgxvzLhjbTcwppvpnDchFmgNPDdWQ) and [Laura](https://mail.google.com/mail/u/1/#inbox/1658708331a8d28a)

- magazine - optimized for a magazine
  index shows mixture of post previews
  type is serif (Charter)

- code - optimized for developers
  index shows ?
  sidebar has subtraction-style list of other titles
  type is monospace (Plex mono)

# Spec
- all themes must support a 'landing page' modification nicely
- feed, archive, essays, portfolio, magazine must be optimized for code
- all themes must be colorblind, with goal to add a color customization layer
- Don't think about Blot developers in any way, produce separate simple templates for them

Run templates through [lighthouse](https://web.dev/measure/) and [observatory](https://observatory.mozilla.org/)

# Adding a new template

Create a new folder in this directory, name it whatever you want.

# Tests

Do not add test files (e.g. app/templates/tests/<template-name>-*.js) that
assert on a single template's source via string/regex matching against its
HTML, CSS or JS. These tests couple to incidental implementation details, do
not verify actual rendered/visual output, and break or go stale the moment
the template is next edited. Fix and verify template changes by rendering
and inspecting the template (e.g. via the screenshots workflow), not by
adding a template-specific spec file. If you need automated coverage,
prefer real end-to-end checks in app/templates/tests/index.js that apply
across all templates.

# About

I struggled initially with theme design because I was trying to design a themes for all blogs and all material. I think the major things which complicate designs. Some sites have many posts (thousands) and are updated frequently. Some sites have few posts (ten) and are updated infrequently. The quantity of posts has a big effect on the design of the archive page in particular.

Some sites post mostly text, some mostly images, some a mix. This affects the design of the index page. For example, should you show a stream of posts in full on the index page? Or just a list of links to view the full post? Or perhaps a truncated preview of the post?

I would like to produce a few grid based themes for sites which post mostly photos. Some of cargo's grid ideas are worth exploring.

# Fitting the form to the content

Ultimately I must bear in mind a respect for content. I am trying to design a frame for this content to hang on and it is important to avoid the tempation of designing for the frame, instead of the stuff inside (I have no ownership of that so it's hard to be proud of it).

Is cropping thumbnails justifiable? In my mind it seems like this might fall into the category of trying to make the content fit the form, than the other way around. But perhaps that isn't a bad thing? If I want to see a list of articles, perhaps formatting the thumbnail in a particular way is justified.

# Plagiarism 

I've also been struggling with lifting things wholesale from a particular spot. I have been looking at Techcrunch.com far too regularly when making the design for the upcoming magazine theme, for example. This is bad.


Find good source of material, ideally on Blot like this [source for theme content](http://cinebloc.blot.im/)
- Interesting way to find images matching colors: https://artsexperiments.withgoogle.com/artpalette/colors/ffffff-fcfcfc-ffffff-ffffff-ffffff


Improving the templating code

Right now blot fetches a load of information, depending on each route, and uses that to fill a template.

My goal at the moment is to change the code so Blot only fetches information from the database used by the template itself. 

Thankfully mustache exposes 

I will need to remove current metadata about the partial (isPartial) 

When I fetch the partials, I need to check if they themselves have partials, if so, then refetch.

# To create a new theme:

Create a new folder in this directory, name it whatever you want.


I will need a script to write out existing templates in new format


# Revisiting templates

blogs/{{id}}/themes/{{default}}

set blog.template to {{default}} ?

create new Template "Foo bar" in blogs/{{id}}/themes/Foo bar

editing will just save the files directly

can rename the template -> copy folder, set blog.template to new folder, delete old folder.

we could load a users template into memory instead? but what about static files? eh avoid this optimization for now.

we only need to serve-static the non-css and js files in /assets?

on enable local-editing

 theme / theme.json etc...

on enable local editing for multiple

 theme / foo
 theme / bar





Templates should be copy/pastable between blogs

Installation of custom template should be as easy as

'Create folder Template:

Blot themes are derived from a folder of HTML fragments.

If you want to just a tweak a thing or two with an existing template, it's not really neccessary to read all the nonsense below. Just create a clone of the template you'd like to modify, then open it in the template editor. It should be self-explanatory.

Blot uses Mustache to render templates. Please read its documentation. It is important you understand the meaning of a template, a partial and a view.

Blot themes are a collection of **templates** and **partials** which are rendered with a **view** containing variables from your blog.

**Templates** represent the layout for a given page on your blog. **Partials** represent small fragments of a template that repeat across your site like a menu. The **view** is a collection of variables, structured as JSON, which is used to render your template.

Blot generates the view for a template based on a few inputs:

- The tags used in the template
- Local variables specified in your theme's configuation file
- Properties from your blog (e.g. title, profile picture)
- Variables derived from the template's route

Templates, partial source, and configured template values are public. They may
be inspected through a public blog page's JSON render context with `?debug=true`
or `?json=true`. Only place values in template configuration that are safe for
anonymous disclosure; application secrets must remain outside template locals.

## Configuration file

You can use the configuration file to declare template-specific locals and partial templates. Blot's themes use this feature to customize the <title> and description tags of each template.

## Templates

Blot themes inherit a handful of templates and options by default:

- feed.rss (for your blog's RSS feed)
- robots.txt
- sitemap.xml

I assume you probably won't want to modify them, but you can override these templates yourself by creating the corresponding file in your theme's /templates directory.

The template site.xml would be rendered at the url example.com/site.xml. The template foo.html would be rendered at the url example.com/foo. You can adjust the url for a given template. The exceptions are entries.html, entry.html and error.html. Error.html is used for all routes which return nothing. You can override this in your theme's configuration file.

## Partials

If a partial file is called 'footer.html', blot will make it available to views like this:

```
{{> footer}}
```

## Routing

With the exception of entry.html and entries.html, you control the routes
If a view file is called 'archives.html', by default Blot will mount it to /archives You can customize the route used for the view in theme.json.

## Assets

Files in the /assets folder are served. JavaScript and CSS files are minified and rendered like templates. This means you can use variables from your blog or your template inside scripts and stylesheets:

```
body {
  background: {{background_color}};
}
```

Everything else is served as-is. This folder is useful for template-specific images, font-files and that kinds of thing.




stick files inside? indicate selected template with leading *? How does blot know which template to use? Do user templates always exist in Blog folder?

move _assets to .assets or .blot ?
  image cache cannot look up images embedded in doc files
  since they're outside the blot folder

put templates inside this folder

Rewrite Templates
 - Add way to edit a color variable, select an option etc...
 - theme should be a set of options for the color picker...
 - Migrate these currently-global settings to template level:
    date presentation
    hide/show date
    entries per page
 - Store view name should include file extension...
 - Expose errors on design page.







I need to make sure Blot can render 100 pages / second.

Based on current usage, that reflects double the avg. load for 10k blogs.

the render module is currently a shitshow

each template

ENTRIES SHOULD NOT BE VIEWS
  they should not be embeddable -> use albums for similar features...

LOCALS SHOULD NOT CONTAIN LOCALS
  migrate page title and page description to hard coding in template

EACH VIEW SHOULD HAVE A FULL LIST OF PARTIALS & LOCALS


add 'default' template views which templates inherit but can override?

add 'default' partials which templates inherit?

  e.g. {{view.name}} - {{blog.title}}

e.g. feed.rss, sitemap.xml, robots.txt


* / template / default

no template info stored in db

everything stored on disk?

---


template = read(...) ;

mustache.parse(template);

... fetch partials and parse them too
... extract locals from view and all partials
... load locals

mustache.render(template, view);

---

store full list of locals and paths to partials against each template path?


---
first_entry:
  source: posts
  length: 1

next_entries:
  source: posts
  except: first_entry
  length: 4

remaining_entries:
  source:posts
  except: 
    - first_entry
    - next_entries
  length: 10
---

{{#first}}

{{/posts}}

--------------------------

{{> header}}

{{#entries}}

  {{{html}}}

{{/entries}}

{{#pagination}}

  {{#next}}
    <a href="{{{url}}}">Next page</a>
  {{/next}}

  {{#previous}}
    <a href="{{{url}}}">Previous page</a>
  {{/previous}}

{{/pagination}}

{{> footer}}
