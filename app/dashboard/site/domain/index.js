const express = require('express');
const config = require('config');
const { parse } = require('tldts');
const { domainToASCII } = require('url');
const Blog = require('models/blog');
const moment = require('moment');
const verify = require('./verify');
const identifyNameServers = require('./identifyNameServers');
// triggerAutoSSL() below pokes a user-set hostname; route it through the
// airlock proxy like the other user-controlled fetches. See helper/airlock.
const fetch = require('helper/airlock').fetch;
const Domain = express.Router();

const ip = config.ip;
const ipv6 = config.ipv6;
const host = config.host;

Domain.use((req, res, next) => {
    res.locals.breadcrumbs.add('Domain', '/domain');
    
    const blogID = req.blog.id;
    const warning = req.session[`${blogID}:domainWarning`] || req.session[`${blogID}:domainError`];
    const activeWarning = warning && normalizeHostname(warning.hostname) === normalizeHostname(req.blog.domain) ? warning : undefined;
    const customDomain = req.blog.pretty.domain || req.blog.domain || (activeWarning && activeWarning.hostname) || '';
    const { subdomain, domain } = parse(customDomain);
    
    res.locals.domainSuccess = !!req.blog.domain;
    res.locals.domainWarning = !!activeWarning;
    res.locals.subdomain = subdomain;
    res.locals.apexDomain = domain;
    res.locals.customDomain = customDomain;
    res.locals.host = host;
    res.locals.ip = ip;
    res.locals.ipv6 = ipv6;
        
    if (activeWarning) {
        res.locals.lastChecked = moment(activeWarning.lastChecked).fromNow();
        res.locals.nameservers = activeWarning.nameservers;
        res.locals.recordToRemove = activeWarning.recordToRemove;
        res.locals.revalidation = activeWarning.revalidation;

        const dnsProvider = identifyNameServers(activeWarning.nameservers);

        if (dnsProvider) {
            dnsProvider.is = {};
            dnsProvider.is[dnsProvider.id] = true;
            res.locals.dnsProvider = dnsProvider;
        }
        
        console.log(res.locals.dnsProvider);

        res.locals.code = {};
        res.locals.code[activeWarning.code] = true;
    }

    next();
});

function normalizeHostname(hostname) {
    if (!hostname) {
        return '';
    }

    const parsed = parse(hostname);
    const normalized = parsed.hostname || hostname;
    const asciiHostname = domainToASCII(normalized) || normalized;

    return asciiHostname.toLowerCase();
}

Domain.route('/')
    .get((req, res) => {
        res.render('dashboard/site/domain');
    })
    .post(async (req, res) => {
        const blogID = req.blog.id;
        const domainInput = typeof req.body.domain === 'string' ? req.body.domain : '';
        const { hostname } = parse(domainInput);

        if (req.body.handle) {
            try{
                await updateHandle(blogID, req.body.handle);
                return res.message('/sites/' + req.body.handle  + '/domain', 'Updated subdomain on Blot');
            } catch (e) {
                return res.message(res.locals.base + '/domain/subdomain', e);
            }
        }

        if (!hostname) {
            if (!domainInput || !domainInput.trim()) {
                await updateDomain(blogID, '');
                // Clear the domain error from the session
                delete req.session[`${blogID}:domainError`];
                delete req.session[`${blogID}:domainWarning`];
                req.session.save();
                return res.message(res.locals.base + '/domain', 'Domain removed');
            }

            return res.message(res.locals.base + '/domain/custom', new Error('Please enter a valid domain'));
        }

        // Remove the existing domain if it is set and differs from the new one
        if (req.blog.domain && req.blog.domain !== hostname) {
            try {
                await updateDomain(blogID, '');
            } catch (error) {
                return res.message(res.locals.base + '/domain/custom', error);
            }
        }

        try {
            await updateDomain(blogID, hostname);
        } catch (error) {
            return res.message(res.locals.base + '/domain/custom', error);
        }

        try {
            const isValid = await verify({ hostname, handle: req.blog.handle, ourIP: ip, ourIPv6: ipv6, ourHost: host });

            if (isValid) {
                // Clear the blog session
                delete req.session[`${blogID}:domainError`];
                delete req.session[`${blogID}:domainWarning`];
                req.session.save();
                triggerAutoSSL(hostname);
                return res.message(res.locals.base + '/domain', 'Domain added');
            } else {
                throw new Error('Domain verification failed.');
            }
        } catch (error) {
            console.log(error);

            // if this is a re-attempt or not
            const previousWarning = req.session[`${blogID}:domainWarning`] || req.session[`${blogID}:domainError`];
            const revalidation = previousWarning && previousWarning.hostname === hostname;

            // Store warning details in the session
            req.session[`${blogID}:domainWarning`] = {
                hostname,
                code: error.message,
                nameservers: error.nameservers || [],
                recordToRemove: error.recordToRemove || [],
                lastChecked: Date.now(),
                revalidation
            };
            delete req.session[`${blogID}:domainError`];

            req.session.save();
            triggerAutoSSL(hostname);
            return res.message(res.locals.base + '/domain/custom', 'Domain saved. Verification is still pending.');
        }
    });

Domain.route('/custom')
    .get((req, res) => {
        res.locals.edit = { custom: true };
        res.render('dashboard/site/domain');
    });

Domain.route('/subdomain')
    .get((req, res) => {
        res.locals.edit = { subdomain: true };
        res.render('dashboard/site/domain');
    });

const updateDomain = (blogID, domain) => {
    return new Promise((resolve, reject) => {
        Blog.set(blogID, { domain, forceSSL: false, redirectSubdomain: !!domain }, (errors, changes) => {
            if (errors) return reject(errors);
            resolve(changes);
        });
    });
};

const updateHandle = (blogID, handle) => {
    return new Promise((resolve, reject) => {
        Blog.set(blogID, { handle }, (errors, changes) => {
            if (errors && errors.handle) return reject(errors.handle);
            if (errors) return reject(errors);
            resolve(changes);
        });
    });
};

function triggerAutoSSL(hostname) {
  if (!hostname) return;

  fetch(`https://${hostname}`, { method: "HEAD", redirect: "manual" }).catch(
    (error) => {
      console.error(
        "Failed to trigger AutoSSL for %s: %s",
        hostname,
        error && error.message ? error.message : error
      );
    }
  );
}

module.exports = Domain;
