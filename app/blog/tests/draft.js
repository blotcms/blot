describe("drafts", function () {

    require('./util/setup')();

    it("updates a draft dynamically", async function () {

        await this.write({path: '/Drafts/index.txt', content: 'Hello, world!'});
        await this.template({ 'entry.html': '{{#entry}} {{{html}}} {{/entry}}', 'error.html': 'Err' });

        const res = await this.get('/draft/view/Drafts/index.txt');
        const body = await res.text();

        expect(res.status).toEqual(200);
        expect(body.trim()).toContain('Hello, world!');

        // update the draft
        await this.write({path: '/Drafts/index.txt', content: 'Hello, world! Updated!'});

        const res2 = await this.get('/draft/view/Drafts/index.txt');
        const body2 = await res2.text();

        expect(res2.status).toEqual(200);
        expect(body2.trim()).toContain('Hello, world! Updated!');
    });

    it("handles a broken draft url", async function () {
        const res = await this.get('/draft/view/Drafts/does-not-exist.txt');
        expect(res.status).toEqual(404);
    });

    it("streams a draft", async function () {
        // Prepare the initial draft and templates
        await this.write({ path: '/Drafts/index.txt', content: 'Hello, world!' });
        await this.template({ 
            'entry.html': '{{#entry}} {{{html}}} {{/entry}}', 
            'error.html': 'Err' 
        });
        
        await this.stream({
            path: '/draft/stream/Drafts/index.txt',
            onStreamReady: () => this.write({ path: '/Drafts/index.txt', content: 'Updated!' }),
            expectedText: 'Updated!'
        });        
    });

    it("serializes and coalesces a burst of draft renders", async function () {
        const createRenderQueue = require("../routes/draft").createRenderQueue;
        const resolvers = [];
        let active = 0;
        let maximumActive = 0;
        let renders = 0;
        const queue = createRenderQueue({
            isClosed: function () { return false; },
            render: function () {
                renders++;
                active++;
                maximumActive = Math.max(maximumActive, active);
                return new Promise(function (resolve) {
                    resolvers.push(function () { active--; resolve(); });
                });
            }
        });

        queue.notify();
        queue.notify();
        queue.notify();
        expect(renders).toBe(1);
        resolvers.shift()();
        await new Promise(setImmediate);
        expect(renders).toBe(2);
        resolvers.shift()();
        await new Promise(setImmediate);

        expect(maximumActive).toBe(1);
        expect(renders).toBe(2);
    });

    it("retries a pending render after a throw", async function () {
        const createRenderQueue = require("../routes/draft").createRenderQueue;
        let renders = 0;
        let shouldThrow = true;
        const queue = createRenderQueue({
            isClosed: function () { return false; },
            render: async function () {
                renders++;
                if (shouldThrow) {
                    shouldThrow = false;
                    queue.notify();
                    throw new Error("render failed");
                }
            }
        });

        queue.notify();
        await new Promise(setImmediate);

        expect(renders).toBe(2);
    });

    it("starts a new render after the queue is idle", async function () {
        const createRenderQueue = require("../routes/draft").createRenderQueue;
        let renders = 0;
        const queue = createRenderQueue({
            isClosed: function () { return false; },
            render: async function () { renders++; }
        });

        queue.notify();
        await new Promise(setImmediate);
        expect(renders).toBe(1);

        queue.notify();
        await new Promise(setImmediate);
        expect(renders).toBe(2);
    });

});
