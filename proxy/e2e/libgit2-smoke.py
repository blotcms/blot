# A smoke test through libgit2 (pygit2), the git stack Working Copy for iOS is
# built on (its App Store release notes list the libgit2 versions it ships), so
# a non-CLI client is exercised against the same proxy and app image as
# git-checks.js: clone, push a new post, fetch it into a second clone, then see
# it on the blog. Email + token Basic auth over TLS (the proxy's self-signed
# placeholder cert is accepted by the certificate callback).
#
#   BLOT_HOST, PROXY_ORIGIN, E2E_GIT_EMAIL, E2E_GIT_HANDLE, E2E_GIT_TOKEN,
#   E2E_GIT_BLOG_HOST: as in git-checks.js
import os, ssl, sys, tempfile, time, urllib.request, uuid

import pygit2

HOST = os.environ.get("BLOT_HOST", "localhost")
ORIGIN = os.environ.get("PROXY_ORIGIN", "https://127.0.0.1")
EMAIL = os.environ.get("E2E_GIT_EMAIL", "e2e@example.com")
HANDLE = os.environ["E2E_GIT_HANDLE"]
TOKEN = os.environ["E2E_GIT_TOKEN"]
BLOG_HOST = os.environ.get("E2E_GIT_BLOG_HOST", HANDLE + "." + HOST)
URL = "https://%s/clients/git/end/%s.git" % (HOST, HANDLE)

failures = 0


def check(name, ok, detail=""):
    global failures
    if ok:
        print("  ok  -", name)
    else:
        failures += 1
        print("  FAIL -", name, "->", str(detail).replace(TOKEN, "***"))


class Callbacks(pygit2.RemoteCallbacks):
    def credentials(self, url, username_from_url, allowed_types):
        return pygit2.UserPass(EMAIL, TOKEN)

    def certificate_check(self, certificate, valid, host):
        return True


def blog_index():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(ORIGIN + "/", headers={"Host": BLOG_HOST, "User-Agent": "blot-git-e2e"})
    with urllib.request.urlopen(req, context=ctx, timeout=20) as res:
        return res.status, res.read().decode("utf8", "replace")


def wait_for(pred, timeout=90):
    deadline = time.time() + timeout
    last = "never ran"
    while time.time() < deadline:
        try:
            status, body = blog_index()
            if status == 200 and pred(body):
                return True, "status %s" % status
            last = "status %s, body %r" % (status, body[:200])
        except Exception as e:  # keep polling until the deadline
            last = repr(e)
        time.sleep(1)
    return False, last


print("  libgit2 %s, pygit2 %s" % (pygit2.LIBGIT2_VERSION, pygit2.__version__))
root = tempfile.mkdtemp(prefix="blot-libgit2-")
cb = Callbacks()
sig = pygit2.Signature("E2E", "e2e@example.com")

try:
    a = pygit2.clone_repository(URL, os.path.join(root, "a"), callbacks=cb)
    check("libgit2 clone through the proxy succeeds", True)
except Exception as e:
    check("libgit2 clone through the proxy succeeds", False, e)
    sys.exit(1)

check(
    "clone has the file the repository was created with",
    os.path.exists(os.path.join(root, "a", "seeded.txt")),
)
b = pygit2.clone_repository(URL, os.path.join(root, "b"), callbacks=cb)

title = "libgit2 pushed post " + uuid.uuid4().hex[:6]
with open(os.path.join(root, "a", "libgit2.txt"), "w") as f:
    f.write("Title: %s\nDate: 2021-01-01\n\nPushed with libgit2.\n" % title)
a.index.add_all()
a.index.write()
tree = a.index.write_tree()
commit = a.create_commit("HEAD", sig, sig, "add post", tree, [a.head.target])

try:
    a.remotes["origin"].push(["refs/heads/master:refs/heads/master"], callbacks=cb)
    check("libgit2 push of a new post succeeds", True)
except Exception as e:
    check("libgit2 push of a new post succeeds", False, e)

ok, detail = wait_for(lambda t: title in t)
check("pushed post appears on the blog", ok, detail)

try:
    b.remotes["origin"].fetch(callbacks=cb)
    got = b.references.get("refs/remotes/origin/master")
    check(
        "libgit2 fetch in a second clone brings in the pushed commit",
        got is not None and got.target == commit,
        "have %s want %s" % (got.target if got else None, commit),
    )
except Exception as e:
    check("libgit2 fetch in a second clone brings in the pushed commit", False, e)

print("\n%d failed" % failures)
sys.exit(1 if failures else 0)
