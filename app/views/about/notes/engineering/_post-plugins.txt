## Plugins

I want plugins to work no matter what. If you have checked the plugin and filled in valid info, it should ALWAYS works, no matter your template.

Plugins can:
- modify an entry
  - before turned into HTML
  - after turned into HTML
- modify the CSS of a blog
- modify the JS of a blog

Plugin
  title: string
  id: string
  formHTML: string
  description: string
  hasJS: bool
  hasCSS: bool
  render: function
  options: object
  enabled: bool

