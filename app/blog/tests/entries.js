describe("entries", function () {

    require('./util/setup')();

    it("lists the entries on an index page", async function () {

        await this.write({path: '/a.txt', content: 'Hello, A!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/c.txt', content: 'Hello, C!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" });

        const body = await this.text('/');
        expect(body).toContain('Hello, A!');
        expect(body).toContain('Hello, B!');
        expect(body).toContain('Hello, C!');
    });

    it("respects the page_size property in templates", async function () {

        await this.write({path: '/c.txt', content: 'Hello, C!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/a.txt', content: 'Hello, A!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {page_size: 2}
        });

        const body = await this.text('/');
        expect(body).toContain('Hello, A!');
        expect(body).toContain('Hello, B!');
        expect(body).not.toContain('Hello, C!');

        const body2 = await this.text('/page/2');
        expect(body2).not.toContain('Hello, A!');
        expect(body2).not.toContain('Hello, B!');
        expect(body2).toContain('Hello, C!');
    });

    it("respects the sort_order property in templates", async function () {

        await this.write({path: '/c.txt', content: 'Hello, C!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/a.txt', content: 'Hello, A!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_order: 'desc'}
        });

        const body = await this.text('/');

        expect(body).toEqual('<p>Hello, C!</p><p>Hello, B!</p><p>Hello, A!</p>');

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_order: 'asc'}
        });

        const body2 = await this.text('/');
        expect(body2).toEqual('<p>Hello, A!</p><p>Hello, B!</p><p>Hello, C!</p>');
    });


    it("respects the sort_by property in templates", async function () {

        await this.write({path: '/a.txt', content: 'Hello, A!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/c.txt', content: 'Hello, C!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_by: 'date'}
        });

        const body = await this.text('/');

        expect(body).toEqual('<p>Hello, C!</p><p>Hello, B!</p><p>Hello, A!</p>');

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_by: 'id'}
        });

        const body2 = await this.text('/');
        expect(body2).toEqual('<p>Hello, A!</p><p>Hello, B!</p><p>Hello, C!</p>');
    });

    it("supports sort config nested under locals.sort", async function () {

        await this.write({path: '/a.txt', content: 'Hello, A!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/c.txt', content: 'Hello, C!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort: {by: 'id', direction: 'desc'}}
        });

        const res = await this.get('/');
        const body = await res.text();

        expect(body).toEqual('<p>Hello, C!</p><p>Hello, B!</p><p>Hello, A!</p>');
    });

    it("paginates sort_by=id lexicographically when publish dates are out of order", async function () {

        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/a.txt', content: 'Hello, A!'});
        await this.write({path: '/c.txt', content: 'Hello, C!'});

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_by: 'id', sort_order: 'asc', page_size: 1}
        });

        const page1Asc = await this.text('/page/1');
        const page2Asc = await this.text('/page/2');

        expect(page1Asc).toEqual('<p>Hello, A!</p>');
        expect(page2Asc).toEqual('<p>Hello, B!</p>');

        await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" }, {
            locals: {sort_by: 'id', sort_order: 'desc', page_size: 1}
        });

        const page1Desc = await this.text('/page/1');
        const page2Desc = await this.text('/page/2');

        expect(page1Desc).toEqual('<p>Hello, C!</p>');
        expect(page2Desc).toEqual('<p>Hello, B!</p>');
    });

    it("generates pagination properly", async function () {

        const numberOfEntries = 10;
        const page_size = 3;

        // create 10 entries
        for (let i = numberOfEntries; i > 0; i--) {
            await this.write({path: `/${i}.txt`, content: `Hello, ${i}!`});
        }

        await this.template({ "entries.html": `
            {{#entries}}
            {{{html}}}
            {{/entries}}
            {{#pagination}}
                {{#next}}<a href="/page/{{next}}">Next</a>{{/next}}
                Page {{current}} of {{total}}
                {{#previous}}<a href="/page/{{previous}}">Prev</a>{{/previous}}
            {{/pagination}}
            `}, { locals: {page_size} });
        
        for (let i = 1; i <= 4; i++) {
            const body = await this.text(`/page/${i}`);
            expect(body).toContain('Page ' + i + ' of ' + Math.ceil(numberOfEntries / page_size));
            if (i === 4) {
                expect(body).not.toContain('Next');
                expect(body).toContain('Prev');
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 1}!`);
            } else if (i === 1) {
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 1}!`);
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 2}!`);
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 3}!`);    
                expect(body).toContain('Next'); 
                expect(body).not.toContain('Prev');                
            } else {
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 1}!`);
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 2}!`);
                expect(body).toContain(`Hello, ${(i - 1) * 3 + 3}!`);    
                expect(body).toContain('Next');
                expect(body).toContain('Prev');
            }
        }
    });

    it("exposes totalEntries in pagination data", async function () {

        const totalEntries = 5;
        const page_size = 2;

        for (let i = totalEntries; i > 0; i--) {
            await this.write({path: `/${i}.txt`, content: `Hello, ${i}!`});
        }

        await this.template({ "entries.html": "{{pagination.current}}/{{pagination.total}}/{{pagination.page_size}}/{{pagination.total_entries}}/{{pagination.pageSize}}" }, {
            locals: {page_size}
        });

        const body = await this.text('/page/1');
        expect(body).toContain('1/3/2/5/2');

        const body2 = await this.text('/page/3');
        expect(body2).toContain('3/3/2/5/2');
    });

    it("keeps pagination object available on single-page blogs", async function () {

        await this.write({path: '/only.txt', content: 'Hello, only!'});

        await this.template({ "entries.html": "{{pagination.current}}/{{pagination.total}}/{{pagination.previous}}/{{pagination.next}}/{{pagination.page_size}}/{{pagination.total_entries}}" }, {
            locals: {page_size: 10}
        });

        const body = await this.text('/');
        expect(body).toContain('1/1///10/1');
    });
});
