FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY srv/ ./srv/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mayfly ./cmd/mayfly
RUN mkdir /out/data && chown 65532:65532 /out/data

FROM scratch
COPY LICENSE /LICENSE
COPY --from=build /out/mayfly /mayfly
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["/mayfly", "-listen", "0.0.0.0:8080", "-db", "/data/mayfly.sqlite3", "-trust-proxy"]
