describe("search", function () {

    const SEARCH_TEMPLATE = {
        "search.html": `<h1 data-template="search">{{query}}</h1> {{#entries}} {{{html}}} {{/entries}}`,
        "error.html": "{{error.title}}",
    };

    require('./util/setup')();

    beforeEach(async function () {
        await this.template(SEARCH_TEMPLATE);
    });

    it("lets you search for an entry", async function () {

        await this.write({path: '/a.txt', content: 'Hello, A!'});
        await this.write({path: '/b.txt', content: 'Hello, B!'});
        await this.write({path: '/c.txt', content: 'Hello, C!'});

        const res = await this.get('/search?q=hello');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(res.headers.get('cache-control')).toEqual('no-cache');
        expect(body).toContain('Hello, A!');
        expect(body).toContain('Hello, B!');
        expect(body).toContain('Hello, C!');
        expect(body).toContain('hello');
    });



    it("does not error if there are multiple queries", async function () {
        
        await this.write({path: '/a.txt', content: 'Hello, A!'});

        const res = await this.get('/search?q=hello&q=a');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(res.headers.get('cache-control')).toEqual('no-cache');
        expect(body).toContain('Hello, A!');
        expect(body).toContain('hello a');
    });


    it("exposes query as a string to search templates", async function () {

        const res = await this.get('/search?q=hello&json=1');
        const locals = await res.json();

        expect(res.status).toEqual(200);
        expect(locals.query).toEqual('hello');
        expect(typeof locals.query).toEqual('string');
    });


    it("ignores non-string queries", async function () {

        const res = await this.get('/search?q[foo]=bar');
        const body = await res.text();

        expect(res.status).toEqual(404);
        expect(body).not.toContain('data-template="search"');
    });


    it("if there is no query it returns an empty list", async function () {

        await this.write({path: '/a.txt', content: 'Hello, A!'});

        const res = await this.get('/search');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body).toEqual('<h1 data-template="search"></h1> '); 
    }); 

    it("if no entries match it returns an empty list", async function () {
        await this.write({path: '/a.txt', content: 'Hello, A!'});

        const res = await this.get('/search?q=goodbye');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body).not.toContain('Hello, A!');
        expect(body).toContain('goodbye');
    });




});