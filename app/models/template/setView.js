var Mustache = require("mustache");
var type = require("helper/type");
var client = require("models/client");
var key = require("./key");
var urlNormalizer = require("helper/urlNormalizer");
var ensure = require("helper/ensure");
var extend = require("helper/extend");
var viewModel = require("./viewModel");
var getView = require("./getView");
var serialize = require("./util/serialize");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var Blog = require("models/blog");
var parseTemplate = require("./parseTemplate");
var ERROR = require("../../blog/render/error");
var updateCdnManifest = require("./util/updateCdnManifest");
var serializeRedisHashValues = require("models/redisHashSerializer");
var clfdate = require("helper/clfdate");
const MAX_VIEW_PAYLOAD_SIZE = 2 * 1024 * 1024;

module.exports = function setView(templateID, updates, callback) {
        ensure(templateID, "string").and(updates, "object").and(callback, "function");

        if (updates.partials !== undefined && type(updates.partials) !== "object") {
		updates.partials = {};
		console.log(templateID, updates, "Partials are wrong type");
	}

	var name = updates.name;

	if (!name || !type(name, "string")) {
		return callback(new Error("The view's name is invalid"));
	}

	// Validate that the name doesn't start with '.' or contain a slash
	if (name.startsWith(".")) {
		return callback(new Error("View names cannot start with '.'"));
	}

	// We don't support subdirectories in templates at the moment
        if (name.includes("/") || name.includes("\\")) {
                return callback(new Error("View names cannot contain slashes"));
        }

        const serializedUpdates = JSON.stringify(updates);
        const payloadSize = Buffer.byteLength(serializedUpdates);

        if (payloadSize > MAX_VIEW_PAYLOAD_SIZE) {
                return callback(new Error("View payload exceeds maximum size of 2 MB"));
        }

        if (updates.content !== undefined) {
                try {
                        Mustache.render(updates.content, {});
                } catch (e) {
                        return callback(e);
		}
	}

	var allViews = key.allViews(templateID);
	var viewKey = key.view(templateID, name);

	getMetadata(templateID, (err, metadata) => {
		if (err) return callback(err);

		if (!metadata)
			return callback(new Error("There is no template called " + templateID));

		client.sAdd(allViews, name).then(() => {

			// Look up previous state of view if applicable
			getView(templateID, name, (err, view) => {
				view = view || {};
				let redisWriteChain = Promise.resolve();

				const enqueueRedisWrite = (writeFn) => {
					redisWriteChain = redisWriteChain.then(() => Promise.resolve().then(writeFn));
				};

				// Normalize legacy views' urlPatterns for short-circuit comparison
				// This ensures legacy views with only view.url can properly short-circuit
				if (!view.urlPatterns && view.url) {
					view.urlPatterns = [urlNormalizer(view.url)];
				}

				var changes;

				// Handle `url` logic
				var shouldRemoveUrl = false;
				var shouldRemoveUrlPatterns = false;

				if (updates.url !== undefined) {
					if (type(updates.url, "array")) {
						if (updates.url.length === 0) {
							delete updates.url;
							delete updates.urlPatterns;
							shouldRemoveUrl = true;
							shouldRemoveUrlPatterns = true;
						} else {
							// If `url` is an array, use the first item as `url` and the array as `urlPatterns`
							const normalizedUrls = updates.url.map(urlNormalizer);
							updates.url = normalizedUrls[0];
							updates.urlPatterns = normalizedUrls;
						}
					} else if (type(updates.url, "string")) {
						// If `url` is a string, normalize it and use `[url]` as `urlPatterns`
						updates.url = urlNormalizer(updates.url);
						updates.urlPatterns = [updates.url];
					} else {
						return callback(
							new Error("The provided `url` must be a string or an array"),
						);
					}

					// Only update Redis if url is still defined (not deleted due to empty array)
					if (updates.url !== undefined) {
						enqueueRedisWrite(() =>
							client.set(key.url(templateID, updates.url), name),
						);

						if (updates.url !== view.url) {
							enqueueRedisWrite(() => client.del(key.url(templateID, view.url)));
						}
					} else {
						// If url was deleted (empty array), remove the old URL mapping
						if (view.url) {
							enqueueRedisWrite(() => client.del(key.url(templateID, view.url)));
						}
					}
				}

				redisWriteChain.then(() => {
				// SHORT-CIRCUIT: Check if content and other critical fields are unchanged
				// This avoids expensive operations (parsing, dependency detection, Redis writes, CDN updates)
				var contentUnchanged =
					updates.content === undefined || updates.content === view.content;
				var urlUnchanged;
				if (shouldRemoveUrl) {
					// If we're removing url, check if view currently has one
					urlUnchanged = !view.url;
				} else {
					urlUnchanged = !updates.url || updates.url === view.url;
				}
				var urlPatternsUnchanged;
				if (shouldRemoveUrlPatterns) {
					// If we're removing urlPatterns, check if view currently has one
					urlPatternsUnchanged = !view.urlPatterns;
				} else {
					urlPatternsUnchanged =
						!updates.urlPatterns ||
						JSON.stringify(updates.urlPatterns) ===
							JSON.stringify(view.urlPatterns);
				}
				var localsUnchanged =
					!updates.locals ||
					JSON.stringify(updates.locals || {}) ===
						JSON.stringify(view.locals || {});
				var partialsUnchanged = true; // Default to true
				if (updates.partials !== undefined) {
					// If partials are provided, we need to compare the final merged result
					// Since partials are merged with parsed partials from content, we need
					// to compute the expected final partials for comparison
					if (contentUnchanged && view.content) {
						// Content unchanged, so parse it to get the same parseResult.partials
						// that would be merged with updates.partials
						var parseResultForComparison = parseTemplate(view.content);
						var expectedPartials = {};
						// Start with updates.partials (normalized to object)
						if (type(updates.partials, "object")) {
							extend(expectedPartials).and(updates.partials);
						}
						// Merge with parsed partials (same as what happens in line 185)
						if (
							type(
								parseResultForComparison && parseResultForComparison.partials,
								"object",
							)
						) {
							extend(expectedPartials).and(parseResultForComparison.partials);
						}
						partialsUnchanged =
							JSON.stringify(expectedPartials) ===
							JSON.stringify(view.partials || {});
					} else {
						// Content changed, so we can't short-circuit anyway - partials will be recomputed
						partialsUnchanged = false;
					}
				}
				var retrieveUnchanged =
					!updates.retrieve ||
					JSON.stringify(updates.retrieve || {}) ===
						JSON.stringify(view.retrieve || {});

				if (
					contentUnchanged &&
					urlUnchanged &&
					urlPatternsUnchanged &&
					localsUnchanged &&
					partialsUnchanged &&
					retrieveUnchanged
				) {
					// Nothing has changed, skip all expensive operations
					console.log(
						clfdate(),
						templateID.slice(0, 12),
						"setView: short-circuit",
						name,
					);
					return callback();
				} else {
					console.log(
						clfdate(),
						templateID.slice(0, 12),
						"setView: proceeding",
						name,
						"contentUnchanged=" + contentUnchanged,
						"urlUnchanged=" + urlUnchanged,
						"urlPatternsUnchanged=" + urlPatternsUnchanged,
						"localsUnchanged=" + localsUnchanged,
						"partialsUnchanged=" + partialsUnchanged,
						"retrieveUnchanged=" + retrieveUnchanged,
					);
				}

				console.log(clfdate(), templateID.slice(0, 12), "setView:", name);

				var existingRetrieve = view.retrieve || {};

				for (var i in updates) {
					if (updates[i] !== view[i]) changes = true;
					view[i] = updates[i];
				}

				// Explicitly remove url and urlPatterns if they were deleted (empty array case)
				if (shouldRemoveUrl) {
					delete view.url;
					changes = true;
				}
				if (shouldRemoveUrlPatterns) {
					delete view.urlPatterns;
					changes = true;
				}

				ensure(view, viewModel);

				if (updates.urlPatterns) {
					// Store `urlPatterns` in Redis
					const urlPatternsKey = key.urlPatterns(templateID);
					enqueueRedisWrite(() =>
						client.hSet(
							urlPatternsKey,
							name,
							JSON.stringify(updates.urlPatterns),
						),
					);
				} else if (shouldRemoveUrlPatterns) {
					// Delete urlPatterns from Redis if it was removed
					const urlPatternsKey = key.urlPatterns(templateID);
					enqueueRedisWrite(() => client.hDel(urlPatternsKey, name));
				}

				redisWriteChain
					.then(() => {
						view.locals = view.locals || {};
						view.retrieve = view.retrieve || {};
						view.partials = view.partials || {};

						var parseResult = parseTemplate(view.content);

				// TO DO REMOVE THIS
				if (type(view.partials, "array")) {
					var _partials = {};

					for (var i = 0; i < view.partials.length; i++)
						_partials[view.partials[i]] = null;

					view.partials = _partials;
				}

				// Drop file-backed partial markers this save no longer references -
				// neither parsed from the current content nor explicitly passed in
				// updates.partials - so a "{{> /old.txt}}" edited out of the view
				// doesn't linger in the persisted map forever. Markers the caller
				// still declares are kept: they may back a file referenced only
				// inside an inline partial's body, which parseTemplate can't see.
				for (var storedPartial in view.partials) {
					if (
						storedPartial.charAt(0) === "/" &&
						!view.partials[storedPartial] &&
						!(parseResult.partials && storedPartial in parseResult.partials) &&
						!(
							updates.partials &&
							type(updates.partials, "object") &&
							storedPartial in updates.partials
						)
					)
						delete view.partials[storedPartial];
				}

				extend(view.partials).and(parseResult.partials);

						detectInfinitePartialDependency(
						templateID,
						view,
						parseResult,
						(infiniteError) => {
						if (infiniteError) return callback(infiniteError);

						// Parser output is the source of truth for retrieve locals.
						// Keep user-provided retrieve options (includeDraft, filters)
						// from the update or the previously stored view.
						view.retrieve = applyUserRetrieveOptions(
							parseResult.retrieve || {},
							updates.retrieve,
							existingRetrieve
						);

						view = serializeRedisHashValues(serialize(view, viewModel));

						// Delete url and urlPatterns from Redis hash if they were removed
						var multi = client.multi();
						multi.hSet(viewKey, view);

						if (shouldRemoveUrl) {
							console.log("removing hdel", viewKey, "url");
							multi.hDel(viewKey, "url");
						}
						if (shouldRemoveUrlPatterns) {
							console.log("removing hdel", viewKey, "urlPatterns");
							multi.hDel(viewKey, "urlPatterns");
						}

						// node-redis v5 multi.exec() returns a thenable; normalize to Promise so .then/.catch chain reliably
						Promise.resolve(multi.exec())
							.then(() => {

								if (!changes) {
									if (metadata.errors && metadata.errors[name]) {
										delete metadata.errors[name];
										return setMetadata(templateID, { errors: metadata.errors }, callback);
									}

									return callback();
								}

								Blog.set(metadata.owner, { cacheID: Date.now() }, (cacheErr) => {
									if (cacheErr) return callback(cacheErr);

									updateCdnManifest(templateID, (manifestErr) => {
										if (manifestErr) return callback(manifestErr);

										// Clear this view from template metadata.errors when saving
										// via the dashboard so fixing a view clears its error state
										if (metadata.errors && metadata.errors[name]) {
											delete metadata.errors[name];
											return setMetadata(templateID, { errors: metadata.errors }, callback);
										}

										callback();
									});
								});
							})
							.catch(callback);
						},
					);
					})
					.catch(callback);
				}).catch(callback);
			});
		}).catch(callback);
	});
};

var USER_RETRIEVE_KEYS = ["includeDraft", "filters"];

function applyUserRetrieveOptions(parsedRetrieve, requestedRetrieve, existingRetrieve) {
	var result = {};

	extend(result).and(parsedRetrieve || {});

	// The parser is authoritative for locals it can see in the content, but it
	// can't see a dependency reached indirectly - e.g. a view whose
	// locals.snippet is "{{latest_entry.title}}" and content is "{{{snippet}}}"
	// still needs retrieve.latest_entry. Carry over any real retrieve local
	// (one blot knows how to fetch) that the caller or the stored view asked
	// for. Non-local keys (stale output from an older parser, internal
	// __sentinels) are dropped - they fetch nothing.
	[requestedRetrieve, existingRetrieve].forEach(function (source) {
		if (!source) return;
		Object.keys(source).forEach(function (key) {
			if (key.indexOf("__") === 0) return;
			if (!parseTemplate.isSystemRetrieveLocal(key)) return;

			var sourceVal = source[key];

			if (result[key] === undefined) {
				result[key] = sourceVal;
			} else if (type(result[key], "array") && type(sourceVal, "array")) {
				// `cdn` is an array dependency - union the targets so an
				// explicit/stored entry (e.g. a target reached indirectly)
				// survives alongside the parser's. updateCdnManifest builds
				// the manifest purely from this persisted array.
				result[key] = [...new Set(result[key].concat(sourceVal))].sort();
			} else if (type(result[key], "object") && type(sourceVal, "object")) {
				// Both structured (e.g. plugin.katex.css from content plus an
				// explicit plugin.zoom.js needed by a local): keep the parser's
				// leaves, fold in the extra nested requests.
				extend(result[key]).and(sourceVal);
			}
			// else: parser produced a value and the explicit one is a bare
			// boolean (or vice versa) - the parser wins (see the setView
			// stale-boolean tests).
		});
	});

	USER_RETRIEVE_KEYS.forEach(function (key) {
		var value;

		if (requestedRetrieve && requestedRetrieve[key] !== undefined) {
			value = requestedRetrieve[key];
		} else if (existingRetrieve && existingRetrieve[key] !== undefined) {
			value = existingRetrieve[key];
		}

		if (value !== undefined) {
			result[key] = value;
		}
	});

	return result;
}

function detectInfinitePartialDependency(
	templateID,
	view,
	parseResult,
	callback,
) {
	var viewName = view && view.name;
	var viewAlias = null;
	if (type(viewName, "string") && viewName.indexOf(".") > -1) {
		viewAlias = viewName.slice(0, viewName.lastIndexOf("."));
	}

	var stack = [];
	var cache = {};
	var visited = {};

	var rootInlinePartials = {};
	if (type(view && view.partials, "object")) {
		extend(rootInlinePartials).and(view.partials);
	}
	if (type(parseResult && parseResult.partials, "object")) {
		extend(rootInlinePartials).and(parseResult.partials);
	}

	traverse(viewName, rootInlinePartials, function (err) {
		if (err) return callback(err);
		callback(null);
	});

	function traverse(name, contextInlinePartials, done) {
		if (!type(name, "string")) return done();

		if (stack.indexOf(name) > -1) {
			return done(ERROR.INFINITE());
		}

		stack.push(name);

		resolveNode(name, contextInlinePartials, function (err, node) {
			if (err) {
				stack.pop();
				return done(err);
			}

			if (node && node.cacheable && visited[name]) {
				stack.pop();
				return done();
			}

			if (!node) {
				stack.pop();
				return done();
			}

			var deps = node.deps || [];
			var childContext = {};
			if (type(contextInlinePartials, "object"))
				extend(childContext).and(contextInlinePartials);
			if (type(node.inlinePartials, "object"))
				extend(childContext).and(node.inlinePartials);
			if (type(rootInlinePartials, "object"))
				extend(childContext).and(rootInlinePartials);

			eachSeries(
				deps,
				function (dep, next) {
					traverse(dep, childContext, next);
				},
				function (err) {
					stack.pop();
					if (!err && node.cacheable) visited[name] = true;
					done(err);
				},
			);
		});
	}

	function resolveNode(name, contextInlinePartials, done) {
		if (
			contextInlinePartials &&
			Object.prototype.hasOwnProperty.call(contextInlinePartials, name) &&
			contextInlinePartials[name] !== null &&
			contextInlinePartials[name] !== undefined
		) {
			return done(null, buildFromInline(contextInlinePartials[name]));
		}

		if (
			rootInlinePartials &&
			Object.prototype.hasOwnProperty.call(rootInlinePartials, name) &&
			rootInlinePartials[name] !== null &&
			rootInlinePartials[name] !== undefined
		) {
			return done(null, buildFromInline(rootInlinePartials[name]));
		}

		if (cache[name]) return done(null, cache[name]);

		if (isRootName(name)) {
			cache[name] = buildFromView(view, parseResult);
			return done(null, cache[name]);
		}

		if (name.charAt(0) === "/") {
			cache[name] = { deps: [], inlinePartials: {}, cacheable: true };
			return done(null, cache[name]);
		}

		getView(templateID, name, function (err, fetchedView) {
			if (err) {
				if (!err.message || err.message.indexOf("No view:") !== 0) {
					return done(err);
				}
			}

			if (!fetchedView) {
				cache[name] = { deps: [], inlinePartials: {}, cacheable: true };
				return done(null, cache[name]);
			}

			cache[name] = buildFromFetchedView(fetchedView);
			done(null, cache[name]);
		});
	}

	function isRootName(name) {
		return name === viewName || (viewAlias && name === viewAlias);
	}

	function buildFromView(view, parseResult) {
		var inlinePartials = {};

		if (type(view && view.partials, "object")) {
			extend(inlinePartials).and(view.partials);
		}

		if (type(parseResult && parseResult.partials, "object")) {
			extend(inlinePartials).and(parseResult.partials);
		}

		return {
			deps: Object.keys(inlinePartials),
			inlinePartials: inlinePartials,
			cacheable: true,
		};
	}

	function buildFromFetchedView(fetchedView) {
		var inlinePartials = {};

		if (type(fetchedView && fetchedView.partials, "object")) {
			extend(inlinePartials).and(fetchedView.partials);
		}

		var parsed = parseTemplate((fetchedView && fetchedView.content) || "");

		if (type(parsed && parsed.partials, "object")) {
			extend(inlinePartials).and(parsed.partials);
		}

		return {
			deps: Object.keys(inlinePartials),
			inlinePartials: inlinePartials,
			cacheable: true,
		};
	}

	function buildFromInline(partialValue) {
		var inlinePartials = {};
		var content = "";

		if (type(partialValue, "object")) {
			if (type(partialValue.partials, "object")) {
				extend(inlinePartials).and(partialValue.partials);
			}

			if (type(partialValue.content, "string")) {
				content = partialValue.content;
			}
		} else if (type(partialValue, "string")) {
			content = partialValue;
		}

		var parsed = parseTemplate(content || "");

		if (type(parsed && parsed.partials, "object")) {
			extend(inlinePartials).and(parsed.partials);
		}

		return {
			deps: Object.keys(inlinePartials),
			inlinePartials: inlinePartials,
			cacheable: false,
		};
	}
}

function eachSeries(list, iterator, done) {
	var index = 0;
	var items = Array.isArray(list) ? list : [];

	function next(err) {
		if (err) return done(err);
		if (index >= items.length) return done();

		iterator(items[index++], next);
	}

	next();
}
