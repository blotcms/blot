# The unit image and the OpenResty stage it is assembled from, built together by
# .github/workflows/unit-image.yml: `docker buildx bake unit` (after
# proxy/build/build.sh has generated the proxy's config). The root Dockerfile's
# `FROM blot-proxy AS proxy` resolves to the proxy target below instead of an
# image. See "The unit image" in proxy/README.md for a local build.
target "proxy" {
  context    = "proxy"
  dockerfile = "Dockerfile"
  platforms  = ["linux/arm64"]
}

target "unit" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "unit"
  platforms  = ["linux/arm64"]
  contexts = {
    blot-proxy = "target:proxy"
  }
}
