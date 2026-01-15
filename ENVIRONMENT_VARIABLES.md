# romm-sfu-server Environment Variables

Complete reference for all environment variables supported by the romm-sfu-server.

## Table of Contents

- [Required Variables](#required-variables)
- [Server Configuration](#server-configuration)
- [WebRTC Configuration](#webrtc-configuration)
- [Worker & Scaling](#worker--scaling)
- [ICE Servers (STUN/TURN)](#ice-servers-stunturn)
- [Authentication](#authentication)
- [Room Registry (Multi-node)](#room-registry-multi-node)
- [Logging & Debugging](#logging--debugging)
- [Policy Guards](#policy-guards)
- [Data Channel Policy](#data-channel-policy)

---

## Required Variables

These variables are required for the SFU to function with RoMM authentication.

| Variable                   | Description                                                                                                                                                     | Example                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ROMM_API_BASE_URL`        | Base URL of the RoMM API server (reachable from SFU container). Used for token verification and room registry.                                                  | `http://romm:8080` or `https://romm.example.com` |
| `ROMM_SFU_INTERNAL_SECRET` | Shared secret for SFU→RoMM internal API calls. Must match `ROMM_SFU_INTERNAL_SECRET` in RoMM configuration. **Must NOT be the same as `ROMM_AUTH_SECRET_KEY`**. | `your-secret-key-here`                           |

**Note:** The SFU can run without these variables, but authentication will fail. For standalone testing without RoMM, you would need to modify the code.

---

## Server Configuration

| Variable    | Default   | Description                                                                                                             |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`      | `3001`    | HTTP signaling port for Socket.IO and REST endpoints. This is the main port clients connect to.                         |
| `LISTEN_IP` | `0.0.0.0` | IP address to bind WebRtcServer to. Use `0.0.0.0` to listen on all interfaces, or a specific IP for a single interface. |

---

## WebRTC Configuration

### WebRtcServer (Recommended)

When `USE_WEBRTC_SERVER=1` (default), all WebRTC transports share the same UDP/TCP ports, simplifying firewall configuration.

| Variable            | Default       | Description                                                                                                                                                                                                                   |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USE_WEBRTC_SERVER` | `1`           | Enable mediasoup WebRtcServer mode. Set to `0` to disable and use per-transport listen IPs (requires `ANNOUNCED_IP`). **Required when `SFU_WORKER_COUNT > 1`**.                                                               |
| `WEBRTC_PORT`       | `20000`       | Base port for WebRTC media (UDP and TCP). Each worker uses `WEBRTC_PORT + worker_index`.                                                                                                                                      |
| `WEBRTC_UDP_PORT`   | `WEBRTC_PORT` | Override UDP port specifically. Defaults to `WEBRTC_PORT` if not set.                                                                                                                                                         |
| `WEBRTC_TCP_PORT`   | `WEBRTC_PORT` | Override TCP port specifically. Defaults to `WEBRTC_PORT` if not set.                                                                                                                                                         |
| `ENABLE_WEBRTC_TCP` | `1`           | Enable TCP candidates for WebRTC. Set to `0` to disable TCP (UDP only).                                                                                                                                                       |
| `ANNOUNCED_IP`      | _(none)_      | **Critical for NAT/firewall setups.** Public IP address or hostname that clients use to reach the SFU. Required when SFU is behind NAT or a reverse proxy. If unset and `USE_WEBRTC_SERVER=0`, the server will fail to start. |

**Example (behind NAT):**

```bash
ANNOUNCED_IP=203.0.113.1  # Your public IP
# or
ANNOUNCED_IP=sfu.example.com  # Your public hostname
```

### Per-Transport Mode (Legacy)

When `USE_WEBRTC_SERVER=0`, each transport gets its own port allocation.

| Variable       | Default | Description                                                              |
| -------------- | ------- | ------------------------------------------------------------------------ |
| `RTC_MIN_PORT` | `20000` | Minimum port in the range used by mediasoup workers for RTC allocations. |
| `RTC_MAX_PORT` | `20200` | Maximum port in the range used by mediasoup workers for RTC allocations. |

**Note:** These are only relevant when `USE_WEBRTC_SERVER=0`. With WebRtcServer enabled, ports are managed per-worker based on `WEBRTC_PORT`.

---

## Worker & Scaling

| Variable                      | Default | Description                                                                                                                                          |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SFU_WORKER_COUNT`            | `1`     | Number of mediasoup workers to spawn. Auto-detects CPU cores if not set. Capped to available CPU cores. **Requires `USE_WEBRTC_SERVER=1` when > 1**. |
| `SFU_FANOUT_ENABLED`          | `0`     | Enable cross-worker fan-out for large rooms. When enabled, viewers can be distributed across workers to reduce load on the primary worker.           |
| `SFU_FANOUT_VIEWER_THRESHOLD` | `500`   | Minimum room size (player count) before fan-out distributes viewers to secondary workers. Only relevant when `SFU_FANOUT_ENABLED=1`.                 |

**Worker Selection:**

- Workers are selected using a least-loaded strategy
- Each room is assigned to a primary worker
- Players typically use the room's primary worker
- Viewers (when fan-out is enabled) may be assigned to secondary workers

---

## ICE Servers (STUN/TURN)

ICE servers are used by WebRTC clients for NAT traversal and media relay.

### STUN Servers

| Variable           | Default                        | Description                                                                                 |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `SFU_STUN_SERVERS` | `stun:stun.l.google.com:19302` | Comma or space-separated list of STUN server URLs. Falls back to `STUN_SERVERS` if not set. |
| `STUN_SERVERS`     | _(none)_                       | Alternative name for `SFU_STUN_SERVERS` (for compatibility).                                |

**Format:** Space or comma-separated URLs. Examples:

```bash
SFU_STUN_SERVERS="stun:stun.l.google.com:19302 stun:stun1.example.com:3478"
# or
SFU_STUN_SERVERS="stun:stun.l.google.com:19302,stun:stun1.example.com:3478"
```

### TURN Servers

TURN servers relay media when direct peer-to-peer connections fail. Two configuration methods are supported:

#### Method 1: JSON Array (Recommended)

| Variable           | Description                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `SFU_TURN_SERVERS` | JSON array of RTCIceServer objects. Supports multiple servers with different credentials. |

**Example:**

```bash
SFU_TURN_SERVERS='[{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"user","credential":"pass"}]'
```

#### Method 2: Numbered Variables (Simple)

Up to 4 TURN servers can be configured using numbered variables:

| Variable           | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `SFU_TURN_SERVER1` | TURN server URL(s) for server 1 (space/comma-separated) |
| `SFU_TURN_USER1`   | Username for TURN server 1                              |
| `SFU_TURN_PASS1`   | Password/credential for TURN server 1                   |
| `SFU_TURN_SERVER2` | _(repeat for servers 2-4)_                              |
| `SFU_TURN_USER2`   |                                                         |
| `SFU_TURN_PASS2`   |                                                         |
| `SFU_TURN_SERVER3` |                                                         |
| `SFU_TURN_USER3`   |                                                         |
| `SFU_TURN_PASS3`   |                                                         |
| `SFU_TURN_SERVER4` |                                                         |
| `SFU_TURN_USER4`   |                                                         |
| `SFU_TURN_PASS4`   |                                                         |

**Example:**

```bash
SFU_TURN_SERVER1="turn:turn.example.com:3478?transport=udp turn:turn.example.com:3478?transport=tcp"
SFU_TURN_USER1="myuser"
SFU_TURN_PASS1="mypass"
```

**Security Note:** TURN credentials are delivered to clients as part of the WebRTC configuration. Prefer short-lived credentials (TURN REST API) when possible.

---

## Authentication

The SFU uses JWT tokens issued by RoMM for authentication. These variables configure the authentication behavior.

| Variable                          | Default         | Description                                                                                                                                                                                                               |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SFU_AUTH_ISSUER`                 | `romm:sfu`      | Expected JWT issuer claim. Must match the issuer used by RoMM when minting tokens.                                                                                                                                        |
| `SFU_AUTH_JTI_KEY_PREFIX`         | `sfu:auth:jti:` | Redis key prefix for JWT JTI allowlist entries. Used when verifying tokens via RoMM API.                                                                                                                                  |
| `SFU_AUTH_CLOCK_SKEW_SECONDS`     | `5`             | Clock skew tolerance in seconds for JWT expiration checks. Accounts for minor time differences between servers.                                                                                                           |
| `SFU_ALLOW_AUTH_TAKEOVER`         | `1`             | Allow reconnecting sockets to take over existing connections for the same authenticated userid. Useful for mobile network switching (WiFi ↔ LTE/5G). Set to `0` to enforce strict single connection per userid.           |
| `SFU_AUTH_TAKEOVER_GRACE_SECONDS` | `30`            | Grace window in seconds for auth takeover. Only allows takeover if the existing connection appears stale (no recent activity) and the overlap is within this window. Set to `0` to remove grace window (not recommended). |

**Takeover Behavior:**

- When enabled, a reconnecting client with the same authenticated userid can replace a stale connection
- Helps avoid "userid in use" errors during network transitions
- The grace window prevents surprise takeovers when the same account is used from multiple devices

---

## Room Registry (Multi-node)

These variables enable multi-node deployments where multiple SFU servers share a room registry via RoMM's Redis.

| Variable                    | Default                 | Description                                                                                                                                                                |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROMM_API_BASE_URL`         | _(none)_                | Base URL of RoMM API. **Required for room registry.** Also used for authentication.                                                                                        |
| `ROMM_SFU_INTERNAL_SECRET`  | _(none)_                | Shared secret for SFU→RoMM API calls. **Required for room registry.**                                                                                                      |
| `PUBLIC_URL`                | `http://localhost:PORT` | Public signaling URL that clients should use to reach this SFU node. Required in multi-node deployments behind a load balancer. Should be the external URL, not localhost. |
| `NODE_ID`                   | _(random UUID)_         | Stable identifier for this SFU node. Used in room registry to distinguish nodes. If not set, a random UUID is generated on startup.                                        |
| `ROOM_REGISTRY_TTL_SECONDS` | `60`                    | TTL in seconds for room registry entries in Redis. Rooms are re-upserted periodically (at half this interval) to keep them alive.                                          |

**Multi-node Setup:**

1. Set `ROMM_API_BASE_URL` and `ROMM_SFU_INTERNAL_SECRET` on all nodes
2. Set unique `PUBLIC_URL` for each node (e.g., `https://sfu-1.example.com`, `https://sfu-2.example.com`)
3. Optionally set stable `NODE_ID` for each node
4. Place nodes behind a load balancer for initial connections
5. Clients will be redirected to the correct node when joining rooms

**Room Resolution:**

- When a client tries to join a room on the wrong node, the server emits `room-redirect` with the correct node URL
- Clients should reconnect to the correct node's `PUBLIC_URL`

---

## Logging & Debugging

| Variable          | Default | Description                                                                                                                                   |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`       | `warn`  | Logging verbosity. Options: `debug`, `info`, `warn`, `error`, `silent`. Default is intentionally quiet to avoid flooding logs.                |
| `SFU_DEBUG_STATS` | `0`     | Enable detailed RTP statistics logging. Set to `1` to log producer/consumer stats every 2 seconds. **Very verbose** - use only for debugging. |

**Log Levels:**

- `debug`: Most verbose, includes all debug messages
- `info`: Informational messages (worker creation, room events)
- `warn`: Warnings and non-critical errors (default)
- `error`: Only errors
- `silent`: No logging

---

## Policy Guards

These variables enable optional validation of client RTP parameters. They are **opt-in** - the SFU is client-driven and does not force encoding parameters by default. Use these to detect or reject unexpected client behavior in mixed-client deployments.

| Variable                        | Default  | Description                                                                                                                                                          |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SFU_EXPECT_VP9_SVC_MODE`       | _(none)_ | Expected VP9 scalability mode (e.g., `L2T3`). If set, VP9 producers with a different mode will trigger a warning or error (depending on `SFU_ENFORCE_VP9_SVC_MODE`). |
| `SFU_ENFORCE_VP9_SVC_MODE`      | `0`      | Set to `1` to reject VP9 producers whose `scalabilityMode` doesn't match `SFU_EXPECT_VP9_SVC_MODE`. Requires `SFU_EXPECT_VP9_SVC_MODE` to be set.                    |
| `SFU_ENFORCE_2_LAYER_SIMULCAST` | `0`      | Set to `1` to reject simulcast producers that publish anything other than 2 encodings. Useful for enforcing consistent encoding strategies.                          |

**Use Cases:**

- Detecting older clients that use 3-layer simulcast when you expect 2-layer
- Ensuring all clients use VP9 SVC mode for consistent quality
- Debugging encoding issues in mixed-client environments

---

## Data Channel Policy

| Variable                          | Default | Description                                                                                                                                                                                                         |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SFU_REQUIRE_BINARY_DATA_CHANNEL` | `1`     | Require data channels to send binary payloads only. When enabled, any dataProducer that sends text/non-binary messages is immediately closed. Set to `0` to allow text messages (not recommended for RoMM netplay). |

**Note:** RoMM netplay uses binary data channels for input synchronization. Text messages are not supported and will cause the data channel to be closed.

---

## Environment Variable Aliases

For backward compatibility, some variables have aliases:

| Primary Variable    | Aliases                     |
| ------------------- | --------------------------- |
| `ROMM_API_BASE_URL` | `ROMM_BASE_URL`, `ROMM_URL` |
| `SFU_STUN_SERVERS`  | `STUN_SERVERS`              |

---

## Quick Reference: Minimal Configuration

For a basic single-node deployment with RoMM:

```bash
# Required
ROMM_API_BASE_URL=http://romm:8080
ROMM_SFU_INTERNAL_SECRET=your-secret-here

# Recommended for NAT/firewall
ANNOUNCED_IP=your-public-ip-or-hostname

# Optional: Custom ports
PORT=3001
WEBRTC_PORT=20000
```

For a production multi-node deployment:

```bash
# Required
ROMM_API_BASE_URL=http://romm:8080
ROMM_SFU_INTERNAL_SECRET=your-secret-here
PUBLIC_URL=https://sfu-1.example.com
NODE_ID=sfu-node-1

# WebRTC
ANNOUNCED_IP=203.0.113.1
WEBRTC_PORT=20000

# Scaling
SFU_WORKER_COUNT=4
SFU_FANOUT_ENABLED=1
SFU_FANOUT_VIEWER_THRESHOLD=500

# TURN servers (if needed)
SFU_TURN_SERVERS='[{"urls":["turn:turn.example.com:3478"],"username":"user","credential":"pass"}]'
```

---

## See Also

- [README.md](README.md) - General usage and setup guide
- [RoMM Architecture Documentation](../romm/docs/ARCHITECTURE.md) - System architecture overview
- [SFU Auth Design](../romm/docs/sfu-auth-design.md) - Detailed authentication design
