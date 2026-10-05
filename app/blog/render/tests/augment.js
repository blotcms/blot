describe("augment", function () {

    require('../../tests/util/setup')();

    it("adds formatDate function to entries", async function () {
        
        await this.write({path: "/first.txt", content: "Foo"});
        await this.template({
            'entry.html': '{{#entry}}{{#formatDate}}YYYY{{/formatDate}}{{/entry}}'
        }, { locals: { name: 'David' } });

        const res = await this.get('/first');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual(new Date().getFullYear().toString());
    });
    
    it("adds ratio property to thumbnails", async function () {
    
        const image = await require('sharp')({
            create: {
                width: 100,
                height: 200,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        }).png().toBuffer();

        await this.write({path: "/_thumbnail.jpg", content: image});
        await this.write({path: "/first.txt", content: "![](_thumbnail.jpg)"});
        await this.template({'entry.html': '{{entry.thumbnail.large.ratio}}'});

        const res = await this.get('/first');
        const body = await res.text();

        expect(res.status).toEqual(200);
        // this is used to apply a padding-bottom to the thumbnail container to maintain aspect ratio
        expect(body.trim()).toEqual('200%');
    });

    it("renders entry backlinks", async function () {
        
        await this.write({path: "/first.txt", content: "Foo"});
        await this.write({path: "/second.txt", content: "Title: Second\n\n[[first]]"});
        await this.template({
            'entry.html': '{{#entry}}{{#backlinks}}{{title}}{{/backlinks}}{{/entry}}'
        });

        const res = await this.get('/first');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Second');
    });


    describe("createBacklinkLookups", function () {
        const Entry = require("models/entry");
        const { createBacklinkLookups } = require("../load/augment");

        it("reads each linked URL once and shares the result", async function () {
            const target = { path: "/target.txt", html: "<p>big</p>" };
            const getByUrl = spyOn(Entry, "getByUrl").and.callFake(
                (blogID, url, callback) => callback(target)
            );
            const project = jasmine.createSpy("project").and.callFake((entry) => {
                delete entry.html;
            });
            const lookups = createBacklinkLookups(project);

            const [a, b] = await Promise.all([
                lookups.get("blog", "/target"),
                lookups.get("blog", "/target"),
            ]);
            await lookups.get("blog", "/other");

            expect(getByUrl.calls.count()).toBe(2);
            expect(a).toBe(b);
            expect(a.entry).toBe(target);
            expect(a.entry.html).toBeUndefined();
            expect(project.calls.count()).toBe(2);
        });

        it("reports a failed lookup and does not project it", async function () {
            const error = new Error("redis down");
            spyOn(Entry, "getByUrl").and.callFake((blogID, url, callback) =>
                callback(undefined, error)
            );
            const project = jasmine.createSpy("project");

            const result = await createBacklinkLookups(project).get("blog", "/x");

            expect(result.entry).toBeUndefined();
            expect(result.error).toBe(error);
            expect(project).not.toHaveBeenCalled();
        });
    });

    it("renders each backlink on a catalog list, with a shared target", async function () {
        await this.write({path: "/target.txt", content: "Title: Target\n\nTarget body"});
        await this.write({path: "/a.txt", content: "Title: A\n\n[[target]]"});
        await this.write({path: "/b.txt", content: "Title: B\n\n[[target]]"});
        await this.write({path: "/c.txt", content: "Title: C\n\n[[target]] [[a]]"});
        await this.template({
            'entries.html': '{{#allEntries}}{{title}}=[{{#backlinks}}{{title}},{{/backlinks}}];{{/allEntries}}'
        });

        const body = await this.text('/');

        const targetLinks = body.match(/Target=\[([ABC,]*)\];/)[1].split(',').filter(Boolean);
        expect(targetLinks.sort()).toEqual(['A', 'B', 'C']);
        expect(body).toContain('A=[C,];');
        expect(body).toContain('B=[];');
    });

    it("keeps the html of a backlinked entry when the template reads it", async function () {
        await this.write({path: "/target.txt", content: "Title: Target\n\nTarget body"});
        await this.write({path: "/a.txt", content: "Title: A\n\nLinked from A: [[target]]"});
        await this.template({
            'entries.html': '{{#allEntries}}{{#backlinks}}{{{html}}}{{/backlinks}}{{/allEntries}}'
        });

        const body = await this.text('/');

        expect(body).toContain('Linked from A');
    });

    it("creates lowercase metadata aliases for rendering", async function () {

        await this.write({
            path: "/mixed-case-metadata.txt",
            content: "Apple: Honeycrisp\n\nBody"
        });

        await this.template({
            'entry.html': '{{entry.metadata.apple}}'
        });

        const res = await this.get('/mixed-case-metadata');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Honeycrisp');
    });

    it("preserves explicit lowercase metadata values", async function () {

        await this.write({
            path: "/metadata-precedence.txt",
            content: "Apple: Honeycrisp\napple: Gala\n\nBody"
        });

        await this.template({
            'entry.html': '{{entry.metadata.apple}}'
        });

        const res = await this.get('/metadata-precedence');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('Gala');
    });
    it("encodes tag slugs when augmenting entry tags", async function () {

        await this.write({
            path: "/slash-tag.txt",
            content: "Title: Slash Tag\nTags: Design/UI\n\nBody"
        });

        await this.template({
            'entry.html': '{{#entry.tags}}{{slug}}{{/entry.tags}}'
        });

        const res = await this.get('/slash-tag');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toEqual('design%2Fui');
    });
});
