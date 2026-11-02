const { extractHash, validate } = require('./util/cdn');

describe("plugin CDN manifest updates", function () {
  require("./util/setup")();

  it("updates CDN manifest hash for script.js when analytics plugin changes", async function () {
    
    // Create a template with script.js that uses app_js (which includes analytics)
    // and make script.js a CDN target by referencing it in another view
    await this.template({
      "script.js": "{{{app_js}}}",
      "entries.html": "{{#cdn}}/script.js{{/cdn}}",
    });

    // Get the initial CDN URL for script.js from the rendered HTML
    const initialCDNUrl = await this.text("/");
    const initialHash = extractHash(initialCDNUrl);

    validate(initialCDNUrl);

    // Verify initial state has no analytics
    const initialScriptContent = await this.text(initialCDNUrl);
    expect(initialScriptContent).not.toContain("www.google-analytics.com");

    // Update analytics plugin - this should trigger CDN manifest update
    await this.blog.update({ plugins: {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: {
          provider: { Google: true },
          trackingID: "UA-12345678-9",
        },
      },
    } });

    // Get the new CDN URL for script.js
    const updatedCDNUrl = await this.text("/");
    const updatedHash = extractHash(updatedCDNUrl);

    validate(updatedCDNUrl);

    // The hash should have changed because the rendered output of script.js
    // now includes analytics code, which changes the hash
    expect(updatedHash).not.toBe(initialHash);

    // Verify the CDN URL actually serves the updated content with analytics
    const scriptContent = await this.text(updatedCDNUrl);
    expect(scriptContent).toContain("www.google-analytics.com/analytics.js");
    expect(scriptContent).toContain("UA-12345678-9");
  });

  it("updates CDN manifest hash when analytics plugin is disabled", async function () {
    // Start with analytics enabled
    const pluginsWithAnalytics = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: {
          provider: { Google: true },
          trackingID: "UA-12345678-9",
        },
      },
    };
    await this.blog.update({ plugins: pluginsWithAnalytics });

    await this.template({
      "script.js": "{{{app_js}}}",
      "entries.html": "{{#cdn}}/script.js{{/cdn}}",
    });

    const initialCdnUrl = await this.text("/");
    const initialHash = extractHash(initialCdnUrl);

    validate(initialCdnUrl);

    // Verify analytics is present
    const initialScriptContent = await this.text(initialCdnUrl);
    expect(initialScriptContent).toContain("www.google-analytics.com");

    // Disable analytics plugin
    const pluginsWithoutAnalytics = {
      ...this.blog.plugins,
      analytics: {
        enabled: false,
      },
    };
    await this.blog.update({ plugins: pluginsWithoutAnalytics });

    const updatedCdnUrl = await this.text("/");
    const updatedHash = extractHash(updatedCdnUrl);

    // The hash should have changed because analytics is no longer in the output
    expect(updatedHash).not.toBe(initialHash);

    // Verify analytics is no longer present
    const updatedScriptContent = await this.text(updatedCdnUrl);
    expect(updatedScriptContent).not.toContain("www.google-analytics.com");
  });

  it("updates CDN manifest hash when analytics provider changes", async function () {
    await this.template({
      "script.js": "{{{app_js}}}",
      "entries.html": "{{#cdn}}/script.js{{/cdn}}",
    });

    // Start with Google Analytics
    const pluginsGoogle = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: {
          provider: { Google: true },
          trackingID: "UA-12345678-9",
        },
      },
    };
    await this.blog.update({ plugins: pluginsGoogle });

    const initialCdnUrl = await this.text("/");
    const initialHash = extractHash(initialCdnUrl);

    validate(initialCdnUrl);

    // Switch to Plausible Analytics
    const pluginsPlausible = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: {
          provider: { Plausible: true },
        },
      },
    };
    await this.blog.update({ plugins: pluginsPlausible });

    const updatedCdnUrl = await this.text("/");
    const updatedHash = extractHash(updatedCdnUrl);

    // The hash should have changed because the analytics code changed
    expect(updatedHash).not.toBe(initialHash);

    // Verify the new provider is present
    const updatedScriptContent = await this.text(updatedCdnUrl);
    expect(updatedScriptContent).toContain("plausible.io/js/plausible.js");
    expect(updatedScriptContent).not.toContain("www.google-analytics.com");
  });
});
