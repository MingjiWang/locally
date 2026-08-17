/* ------------------------------------------------------------------
   Standalone signaling Worker: defines the SignalRoom Durable Object
   that brokers the WebRTC handshake between two peers sharing a
   6-digit code.

   The Pages project binds to this Worker's Durable Object (via
   `script_name` in the Pages wrangler.toml), so the browser keeps
   talking to same-origin /api/ws. This Worker's own fetch handler also
   works directly (wss://<worker-url>/?code=NNNNNN&role=host|guest),
   which is handy for `wrangler dev` and as a fallback.

   The broker only relays SDP/ICE handshake blobs - it never sees file
   names or file bytes (those go peer-to-peer over encrypted WebRTC).
   ------------------------------------------------------------------ */

const ROOM_TTL_MS = 10 * 60 * 1000; // rooms auto-reset after 10 min idle

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.host = null;   // host WebSocket (the sender)
    this.guest = null;  // guest WebSocket (the receiver)
    this.createdAt = Date.now();
  }

  peerOf(ws) {
    return ws === this.host ? this.guest : this.host;
  }

  send(ws, obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (_) { /* ignore */ }
  }

  maybePair() {
    if (
      this.host && this.guest &&
      this.host.readyState === 1 && this.guest.readyState === 1
    ) {
      this.send(this.host, { type: "peer-ready" });
      this.send(this.guest, { type: "peer-ready" });
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    // Reset a stale room so old codes can be reused.
    if (Date.now() - this.createdAt > ROOM_TTL_MS) {
      this.host = null;
      this.guest = null;
      this.createdAt = Date.now();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === "host") {
      if (this.host && this.host.readyState === 1) {
        this.send(server, { type: "error", reason: "code-taken" });
        server.close(4001, "code-taken");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.host = server;
      this.createdAt = Date.now();
      this.send(server, { type: "created" });
      this.maybePair();
    } else if (role === "guest") {
      if (!this.host || this.host.readyState !== 1) {
        this.send(server, { type: "error", reason: "code-not-found" });
        server.close(4004, "code-not-found");
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.guest && this.guest.readyState === 1) {
        this.send(server, { type: "error", reason: "room-full" });
        server.close(4002, "room-full");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.guest = server;
      this.send(server, { type: "joined" });
      this.maybePair();
    } else {
      server.close(4000, "bad-role");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Relay every subsequent message verbatim to the other peer. These
    // are the client-generated { type: "signal", ... } handshake blobs.
    server.addEventListener("message", (evt) => {
      const peer = this.peerOf(server);
      if (peer && peer.readyState === 1) {
        try { peer.send(evt.data); } catch (_) { /* ignore */ }
      }
    });

    const onGone = () => {
      const peer = this.peerOf(server);
      if (server === this.host) this.host = null;
      if (server === this.guest) this.guest = null;
      this.send(peer, { type: "peer-left" });
    };
    server.addEventListener("close", onGone);
    server.addEventListener("error", onGone);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code || !/^\d{6}$/.test(code)) {
      return new Response("Bad or missing 6-digit code", { status: 400 });
    }
    const id = env.SIGNAL_ROOMS.idFromName(code);
    const stub = env.SIGNAL_ROOMS.get(id);
    return stub.fetch(request);
  },
};
