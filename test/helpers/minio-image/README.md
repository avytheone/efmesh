# MinIO integration test image

The S3 suite builds MinIO from its official source release because the former
Docker Hub image is no longer publicly accessible. No prebuilt MinIO binary or
third-party MinIO image is used. The source is unmodified and its AGPLv3 license
is included in the runtime image.

- Release: `RELEASE.2025-10-15T17-29-55Z`
- Source commit: `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`
- Upstream source: <https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a>
- Source-build instructions: <https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z>

The Dockerfile pins the official Go builder and Alpine runtime by digest, checks
that the release resolves to the expected commit, verifies Go modules against
upstream `go.sum`, and compiles with the upstream release metadata generator and
build flags. The upstream wrapper Dockerfile depends on `minio/minio:latest`;
this test-only packaging instead uses the documented `go build` path directly.

From the repository root:

```sh
docker build -t efmesh-test-minio:9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a test/helpers/minio-image
docker run --rm --network none efmesh-test-minio:9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a --version
bun test
```

`startMinio` runs the same cached build automatically. The first build downloads
the Go toolchain image and upstream module sources and can take several minutes;
the S3 setup hook allows ten minutes. Docker must have access to Docker Hub,
GitHub, and the standard Go module proxy/checksum service. No host Go installation,
registry login, privileged container, or daemon configuration change is needed.
The test uses a temporary data directory and a free loopback port, then removes
its own container and data. This image is a test dependency, not a production
deployment recommendation.
