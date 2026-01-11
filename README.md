# romm-sfu-server

SFU server built for EmulatorJS Netplay (mediasoup + socket.io).

## Docker

This repo now includes a Docker build so you can run the SFU as a container.

- Build: `docker build -t emulatorjs-sfu .`
- Run (example): `docker run --rm -p 3001:3001 -p 20000:20000/udp -p 20000:20000/tcp emulatorjs-sfu`

There is also a ready-to-copy compose file: `docker-compose.example.yml`.

### Compose quickstart (minimal)

This SFU is "secure by default": auth is always required, so you only need to provide:

- `ROMM_AUTH_SECRET_KEY` (must match RomM)
- `VALKEY_SFU_PASSWORD` (Redis/Valkey password for the `sfu` user)

Everything else has sensible defaults (ports, takeover grace window, STUN default).

Example:

- `ROMM_AUTH_SECRET_KEY=... VALKEY_SFU_PASSWORD=... docker compose up -d`

## Ports

- **Signaling (HTTP + socket.io)**: `PORT` (default `3001`)
- **WebRTC media (mediasoup WebRtcServer)**: `WEBRTC_PORT` (default `20000`)

When `USE_WEBRTC_SERVER` is enabled (default), all WebRTC transports share the same UDP
listening port. This lets you open a single UDP port in your firewall/NAT instead of a range.

## Environment variables

- `USE_WEBRTC_SERVER` (default `1`): set to `0` to disable WebRtcServer and fall back to per-transport listen IPs.
- `LISTEN_IP` (default `0.0.0.0`): bind address for WebRtcServer.
- `ANNOUNCED_IP`: public IP/hostname to advertise in ICE candidates.
  - If clients connect over the public internet and the SFU is behind NAT (typical home server / VPS behind a proxy), you almost always need this.
  - If all clients are on the same LAN and can reach the SFU directly by its LAN IP, you can usually omit it.
- `SFU_STUN_SERVERS` (optional): STUN servers for clients, comma/space separated (example: `stun.l.google.com:19302,stun1.example.com:3478`).
  If unset, defaults to `stun.l.google.com:19302`. Values are forced to STUN; any `turn:` / `turns:` entries are ignored.
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

This server can run as multiple SFU nodes (horizontal scaling) using a Redis-backed
room registry. Each room is "sticky" to the node that created it.

How it works:

- When a room is opened, that node registers `room_name -> { url, nodeId }` in Redis with a TTL.
- Other nodes can list rooms cluster-wide via `/list` and resolve a room via `/resolve?room=...`.
- If a client tries to `join-room` on a node that doesn't host the room, the server emits `room-redirect`
  and also returns `{ redirect: <url> }` via the join callback.

### Registry environment variables

- `REDIS_URL`: enable the registry (example: `redis://romm:<password>@127.0.0.1:6379/0`)
- `PUBLIC_URL`: the public signaling URL for this node (example: `https://sfu-2.example.com`)
- `NODE_ID` (optional): stable id for this node (defaults to a random UUID)
- `ROOM_REGISTRY_KEY_PREFIX` (default `romm:sfu:room:`): Redis key prefix
- `ROOM_REGISTRY_TTL_SECONDS` (default `60`): TTL for room registry entries

### Notes

- If your Redis/Valkey uses ACLs and the `default` user is disabled (for example, `user default off`),
  `REDIS_URL` must include `username:password@...` or registry operations will fail with `NOAUTH`.
- `REDIS_URL` is intended for the optional _room registry_ (multi-node). For SFU auth allowlist,
  prefer `SFU_AUTH_REDIS_*` (or `SFU_AUTH_REDIS_URL`) so auth does not depend on registry settings.
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

## Auth Redis URL format (SFU_REQUIRE_AUTH)

Auth mode requires BOTH a JWT secret and an auth Redis connection.

- Secret: `ROMM_AUTH_SECRET_KEY` (or `SFU_AUTH_SECRET_KEY`)
- Redis:
  - Preferred: `SFU_AUTH_REDIS_HOST/PORT/DB/USERNAME/PASSWORD`
  - `SFU_AUTH_REDIS_URL` (recommended if you already have a full URL)
  - Backwards-compat: if neither is set, the server falls back to `REDIS_URL`

If you use a URL (`SFU_AUTH_REDIS_URL` / `REDIS_URL`), the format is:

- `redis://[username[:password]@]host:port/db`
- `rediss://[username[:password]@]host:port/db`

Note: URL form requires percent-encoding special characters in the password. Using the
`VALKEY_SFU_PASSWORD` env var (or `SFU_AUTH_REDIS_PASSWORD`) avoids that requirement.
