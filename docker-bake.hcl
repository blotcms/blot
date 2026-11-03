# The unit image and the OpenResty stage it is assembled from, built together by
# .github/workflows/unit-image.yml: `docker buildx bake unit` (after
# proxy/build/build.sh has generated the proxy's config). The root Dockerfile's
# `FROM blot-proxy AS proxy` resolves to the proxy target below instead of an
# image. See "The unit image" in proxy/README.md for a local build.
#
# The versions come from config/versions.env, which bake reads from the
# environment (.github/actions/versions puts it there; locally,
# `set -a; . config/versions.env; set +a`). They have no defaults, so a build
# without them fails.
variable "NODE_BASE" {}
variable "PANDOC_VERSION" {}
variable "NSJAIL_VERSION" {}
variable "NSJAIL_COMMIT" {}
variable "OPENRESTY_VERSION" {}
variable "OPENRESTY_SHA256" {}
variable "NGINX_VERSION" {}
variable "RESTY_OPENSSL_VERSION" {}
variable "RESTY_OPENSSL_SHA256" {}
variable "RESTY_OPENSSL_PATCH_VERSION" {}
variable "RESTY_OPENSSL_PATCH_SHA256" {}
variable "RESTY_PCRE_VERSION" {}
variable "RESTY_PCRE_SHA256" {}
variable "DEHYDRATED_TAG" {}
variable "SOCKPROC_COMMIT" {}
variable "NGX_BROTLI_COMMIT" {}

target "proxy" {
  context    = "proxy"
  dockerfile = "Dockerfile"
  platforms  = ["linux/arm64"]
  args = {
    NODE_BASE                   = NODE_BASE
    OPENRESTY_VERSION           = OPENRESTY_VERSION
    OPENRESTY_SHA256            = OPENRESTY_SHA256
    NGINX_VERSION               = NGINX_VERSION
    RESTY_OPENSSL_VERSION       = RESTY_OPENSSL_VERSION
    RESTY_OPENSSL_SHA256        = RESTY_OPENSSL_SHA256
    RESTY_OPENSSL_PATCH_VERSION = RESTY_OPENSSL_PATCH_VERSION
    RESTY_OPENSSL_PATCH_SHA256  = RESTY_OPENSSL_PATCH_SHA256
    RESTY_PCRE_VERSION          = RESTY_PCRE_VERSION
    RESTY_PCRE_SHA256           = RESTY_PCRE_SHA256
    DEHYDRATED_TAG              = DEHYDRATED_TAG
    SOCKPROC_COMMIT             = SOCKPROC_COMMIT
    NGX_BROTLI_COMMIT           = NGX_BROTLI_COMMIT
  }
}

target "unit" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "unit"
  platforms  = ["linux/arm64"]
  args = {
    NODE_BASE      = NODE_BASE
    PANDOC_VERSION = PANDOC_VERSION
    NSJAIL_VERSION = NSJAIL_VERSION
    NSJAIL_COMMIT  = NSJAIL_COMMIT
  }
  contexts = {
    blot-proxy = "target:proxy"
  }
}
