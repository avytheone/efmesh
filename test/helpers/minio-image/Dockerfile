FROM golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848 AS build

WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin refs/tags/RELEASE.2025-10-15T17-29-55Z \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN go mod download && go mod verify
RUN MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go 2025-10-15T17:29:55Z > /tmp/ldflags \
    && go build -mod=readonly -tags kqueue -trimpath -ldflags "$(cat /tmp/ldflags)" -o /out/minio .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=build /out/minio /usr/bin/minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]
