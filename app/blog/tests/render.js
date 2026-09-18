describe("render", function () {

    require('./util/setup')();

    it("exposes template locals to individual views", async function () {
        
        await this.template({
            'entries.html': 'Hello, {{name}}!'
        }, { locals: { name: 'David' } });

        const res = await this.get('/');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Hello, David!');
    });

    it("overrides view-specific locals with template locals", async function () {
        
        await this.template({
            'entries.html': 'Hello, {{name}}!'
        }, { 
            locals: { name: 'David' },
            views: { 'entries.html': {
                locals: { name: 'John' }
            } }
        });

        const res = await this.get('/');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Hello, John!');
    });

    it("does not evaluate Mustache tags inside entry HTML", async function () {
        await this.write({
            path: "/hello.txt",
            content: "Title: Hello\n\nThis post mentions {{title}} and {{#entry}}nope{{/entry}}.",
        });

        await this.template({
            "entry.html": "{{#entry}}{{{html}}}{{/entry}}",
        });

        const body = await this.text("/hello");

        expect(body).toContain("{{title}}");
        expect(body).toContain("{{#entry}}nope{{/entry}}");
        expect(body).not.toContain("This post mentions Hello");
    });

    it("does not evaluate Mustache tags in string locals", async function () {
        await this.write({
            path: "/a.txt",
            content: "Title: DistinctTitle\n\nA body",
        });

        await this.template(
            { "entries.html": "{{{snippet}}}" },
            { locals: { snippet: "{{#entries}}{{title}}{{/entries}}" } }
        );

        const body = await (await this.get("/")).text();

        expect(body).toContain("{{#entries}}{{title}}{{/entries}}");
        expect(body).not.toContain("DistinctTitle");
    });

    it("keeps entry tags intact on entries.html, which aliases {{#entries}} to the same objects as {{#posts}}", async function () {
        await this.publish({ path: "/a.txt", content: "Tags: Reviews\n\nA body" });

        await this.template({
            "entries.html": "{{#entries}}{{title}} in {{#tags}} {{name}} {{/tags}}{{/entries}}",
        });

        const body = await (await this.get("/")).text();

        expect(body).toContain("Reviews");
    });

    it("keeps entry tags intact on tagged.html, which aliases {{#entries}} to the same objects as {{#tagged}}", async function () {
        await this.publish({ path: "/a.txt", content: "Tags: Reviews\n\nA body" });

        await this.template({
            "tagged.html": "{{#entries}}{{title}} in {{#tags}} {{name}} {{/tags}}{{/entries}}",
        });

        const body = await this.text("/tagged/reviews");

        expect(body).toContain("Reviews");
    });

    it("keeps entry tags intact on search.html, which aliases {{#entries}} to the same objects as {{#search_results}}", async function () {
        await this.publish({ path: "/a.txt", content: "Tags: Reviews\n\nBananas" });

        await this.template({
            "search.html": "{{#entries}}{{title}} in {{#tags}} {{name}} {{/tags}}{{/entries}}",
        });

        const body = await this.text("/search?q=bananas");

        expect(body).toContain("Reviews");
    });

    it("exposes partials to views, including partials in partials", async function () {
        
        await this.template({
            'entries.html': '{{> name}}{{> footer}}',
            'name.html': '{{> greeting}} David',
            'greeting.html': 'Hello',
        }, { views: { 'entries.html': { partials: { footer: ' FOOTER' } } } });

        const res = await this.get('/');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Hello David FOOTER');
    });

});