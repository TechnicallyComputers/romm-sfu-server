# romm-sfu-server

SFU server built for EmulatorJS Netplay (mediasoup + socket.io).

## Docker

This repo now includes a Docker build so you can run the SFU as a container.

- Build: `docker build -t emulatorjs-sfu .`
- Run (example): `docker run --rm -p 3001:3001 -p 20000:20000/udp -p 20000:20000/tcp emulatorjs-sfu`

There is also a ready-to-copy compose file: `docker-compose.example.yml`.

### Compose quickstart (minimal)

This SFU is "secure by default": auth is always required.

The SFU does **not** connect to Redis/Valkey directly. Instead, it calls back into RomM's
internal SFU API to validate JWT/JTI and to store/resolve room registry records.

You only need to provide:

- `ROMM_API_BASE_URL` (RomM base URL reachable from the SFU container, e.g. `http://romm:8080`)
- `ROMM_SFU_INTERNAL_SECRET` (shared secret for SFU->RomM calls; must NOT be `ROMM_AUTH_SECRET_KEY`)

Everything else has sensible defaults (ports, takeover grace window, STUN default).

Example:

- `ROMM_API_BASE_URL=http://romm:8080 ROMM_SFU_INTERNAL_SECRET=... docker compose up -d`

## Ports

- **Signaling (HTTP + socket.io)**: `PORT` (default `3001`)
- **WebRTC media (mediasoup WebRtcServer)**: `WEBRTC_PORT` (default `20000`)

When `USE_WEBRTC_SERVER` is enabled (default), all WebRTC transports share the same UDP
listening port. This lets you open a single UDP port in your firewall/NAT instead of a range.

## Environment variables

**📖 For complete environment variable documentation, see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)**

Quick reference:

- `USE_WEBRTC_SERVER` (default `1`): set to `0` to disable WebRtcServer and fall back to per-transport listen IPs.
- `LISTEN_IP` (default `0.0.0.0`): bind address for WebRtcServer.
- `ANNOUNCED_IP`: public IP/hostname to advertise in ICE candidates.
  - If clients connect over the public internet and the SFU is behind NAT (typical home server / VPS behind a proxy), you almost always need this.
  - If all clients are on the same LAN and can reach the SFU directly by its LAN IP, you can usually omit it.
- `SFU_STUN_SERVERS` (optional): STUN servers for clients, comma/space separated (example: `stun.l.google.com:19302,stun1.example.com:3478`).
  If unset, defaults to `stun.l.google.com:19302`.
- TURN servers (optional): configure via either `SFU_TURN_SERVERS` (recommended) or numbered env vars.
  - Recommended (arbitrary count): `SFU_TURN_SERVERS` as JSON array of RTCIceServer objects.
    Example:
    - `SFU_TURN_SERVERS=[{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"user","credential":"pass"}]`
  - Simple fallback (up to 4):
    - `SFU_TURN_SERVER1=turn:turn.example.com:3478?transport=udp`
    - `SFU_TURN_USER1=user`
    - `SFU_TURN_PASS1=pass`
    - Repeat for `2..4`.
      Notes:
  - TURN credentials are delivered to clients as part of the WebRTC config. Prefer short-lived credentials (TURN REST API) if possible.
- `WEBRTC_PORT` (default `20000`): shared WebRTC media port (UDP + TCP).
- `WEBRTC_UDP_PORT` (optional): override UDP port (defaults to `WEBRTC_PORT`).
- `ENABLE_WEBRTC_TCP` (default `1`): set to `0` to disable TCP candidates.
- `WEBRTC_TCP_PORT` (optional): override TCP port (defaults to `WEBRTC_PORT`).
- `RTC_MIN_PORT` / `RTC_MAX_PORT` (defaults `20000` / `20200`): mediasoup worker RTC port range. Not relevent when using WebRtcServer

### Optional policy guards

These are intentionally **opt-in**: the SFU is client-driven and does not force what the host sends.
They exist to help operators detect/deny unexpected client behavior in mixed-client deployments.

- `SFU_EXPECT_VP9_SVC_MODE` (optional): if set, compare VP9 `scalabilityMode` against this value (example: `L2T3`).
- `SFU_ENFORCE_VP9_SVC_MODE` (default `0`): set to `1` to reject VP9 producers whose `scalabilityMode` doesn't match `SFU_EXPECT_VP9_SVC_MODE`.
- `SFU_ENFORCE_2_LAYER_SIMULCAST` (default `0`): set to `1` to reject simulcast producers that publish anything other than 2 encodings.

### Data channel payloads

RomM netplay data channels are expected to be binary only.

- `SFU_REQUIRE_BINARY_DATA_CHANNEL` (default `1`): set to `0` to allow text messages over data channels. When enabled, any dataProducer that sends a text/non-binary payload is immediately closed.

## Multi-node / scaling

This server can run as multiple SFU nodes (horizontal scaling) using a RomM-backed
room registry. Each room is "sticky" to the node that created it.

How it works:

- When a room is opened, that node registers `room_name -> { url, nodeId }` in RomM (with a TTL).
- Other nodes can list rooms cluster-wide via `/list` and resolve a room via `/resolve?room=...`.
- If a client tries to `join-room` on a node that doesn't host the room, the server emits `room-redirect`
  and also returns `{ redirect: <url> }` via the join callback.

### Registry environment variables

- `ROMM_API_BASE_URL`: enable the registry (example: `http://romm:8080`)
- `ROMM_SFU_INTERNAL_SECRET`: secret for SFU->RomM internal API calls
- `PUBLIC_URL`: the public signaling URL for this node (example: `https://sfu-2.example.com`)
- `NODE_ID` (optional): stable id for this node (defaults to a random UUID)
- `ROOM_REGISTRY_TTL_SECONDS` (default `60`): refresh interval hint for re-upserts

### Notes

- For best results, put your SFU nodes behind a load balancer for initial connections.
  Once a client knows the room host, it should connect directly to that node's `PUBLIC_URL`.
- True cross-node media forwarding (a single room spanning multiple nodes) is not implemented here;
  this design distributes load by spreading rooms across nodes.

## Firewall/NAT quick guide

- Open `TCP PORT` (default `3001`) to clients for signaling.
- Open `UDP WEBRTC_UDP_PORT` (default `20000`) to clients for media.
- If you keep TCP candidates enabled, also open `TCP WEBRTC_TCP_PORT`.

**Common gotcha:** if gameplay works on your LAN but fails for remote clients, set `ANNOUNCED_IP` to the public IP/hostname that remote clients use to reach you.

## Mobile network switching (WiFi <-> LTE/5G)

When SFU auth is enabled, the server allows an immediate "takeover" reconnect for the
same authenticated `userid` even if the previous Socket.IO connection is still alive.
This avoids spurious `userid in use` errors during fast network transitions.

- `SFU_ALLOW_AUTH_TAKEOVER` (default `1`): set to `0` to disable takeover and enforce a strict single
  active Socket.IO connection per `userid`.

- `SFU_AUTH_TAKEOVER_GRACE_SECONDS` (default `30`): when takeover is enabled, only allow it if the
  existing connection looks "stale" and the overlap is recent. This helps avoid surprise takeovers
  when the same account is used from another device. Set to `0` to remove the grace window.

## JTI Token Implementation

The SFU implements JWT ID (JTI) based authentication with RomM for secure netplay sessions.

### Token Types

- **Read Tokens** (`sfu:read`): 15-minute expiry for room listings and metadata access

  - Validated via JWT signature only (no Redis storage)
  - Used for non-destructive operations like viewing available rooms

- **Write Tokens** (`sfu:write`): 30-second expiry for room creation and joining
  - Stored in Redis as simple string markers for one-time use enforcement
  - Required for room operations to prevent replay attacks

### Redis Storage

Write tokens are stored in Redis using `SET` with expiration:

`SET sfu:auth:jti:<uuid> "0" EX 30`

- **Key format**: `sfu:auth:jti:{jti}` where `{jti}` is the JWT ID claim
- **Value**: Simple string `"0"` (marker for valid/unused token)
- **Expiration**: 30 seconds for write tokens

### Token Consumption

When a write token is consumed (room creation/joining), it's deleted from Redis:

// SFU calls RomM API with consume=true
const result = await fetch('/api/sfu/internal/verify', {
method: 'POST',
body: JSON.stringify({ token, consume: true })
});

RomM then executes: DEL sfu:auth:jti:<uuid>
If DEL returns 1: Token was valid and consumed
If DEL returns 0: Token was already used or never existed

### Security Benefits

Replay Attack Prevention: Each write token can only be used once
Short Expiration: Write tokens expire quickly to limit attack windows
Atomic Operations: Redis DEL ensures race-condition-free consumption
Stateless Verification: Read tokens validated purely by JWT signature

### Error Handling

The SFU handles authentication failures by triggering token refresh in the client:

```
// In room listing/joining error handlers
if (window.handleSfuAuthError) {
  window.handleSfuAuthError("read"); // or "write"
}
```

This prompts the RomM frontend to request new tokens and update cookies automatically.

## RomM internal API auth

The SFU talks to RomM using a shared secret header:

- Header: `x-romm-sfu-secret: <secret>`
- Secret: `ROMM_SFU_INTERNAL_SECRET`
