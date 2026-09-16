require('./relativeDate.js');
require('./truncate.js');
require('./sync_status.js');
require('./instant.page.js');
require('./tagify.js');
require('./examples.js');
require('./home-folder-carousel.js');
require('./templates.js');
require('./questions-ask.js');
require('./questions-textarea.js');
require('./questions-edit.js');
require('./watch.js');

require('../../build/plugins/callouts/public.js');

// must come before copy-buttons.js so that the copy buttons are generated
require('./multi-lingual-code.js');

require('./copy-buttons.js');
require('./code-copy-buttons.js');

const tocbot = require('tocbot');

// Table of contents – init when #toc is present (e.g. {{#show-toc}} in layout)
function initToc() {
  const tocEl = document.getElementById('toc');
  const contentEl = document.querySelector('.js-toc-content');
  if (!tocEl || !contentEl) return;

  // Ensure headings have ids so tocbot can link to them
  function ensureHeadingIds(container) {
    const headings = container.querySelectorAll('h2, h3, h4');
    const used = new Set();
    function slug(text) {
      let s = text
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (!s) s = 'section';
      let base = s;
      let i = 0;
      while (used.has(base)) base = s + '-' + (++i);
      used.add(base);
      return base;
    }
    headings.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
    });
  }

  ensureHeadingIds(contentEl);
  tocbot.init({
    tocSelector: '#toc',
    contentSelector: '.js-toc-content',
    headingSelector: 'h2, h3, h4',
    scrollSmooth: true,
    scrollSmoothOffset: 24,
  });

  const wrapper = document.getElementById('toc-wrapper');
  if (wrapper && !tocEl.textContent.trim()) wrapper.style.display = 'none';
}
initToc();
