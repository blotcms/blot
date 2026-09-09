const exp = require("constants");
const { promisify } = require("util");

describe("template", () => {
	require("./setup")({ createTemplate: true });

	const setViewCallback = require("../index").setView;
	const setView = promisify(setViewCallback);
	const setMetadata = promisify(require("../index").setMetadata);
	const getView = promisify(require("../index").getView);
	const getMetadata = promisify(require("../index").getMetadata);
	const Blog = require("models/blog");
	const client = require("models/client");
	const hdel = client.hDel.bind(client);
	const get = client.get.bind(client);
	const key = require("../key");

	it("sets a view", async function () {
		const test = this;
		const view = {
			name: "post.txt",
			content: "Post content here",
		};

		await setView(test.template.id, view);
		const savedView = await getView(test.template.id, view.name);

		expect(savedView.name).toEqual(view.name);
		expect(savedView.content).toEqual(view.content);
	});

	it("stores file-backed partials under the literal reference from the content", async function () {
		// The key must stay verbatim: Mustache resolves "{{> /pages/home.txt}}"
		// by that exact string, so rewriting it (e.g. to a true-case entry path)
		// would break the reference at render time.
		await this.set("/Pages/Home.txt", "Hello from home");
		await setView(this.template.id, {
			name: "literal-partial.html",
			content: "{{> /pages/home.txt}}",
		});

		const savedView = await getView(this.template.id, "literal-partial.html");
		expect(savedView.partials).toEqual({ "/pages/home.txt": null });
	});

	it("recomputes file-backed partials from content instead of accumulating stale keys", async function () {
		await this.set("/pages/home.txt", "Hello from home");
		await this.set("/pages/about.txt", "About us");

		await setView(this.template.id, {
			name: "swap-partial.html",
			content: "{{> /pages/home.txt}}",
		});
		await setView(this.template.id, {
			name: "swap-partial.html",
			content: "{{> /pages/about.txt}}",
		});

		const savedView = await getView(this.template.id, "swap-partial.html");
		expect(savedView.partials).toEqual({ "/pages/about.txt": null });
	});

	it("keeps an explicitly declared file marker that backs an inline partial", async function () {
		await this.set("/pages/foo.txt", "Foo body");

		// parseTemplate(content) only sees "{{> wrapper}}", so the file marker
		// has to survive the save for getPartials to fetch /pages/foo.txt.
		await setView(this.template.id, {
			name: "inline-dep.html",
			content: "{{> wrapper}}",
			partials: {
				wrapper: "{{> /pages/foo.txt}}",
				"/pages/foo.txt": null,
			},
		});

		const savedView = await getView(this.template.id, "inline-dep.html");
		expect(savedView.partials.wrapper).toEqual("{{> /pages/foo.txt}}");
		expect(savedView.partials["/pages/foo.txt"]).toEqual(null);
	});

	it("short-circuits an unchanged view whose content references a file-backed partial", async function () {
		await this.set("/pages/home.txt", "Hello from home");

		await setView(this.template.id, {
			name: "sc-partial.html",
			content: "{{> /pages/home.txt}}",
			partials: {},
		});

		const before = await promisify(Blog.get)({ id: this.template.owner });
		await setView(this.template.id, {
			name: "sc-partial.html",
			content: "{{> /pages/home.txt}}",
			partials: {},
		});
		const after = await promisify(Blog.get)({ id: this.template.owner });

		expect(after.cacheID).toEqual(before.cacheID);
	});

	it("sets changes to an existing view", async function () {
		const test = this;
		const view = {
			name: "article.txt",
			content: "Original article content",
		};

		await setView(test.template.id, view);
		let savedView = await getView(test.template.id, view.name);

		expect(savedView.name).toEqual(view.name);
		expect(savedView.content).toEqual(view.content);

		view.content = "Updated article content";
		await setView(test.template.id, view);

		savedView = await getView(test.template.id, view.name);

		expect(savedView.content).toEqual(view.content);
	});

	it("handles boolean-heavy draft updates without Redis encoder errors", async function () {
		const templateID = this.template.id;

		await setMetadata(templateID, {
			localEditing: true,
			isPublic: false,
			locals: {
				featureFlags: {
					livePreview: true,
					showDraftBadge: false,
				},
			},
		});

		await setView(templateID, {
			name: "draft.html",
			content: "{{title}}",
			locals: {
				showHero: true,
				rollout: [true, false],
			},
			retrieve: {
				includeDraft: true,
				filters: {
					featured: false,
				},
			},
		});

		await setView(templateID, {
			name: "draft.html",
			content: "{{title}} updated",
			locals: {
				showHero: false,
				rollout: [false, true],
			},
			retrieve: {
				includeDraft: false,
				filters: {
					featured: true,
				},
			},
		});

		const view = await getView(templateID, "draft.html");
		expect(view.locals.showHero).toBe(false);
		expect(view.retrieve.includeDraft).toBe(false);
	});

	it("won't set a view with invalid mustache content", async function () {
		const test = this;
		const view = {
			name: "invalid.html",
			content: "{{#x}}", // without the closing {{/x}} mustache will err.
		};

		try {
			await setView(test.template.id, view);
		} catch (err) {
			expect(err instanceof Error).toBe(true);
		}
	});

	it("won't set a view with infinitely nested partials", async function () {
		const test = this;
		const view = {
			name: "loop.html",
			content: "{{> first}}",
			partials: {
				first: "{{> second}}",
				second: "{{> first}}",
			},
		};

		try {
			await setView(test.template.id, view);
			throw new Error("Expected setView to fail");
		} catch (err) {
			expect(err instanceof Error).toBe(true);
			expect(err.message).toContain("infinitely nested partials");
		}
	});

	it("won't set views that reference each other infinitely", async function () {
		const test = this;
		const baseName = "looping";
		const headerName = `${baseName}-header.html`;
		const entriesName = `${baseName}-entries.html`;

		await setView(test.template.id, {
			name: headerName,
			content: `{{> ${entriesName}}}`,
		});

		try {
			await setView(test.template.id, {
				name: entriesName,
				content: `{{> ${headerName}}}`,
			});

			throw new Error("Expected setView to fail");
		} catch (err) {
			expect(err instanceof Error).toBe(true);
			expect(err.message).toContain("infinitely nested partials");
		}
	});

	it("won't set a view against a template that does not exist", async function () {
		const test = this;
		const view = { name: "missing.html" };

		try {
			await setView("nonexistent:template", view);
		} catch (err) {
			expect(err instanceof Error).toBe(true);
		}
	});

	// In future this should return an error to the callback, lol
	it("won't set a view with a name that is not a string", async function () {
		const test = this;

		try {
			await setView(test.template.id, { name: null });
		} catch (err) {
			expect(err instanceof Error).toBe(true);
		}
	});

	it("forwards Redis url mapping failures to callback", function (done) {
		const expectedError = new Error("redis set failed");
		spyOn(client, "set").and.callFake(() => Promise.reject(expectedError));

		setViewCallback(
			this.template.id,
			{
				name: "redis-error.html",
				content: "hello",
				url: "/redis-error",
			},
			(err) => {
				expect(err).toBe(expectedError);
				done();
			},
		);
	});

	it("updates the cache ID of the blog which owns a template after setting a view", async function () {
		const test = this;
		const initialCacheID = test.blog.cacheID;
		const view = { name: "cache-test.html" };

		await setView(test.template.id, view);
		const blog = await promisify(Blog.get)({ id: test.template.owner });

		expect(blog.cacheID).not.toEqual(initialCacheID);
	});

	it("will save a view with a url array", async function () {
		await setView(this.template.id, {
			name: "index.html",
			url: ["/a", "/b"],
		});

		const view1 = await getView(this.template.id, "index.html");

		expect(view1.urlPatterns).toEqual(["/a", "/b"]);
		expect(view1.url).toEqual("/a");

		await setView(this.template.id, {
			name: "index.html",
			url: "/a",
		});

		const view2 = await getView(this.template.id, "index.html");

		expect(view2.urlPatterns).toEqual(["/a"]);
		expect(view2.url).toEqual("/a");
	});

	it("will get and set a view with or without the internal urlPatterns array", async function () {
		await setView(this.template.id, {
			name: "index.html",
			content: "123",
			url: "/a",
		});

		const view1 = await getView(this.template.id, "index.html");

		expect(view1.content).toEqual("123");

		const res = await hdel(key.urlPatterns(this.template.id), "index.html");

		expect(res).toEqual(1);

		await setView(this.template.id, {
			name: "index.html",
			content: "456",
		});

		const view2 = await getView(this.template.id, "index.html");

		expect(view2.content).toEqual("456");
	});

	it("updates the CDN manifest when CDN targets change", async function () {
		// Install the template so the CDN manifest is generated
		await this.blog.update({ template: this.template.id });

		await setView(this.template.id, {
			name: "style.css",
			content: "body { color: red; }",
		});

		await setView(this.template.id, {
			name: "index.html",
			content: "{{#cdn}}style.css{{/cdn}}",
		});

		const firstMetadata = await getMetadata(this.template.id);
		expect(firstMetadata.cdn["style.css"]).toEqual(jasmine.any(String));

		const originalHash = firstMetadata.cdn["style.css"];

		await setView(this.template.id, {
			name: "style.css",
			content: "body { color: blue; }",
		});

		const secondMetadata = await getMetadata(this.template.id);
		expect(secondMetadata.cdn["style.css"]).toEqual(jasmine.any(String));
		expect(secondMetadata.cdn["style.css"]).not.toEqual(originalHash);
	});

        describe("empty url array handling", () => {
		it("should not create a Redis key with 'undefined' when an empty array is passed", async function () {
			// First, set a view with a valid URL
			await setView(this.template.id, {
				name: "test.html",
				content: "Test content",
				url: "/test",
			});

			// Verify the URL key exists
			const urlKey = key.url(this.template.id, "/test");
			const viewNameBefore = await get(urlKey);
			expect(viewNameBefore).toEqual("test.html");

			// Now set the view with an empty array - this should remove the URL
			await setView(this.template.id, {
				name: "test.html",
				content: "Test content",
				url: [],
			});

			// BUG DEMONSTRATION: When updates.url is deleted (becomes undefined),
			// line 96 in setView.js still executes: client.set(key.url(templateID, updates.url), name)
			// This creates a Redis key like "template:xxx:url:undefined" with value "test.html"
			const undefinedUrlKey = key.url(this.template.id, undefined);
			const undefinedKeyValue = await get(undefinedUrlKey);

			// This demonstrates the bug: a key with "undefined" should NOT exist
			// With the bug, this key exists and contains "test.html"
			// After the fix, this should be null
			expect(undefinedKeyValue).toBeNull();

			// The original URL key should be deleted
			const viewNameAfter = await get(urlKey);
			expect(viewNameAfter).toBeNull();
		});

		it("should remove url and urlPatterns from view when empty array is passed", async function () {
			// First, set a view with a valid URL
			await setView(this.template.id, {
				name: "remove-test.html",
				content: "Test content",
				url: "/remove-test",
			});

			let view = await getView(this.template.id, "remove-test.html");
			expect(view.url).toEqual("/remove-test");
			expect(view.urlPatterns).toEqual(["/remove-test"]);

			// Now set the view with an empty array
			await setView(this.template.id, {
				name: "remove-test.html",
				content: "Test content",
				url: [],
			});

			view = await getView(this.template.id, "remove-test.html");
			// After passing empty array, url and urlPatterns should be removed
			expect(view.url).toBeUndefined();
			expect(view.urlPatterns).toBeUndefined();
		});

		it("should clean up old URL mapping when empty array is passed", async function () {
			// Set a view with a URL
			await setView(this.template.id, {
				name: "cleanup-test.html",
				content: "Test content",
				url: "/old-url",
			});

			// Verify the URL key exists
			const oldUrlKey = key.url(this.template.id, "/old-url");
			const viewNameBefore = await get(oldUrlKey);
			expect(viewNameBefore).toEqual("cleanup-test.html");

			// Set with empty array to remove the URL
			await setView(this.template.id, {
				name: "cleanup-test.html",
				content: "Test content",
				url: [],
			});

			// The old URL key should be deleted
                        const viewNameAfter = await get(oldUrlKey);
                        expect(viewNameAfter).toBeNull();
                });
        });

        describe("view payload size limits", () => {
                const MAX_VIEW_PAYLOAD_SIZE = 2 * 1024 * 1024;

                const createUpdatesWithPayloadSize = (name, targetSize) => {
                        const base = { name, content: "" };
                        const baseSize = Buffer.byteLength(JSON.stringify(base));
                        const fillerLength = targetSize - baseSize;

                        if (fillerLength < 0) {
                                throw new Error("Target size is smaller than the base payload size");
                        }

                        return {
                                ...base,
                                content: "a".repeat(fillerLength),
                        };
                };

                const getPayloadSize = (updates) => Buffer.byteLength(JSON.stringify(updates));

                it("allows payloads just under the maximum", async function () {
                        const targetSize = MAX_VIEW_PAYLOAD_SIZE - 1;
                        const updates = createUpdatesWithPayloadSize("payload-under.html", targetSize);

                        expect(getPayloadSize(updates)).toEqual(targetSize);

                        await setView(this.template.id, updates);
                        const savedView = await getView(this.template.id, updates.name);

                        expect(savedView.name).toEqual(updates.name);
                });

                it("allows payloads at the maximum", async function () {
                        const targetSize = MAX_VIEW_PAYLOAD_SIZE;
                        const updates = createUpdatesWithPayloadSize("payload-at.html", targetSize);

                        expect(getPayloadSize(updates)).toEqual(targetSize);

                        await setView(this.template.id, updates);
                        const savedView = await getView(this.template.id, updates.name);

                        expect(savedView.name).toEqual(updates.name);
                });

                it("rejects payloads over the maximum", async function () {
                        const targetSize = MAX_VIEW_PAYLOAD_SIZE + 1;
                        const updates = createUpdatesWithPayloadSize("payload-over.html", targetSize);

                        expect(getPayloadSize(updates)).toEqual(targetSize);

                        try {
                                await setView(this.template.id, updates);
                                throw new Error("Expected payload to exceed limit");
                        } catch (err) {
                                expect(err instanceof Error).toBe(true);
                                expect(err.message).toBe("View payload exceeds maximum size of 2 MB");
                        }
                });
        });

	describe("clearing template errors when saving a view", () => {
		it("clears the view from metadata.errors when saving valid content for that view", async function () {
			const templateID = this.template.id;

			await setMetadata(templateID, {
				errors: { "entry.html": "Unclosed section \"entries\" on line 5" },
			});

			let metadata = await getMetadata(templateID);
			expect(metadata.errors).toEqual({
				"entry.html": "Unclosed section \"entries\" on line 5",
			});

			await setView(templateID, {
				name: "entry.html",
				content: "<h1>{{title}}</h1>",
			});

			metadata = await getMetadata(templateID);
			expect(metadata.errors).toEqual({});
		});

		it("clears only the saved view from metadata.errors when multiple views have errors", async function () {
			const templateID = this.template.id;

			await setMetadata(templateID, {
				errors: {
					"entry.html": "Unclosed section on line 1",
					"index.html": "Bad partial on line 2",
				},
			});

			await setView(templateID, {
				name: "entry.html",
				content: "Fixed content",
			});

			const metadata = await getMetadata(templateID);
			expect(metadata.errors).toEqual({
				"index.html": "Bad partial on line 2",
			});
		});

		it("does not add or change errors when saving a view that was not in metadata.errors", async function () {
			const templateID = this.template.id;

			await setMetadata(templateID, {
				errors: { "other.html": "Some error" },
			});

			await setView(templateID, {
				name: "clean.html",
				content: "New valid view",
			});

			const metadata = await getMetadata(templateID);
			expect(metadata.errors).toEqual({ "other.html": "Some error" });
		});
	});
});
