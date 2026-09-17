import { Container, getContainer } from "@cloudflare/containers";

// Mayfly's SQLite file is in this container, NOT in Durable Object storage.
// celld destroys that file on a node restart or move. See celld/README.md.
export class MayflyContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "24h";
  enableInternet = false;

  fetch(request) {
    // Request.redirect is not preserved across celld's Durable Object hop.
    // Mayfly's creators require the original 303 from POST /new.
    return super.fetch(new Request(request, { redirect: "manual" }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // The container's HTTP transport changes its destination. Preserve the
    // external origin for Mayfly's instructions and cross-origin checks.
    headers.set("Host", url.host);
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
    if (env.TRUST_PROXY !== "1") headers.delete("X-Forwarded-For");
    headers.delete("Forwarded");
    // This SDK control header must not let visitors choose a container port.
    headers.delete("cf-container-target-port");

    // All paths must reach the SAME Go process/database, including /new and
    // /c/:id. Random or per-path placement would lose access to created chats.
    return getContainer(env.MAYFLY, "mayfly").fetch(
      new Request(request, { headers, redirect: "manual" }),
    );
  },
};
