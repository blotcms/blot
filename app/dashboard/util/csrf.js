const crypto = require('crypto');
const clfdate = require('helper/clfdate');

// The token cookie uses the __Host- prefix. Browsers only accept a
// __Host- cookie when it is Secure, has no Domain attribute and has
// Path=/, and they forbid any other origin (including sibling
// subdomains) from overwriting it. Every Blot blog is served with
// author-controlled HTML/JS on <handle>.blot.im, a sibling of the
// dashboard host. Without the prefix such a page could run
//   document.cookie = "csrf=x; domain=blot.im; path=/sites"
// and, because the path-scoped cookie sorts ahead of the dashboard's
// host-only cookie, feed its own value to the double-submit check
// below and forge state-changing requests. The prefix blocks that.
const COOKIE_NAME = '__Host-csrf';

module.exports = (req, res, next) => {
    // Skip CSRF for non-mutation requests
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        setupToken();
        return next();
    }

    // Validate token for mutation requests
    const cookieToken = req.cookies?.[COOKIE_NAME];
    const bodyToken = req.body?._csrf;

    if (!cookieToken || !bodyToken || cookieToken !== bodyToken) {
        console.log(clfdate(), `CSRF error: cookie=${cookieToken} body=${bodyToken}`);
        return res.status(403).send('Invalid CSRF token');
    }

    setupToken();
    next();

    function setupToken() {
        if (!req.cookies?.[COOKIE_NAME]) {
            const token = crypto.randomBytes(32).toString('hex');
            res.cookie(COOKIE_NAME, token, {
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                path: '/' // required for the __Host- prefix to be accepted
            });
            res.locals.csrftoken = token;
        } else {
            res.locals.csrftoken = req.cookies[COOKIE_NAME];
        }
    }
};
