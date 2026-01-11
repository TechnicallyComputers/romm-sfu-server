const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

// Logging
// Default is intentionally quiet to avoid flooding systemd/nginx logs.
// Set LOG_LEVEL=info|debug to re-enable more output.
const LOG_LEVEL = (process.env.LOG_LEVEL || "warn").toLowerCase();
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };
const CURRENT_LOG_LEVEL =
  LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.warn;

const logger = {
  debug: (...args) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.debug) console.log(...args);
  },
  info: (...args) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.info) console.log(...args);
  },
  warn: (...args) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.warn) console.warn(...args);
  },
  error: (...args) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.error) console.error(...args);
  },
};

// Extremely chatty RTP/stat logs are disabled by default.
const SFU_DEBUG_STATS = process.env.SFU_DEBUG_STATS === "1";

// Data channel policy: RomM netplay uses binary payloads only.
// If enabled, any dataProducer that sends text/non-binary payloads will be closed.
const SFU_REQUIRE_BINARY_DATA_CHANNEL =
  process.env.SFU_REQUIRE_BINARY_DATA_CHANNEL !== "0";

// Optional: Validate client RTP layering policy (does not modify sender behavior).
// These guards are useful to catch older clients that still publish 3-layer simulcast
// or VP9 without the expected SVC mode.
const SFU_EXPECT_VP9_SVC_MODE = process.env.SFU_EXPECT_VP9_SVC_MODE
  ? String(process.env.SFU_EXPECT_VP9_SVC_MODE).toUpperCase()
  : null;
const SFU_ENFORCE_VP9_SVC_MODE = process.env.SFU_ENFORCE_VP9_SVC_MODE === "1";
const SFU_ENFORCE_2_LAYER_SIMULCAST =
  process.env.SFU_ENFORCE_2_LAYER_SIMULCAST === "1";

// mediasoup WebRtcServer support
// If enabled, all WebRTC transports share the same UDP (and optionally TCP) listening port(s),
// which simplifies firewall/NAT rules compared to allocating a port per transport.
const USE_WEBRTC_SERVER = process.env.USE_WEBRTC_SERVER !== "0";
const LISTEN_IP = process.env.LISTEN_IP || "0.0.0.0";
const ANNOUNCED_ADDRESS = process.env.ANNOUNCED_IP || null;

// Single-port default for WebRTC.
// Note: TCP and UDP can share the same numeric port (different protocols).
const WEBRTC_PORT = Number.parseInt(process.env.WEBRTC_PORT || "20000", 10);
const WEBRTC_UDP_PORT = Number.parseInt(
  process.env.WEBRTC_UDP_PORT || String(WEBRTC_PORT),
  10
);
const ENABLE_WEBRTC_TCP = process.env.ENABLE_WEBRTC_TCP !== "0";
const WEBRTC_TCP_PORT = Number.parseInt(
  process.env.WEBRTC_TCP_PORT || String(WEBRTC_PORT),
  10
);

// Worker port range. Used by mediasoup for RTC-related allocations.
// If you want to fully constrain worker usage, set RTC_MIN_PORT and RTC_MAX_PORT accordingly.
const RTC_MIN_PORT = Number.parseInt(process.env.RTC_MIN_PORT || "20000", 10);
const RTC_MAX_PORT = Number.parseInt(process.env.RTC_MAX_PORT || "20200", 10);

function getPrimaryVideoCodecMimeType(rtpParameters) {
  try {
    const codecs = (rtpParameters && rtpParameters.codecs) || [];
    for (const c of codecs) {
      const mt = c && typeof c.mimeType === "string" ? c.mimeType : "";
      const lower = mt.toLowerCase();
      if (!lower.startsWith("video/")) continue;
      if (lower === "video/rtx") continue;
      return lower;
    }
  } catch {
    // ignore
  }
  return null;
}

function summarizeEncodings(rtpParameters) {
  try {
    const enc = (rtpParameters && rtpParameters.encodings) || [];
    return enc.map((e) => ({
      rid: e && e.rid,
      ssrc: e && e.ssrc,
      scalabilityMode: e && e.scalabilityMode,
      scaleResolutionDownBy: e && e.scaleResolutionDownBy,
      maxBitrate: e && e.maxBitrate,
    }));
  } catch {
    return null;
  }
}

function validateVideoRtpLayerPolicy({ socketId, rtpParameters }) {
  // Default behavior: do nothing. This SFU is client-driven; the host decides.
  // Enable checks only when explicitly configured (useful for mixed-client deployments).
  if (
    !SFU_EXPECT_VP9_SVC_MODE &&
    !SFU_ENFORCE_VP9_SVC_MODE &&
    !SFU_ENFORCE_2_LAYER_SIMULCAST
  ) {
    return;
  }

  const mime = getPrimaryVideoCodecMimeType(rtpParameters);
  if (!mime) return;

  const encodings = (rtpParameters && rtpParameters.encodings) || [];
  const encodingCount = Array.isArray(encodings) ? encodings.length : 0;

  // VP9 SVC is typically published as a single encoding with scalabilityMode.
  if (mime === "video/vp9") {
    const svcModeRaw =
      encodingCount > 0 && encodings[0] && encodings[0].scalabilityMode
        ? String(encodings[0].scalabilityMode)
        : "";
    const svcMode = svcModeRaw.toUpperCase();

    // If it looks like SVC (scalabilityMode present), validate it.
    if (svcMode) {
      if (SFU_EXPECT_VP9_SVC_MODE && svcMode !== SFU_EXPECT_VP9_SVC_MODE) {
        const msg = `VP9 SVC mode mismatch: got ${
          svcModeRaw || "(empty)"
        }, expected ${SFU_EXPECT_VP9_SVC_MODE}`;
        if (SFU_ENFORCE_VP9_SVC_MODE) throw new Error(msg);
        logger.warn("sfu-produce: " + msg, { socket: socketId });
      }
      return;
    }

    // VP9 without scalabilityMode is valid (VP9 simulcast or non-SVC).
    // Only error in strict mode when an explicit expected mode is configured.
    if (SFU_ENFORCE_VP9_SVC_MODE && SFU_EXPECT_VP9_SVC_MODE) {
      throw new Error(
        `VP9 without scalabilityMode (expected ${SFU_EXPECT_VP9_SVC_MODE})`
      );
    }
    // Continue into simulcast checks below (if enabled).
  }

  // Simulcast is typically multiple encodings.
  if (encodingCount > 1) {
    if (encodingCount !== 2) {
      const msg = `simulcast encoding count ${encodingCount} (expected 2)`;
      if (SFU_ENFORCE_2_LAYER_SIMULCAST) throw new Error(msg);
      logger.warn("sfu-produce: " + msg, { socket: socketId, mime });
    }
  }
}

function isBinaryDataChannelMessage(message, ppid) {
  // WebRTC PPIDs commonly used:
  // - 51: string
  // - 53: binary
  // - 50/54: empty string/binary
  // mediasoup provides `ppid` for SCTP messages.
  if (ppid === 51 || ppid === 50) return false;
  if (typeof message === "string") return false;

  // mediasoup typically provides a Buffer for binary messages.
  if (Buffer.isBuffer(message)) return true;
  if (message instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(message)) return true;

  return false;
}

function parseStunIceServersFromEnv() {
  const raw = (
    process.env.SFU_STUN_SERVERS ||
    process.env.STUN_SERVERS ||
    ""
  ).trim();
  if (!raw) return [{ urls: "stun:stun.l.google.com:19302" }];

  // Accept comma-separated and/or whitespace-separated values.
  // Examples:
  //   SFU_STUN_SERVERS=stun.l.google.com:19302,stun1.example.com:3478
  //   SFU_STUN_SERVERS="stun:stun.l.google.com:19302 stun:stun1.example.com:3478"
  const tokens = raw
    .split(/[\s,]+/)
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const out = [];
  for (const token of tokens) {
    const t = token.replace(/^\/\//, "");
    const lower = t.toLowerCase();

    // Hard block TURN: this SFU is intended to remove TURN from the stack.
    if (lower.startsWith("turn:") || lower.startsWith("turns:")) {
      logger.warn("Ignoring TURN ICE server (TURN is not supported)", {
        value: token,
      });
      continue;
    }

    // Allow explicit stun:/stuns: URLs.
    if (lower.startsWith("stun:") || lower.startsWith("stuns:")) {
      out.push({ urls: t });
      continue;
    }

    // If they provided some other scheme, ignore it.
    if (lower.includes("://")) {
      logger.warn("Ignoring ICE server with unsupported scheme", {
        value: token,
      });
      continue;
    }

    // Bare host[:port] (no prefix) -> stun:host[:port]
    out.push({ urls: `stun:${t}` });
  }

  return out;
}

const SFU_ICE_SERVERS = parseStunIceServersFromEnv();

// Signalling port must remain open and available even when using WebRtcServer.
// Default differs from common 3000 dev ports (e.g. Vite).
const PORT = process.env.PORT || 3001;

// Multi-node support (optional)
// If REDIS_URL is set, rooms are registered in Redis with a TTL so other nodes can
// resolve which node hosts a given room.
const REDIS_URL = process.env.REDIS_URL || null;
const ENABLE_ROOM_REGISTRY = !!REDIS_URL;
const ROOM_REGISTRY_KEY_PREFIX =
  process.env.ROOM_REGISTRY_KEY_PREFIX || "sfu:room:";
const ROOM_REGISTRY_TTL_SECONDS = Number.parseInt(
  process.env.ROOM_REGISTRY_TTL_SECONDS || "60",
  10
);
const NODE_ID = process.env.NODE_ID || crypto.randomUUID();
// Public URL that clients should use to reach this node (signaling base URL).
// In multi-node deployments behind a LB, set this explicitly.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${String(PORT)}`;

let redisClient = null;
const locallyHostedRooms = new Set();

function isRedisNoAuthError(err) {
  if (!err) return false;
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.includes("NOAUTH") || msg.includes("Authentication required");
}

async function disableRoomRegistry(reason) {
  if (!redisClient) return;
  try {
    logger.warn("Disabling room registry (Redis error)", {
      reason: reason && reason.message ? reason.message : String(reason),
    });
  } catch {
    // ignore
  }

  try {
    await redisClient.disconnect();
  } catch {
    // ignore
  }
  redisClient = null;
}

async function initRoomRegistry() {
  if (!ENABLE_ROOM_REGISTRY) return;

  // Lazy require so single-node setups do not need the dependency.
  // Install with: npm i redis
  // Using redis v4 client.
  const { createClient } = require("redis");
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", (err) => {
    logger.error("Redis error", err);
  });

  try {
    await redisClient.connect();
  } catch (err) {
    await disableRoomRegistry(err);
    return;
  }
  logger.info("Room registry enabled", {
    nodeId: NODE_ID,
    publicUrl: PUBLIC_URL,
    ttlSeconds: ROOM_REGISTRY_TTL_SECONDS,
  });

  // Refresh keys periodically to prevent TTL expiry while rooms are active.
  const refreshMs = Math.max(
    5000,
    Math.floor((ROOM_REGISTRY_TTL_SECONDS * 1000) / 2)
  );
  setInterval(() => {
    refreshLocalRoomRegistry().catch((e) => {
      logger.warn("room registry refresh failed", e);
    });
  }, refreshMs).unref();
}

function getRoomRegistryKey(roomName) {
  return `${ROOM_REGISTRY_KEY_PREFIX}${roomName}`;
}

async function registryUpsertRoom(roomName) {
  if (!redisClient) return;
  const room = rooms.get(roomName);
  if (!room) return;

  const record = {
    room_name: roomName,
    current: room.players ? room.players.size : 0,
    max: room.maxPlayers,
    hasPassword: !!room.password,
    nodeId: NODE_ID,
    url: PUBLIC_URL,
    updatedAt: Date.now(),
  };

  try {
    await redisClient.set(
      getRoomRegistryKey(roomName),
      JSON.stringify(record),
      {
        EX: ROOM_REGISTRY_TTL_SECONDS,
      }
    );
  } catch (err) {
    if (isRedisNoAuthError(err)) {
      await disableRoomRegistry(err);
      return;
    }
    throw err;
  }
}

async function registryDeleteRoom(roomName) {
  if (!redisClient) return;
  try {
    await redisClient.del(getRoomRegistryKey(roomName));
  } catch (err) {
    if (isRedisNoAuthError(err)) {
      await disableRoomRegistry(err);
      return;
    }
    throw err;
  }
}

async function registryResolveRoom(roomName) {
  if (!redisClient) return null;
  let raw;
  try {
    raw = await redisClient.get(getRoomRegistryKey(roomName));
  } catch (err) {
    if (isRedisNoAuthError(err)) {
      await disableRoomRegistry(err);
      return null;
    }
    throw err;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function registryListRooms() {
  if (!redisClient) return null;
  const out = {};

  let cursor = 0;
  const match = `${ROOM_REGISTRY_KEY_PREFIX}*`;

  do {
    let res;
    try {
      res = await redisClient.scan(cursor, {
        MATCH: match,
        COUNT: 200,
      });
    } catch (err) {
      if (isRedisNoAuthError(err)) {
        await disableRoomRegistry(err);
        return null;
      }
      throw err;
    }
    cursor = Number(res.cursor);
    const keys = res.keys || [];
    if (keys.length === 0) continue;

    let values;
    try {
      values = await redisClient.mGet(keys);
    } catch (err) {
      if (isRedisNoAuthError(err)) {
        await disableRoomRegistry(err);
        return null;
      }
      throw err;
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const raw = values[i];
      if (!raw) continue;

      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }

      const roomName =
        rec.room_name || key.slice(ROOM_REGISTRY_KEY_PREFIX.length);
      out[roomName] = {
        room_name: roomName,
        current: rec.current ?? 0,
        max: rec.max ?? 0,
        hasPassword: !!rec.hasPassword,
        // Extra fields for clients that want multi-node redirect support.
        nodeId: rec.nodeId,
        url: rec.url,
      };
    }
  } while (cursor !== 0);

  return out;
}

async function refreshLocalRoomRegistry() {
  if (!redisClient) return;
  for (const roomName of locallyHostedRooms) {
    // If a room no longer exists locally, clean up its registry entry.
    if (!rooms.has(roomName)) {
      await registryDeleteRoom(roomName);
      locallyHostedRooms.delete(roomName);
      continue;
    }
    await registryUpsertRoom(roomName);
  }
}

const app = express();
const cors = require("cors");
app.use(cors());

// Simple HTTP endpoint used by clients to list available rooms.
// Strict auth: must present a RoMM-issued JWT and its jti must exist in Redis.
// If Redis registry is enabled, this is a cluster-wide list.
app.get("/list", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenAgainstRedis(token, { consume: false });

    if (ENABLE_ROOM_REGISTRY && redisClient) {
      const out = (await registryListRooms()) || {};
      return res.json(out);
    }

    const out = {};
    for (const [name, info] of rooms.entries()) {
      out[name] = {
        room_name: name,
        current: info.players.size,
        max: info.maxPlayers,
        hasPassword: !!info.password,
      };
    }
    res.json(out);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("not initialized") || msg.includes("missing")) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});

// Resolve which SFU node hosts a room.
// Returns { room_name, url, nodeId } when known.
app.get("/resolve", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenAgainstRedis(token, { consume: false });

    const roomName = String(req.query.room || req.query.room_name || "");
    if (!roomName) {
      return res.status(400).json({ error: "missing room query parameter" });
    }

    // Prefer local rooms.
    if (rooms.has(roomName)) {
      return res.json({
        room_name: roomName,
        url: PUBLIC_URL,
        nodeId: NODE_ID,
      });
    }

    if (!ENABLE_ROOM_REGISTRY || !redisClient) {
      return res.status(404).json({ error: "not found" });
    }

    const rec = await registryResolveRoom(roomName);
    if (!rec || !rec.url) {
      return res.status(404).json({ error: "not found" });
    }

    return res.json({ room_name: roomName, url: rec.url, nodeId: rec.nodeId });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("not initialized") || msg.includes("missing")) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- SFU authentication (RoMM-issued JWT + Redis one-time JTI allowlist) ---
//
// Flow:
// 1) Client requests POST /api/sfu/token from RoMM and gets a short-lived JWT (30s) with jti.
// 2) Client connects to SFU with that JWT (Socket.IO auth token).
// 3) SFU verifies JWT signature + claims, then atomically consumes Redis key:
//      sfu:auth:jti:<jti>  (HSET mapping, EX 30)
//    If present, it deletes the key (one-time) and binds socket identity to sub.

const SFU_AUTH_ISSUER = process.env.SFU_AUTH_ISSUER || "romm:sfu";
const SFU_AUTH_JTI_KEY_PREFIX =
  process.env.SFU_AUTH_JTI_KEY_PREFIX || "sfu:auth:jti:";
const SFU_AUTH_CLOCK_SKEW_SECONDS = Number.parseInt(
  process.env.SFU_AUTH_CLOCK_SKEW_SECONDS || "5",
  10
);

// Security hardening: auth is ALWAYS required.
// A valid JWT signature alone is NOT sufficient; the JWT's jti must be present
// in Redis under the allowlist prefix.
const SFU_REQUIRE_AUTH = true;

// When auth is enabled, allow a reconnecting socket to take over an existing
// still-alive connection for the same authenticated userid (common during
// mobile WiFi <-> LTE/5G network switches). Disable to enforce strict single
// connection per userid.
const SFU_ALLOW_AUTH_TAKEOVER = process.env.SFU_ALLOW_AUTH_TAKEOVER !== "0";

// Takeover grace window: when takeover is enabled, only allow it if the existing
// socket appears to be stale (no app-level packets) and the overlap is recent.
// This reduces surprise "kick" behavior when the same account is used elsewhere.
// Set to 0 to remove the grace window (not recommended).
const SFU_AUTH_TAKEOVER_GRACE_SECONDS = (() => {
  const raw = String(
    process.env.SFU_AUTH_TAKEOVER_GRACE_SECONDS || "30"
  ).trim();
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    logger.warn("Invalid SFU_AUTH_TAKEOVER_GRACE_SECONDS; falling back to 30", {
      value: raw,
    });
    return 30;
  }
  return v;
})();

// Heuristic: only takeover if the existing socket looks at least a little stale.
// Keeps "active" sessions from being trivially kicked while still allowing
// mobile network transitions.
const SFU_AUTH_TAKEOVER_MIN_INACTIVE_SECONDS = 1;

const SFU_AUTH_SECRET =
  process.env.ROMM_AUTH_SECRET_KEY || process.env.SFU_AUTH_SECRET_KEY || null;

// SFU_AUTH_REDIS_URL can be set explicitly. If absent, we fall back to REDIS_URL.
function buildRedisUrlFromParts(prefix) {
  const host = (process.env[`${prefix}_HOST`] || "").trim();
  if (!host) return null;

  const portRaw = (process.env[`${prefix}_PORT`] || "6379").trim();
  const dbRaw = (process.env[`${prefix}_DB`] || "0").trim();
  let usernameRaw = (process.env[`${prefix}_USERNAME`] || "").trim();
  let passwordRaw = process.env[`${prefix}_PASSWORD`] || "";

  // Consistent naming: VALKEY_SFU_PASSWORD is preferred for the SFU auth Redis user.
  // Backwards-compatible: still supports SFU_AUTH_REDIS_PASSWORD.
  const usingValkeySfuPassword =
    prefix === "SFU_AUTH_REDIS" &&
    !passwordRaw &&
    process.env.VALKEY_SFU_PASSWORD;
  if (usingValkeySfuPassword) {
    passwordRaw = process.env.VALKEY_SFU_PASSWORD || "";
    // Only default the username when using the ACL-style VALKEY_SFU_PASSWORD.
    // This avoids breaking classic requirepass setups that authenticate as the default user.
    if (!usernameRaw) usernameRaw = "sfu";
  }
  const sslRaw = (process.env[`${prefix}_SSL`] || "").trim().toLowerCase();

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port)) {
    throw new Error(
      `${prefix}_PORT must be an integer, got ${JSON.stringify(portRaw)}`
    );
  }
  const db = Number.parseInt(dbRaw, 10);
  if (!Number.isFinite(db)) {
    throw new Error(
      `${prefix}_DB must be an integer, got ${JSON.stringify(dbRaw)}`
    );
  }

  const scheme =
    sslRaw === "1" || sslRaw === "true" || sslRaw === "yes" || sslRaw === "on"
      ? "rediss:"
      : "redis:";

  // Treat the common requirepass setup as password-only (no explicit username).
  const username = usernameRaw.toLowerCase() === "default" ? "" : usernameRaw;

  const u = new URL(`${scheme}//${host}:${port}/${db}`);
  if (username) u.username = username;
  if (passwordRaw) u.password = passwordRaw;
  return u.toString();
}

// Preferred: explicit URL.
// Alternative: provide parts via SFU_AUTH_REDIS_* so passwords with special characters
// do not require manual percent-encoding.
const SFU_AUTH_REDIS_URL =
  process.env.SFU_AUTH_REDIS_URL ||
  buildRedisUrlFromParts("SFU_AUTH_REDIS") ||
  process.env.REDIS_URL ||
  null;

let authRedisClient = null;
const AUTH_USE_JTI_LUA =
  // KEYS[1] = allowlist hash key, KEYS[2] = used marker key
  // If allowlist key exists and used marker is not set, mark used and return hash.
  // Do NOT delete allowlist key, so HTTP endpoints (e.g. /list) can still validate
  // within the token TTL.
  "local allow=KEYS[1] " +
  "local used=KEYS[2] " +
  "if redis.call('EXISTS', allow)==0 then return nil end " +
  "if redis.call('SETNX', used, '1')==0 then return nil end " +
  "local ttl=redis.call('TTL', allow) " +
  "if ttl and tonumber(ttl) and tonumber(ttl) > 0 then redis.call('EXPIRE', used, ttl) end " +
  "return redis.call('HGETALL', allow)";

function pickSfuAuthTokenFromHttp(req) {
  if (!req) return null;

  // Query string fallback.
  const q = req.query;
  if (q && typeof q.token === "string") return q.token;

  // Authorization header.
  const raw =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) ||
    null;
  if (raw && typeof raw === "string") {
    const m = raw.match(/^\s*Bearer\s+(.+)\s*$/i);
    if (m) return m[1];
  }

  // Cookie.
  const cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader && typeof cookieHeader === "string") {
    const parts = cookieHeader.split(";");
    for (const part of parts) {
      const [rawKey, ...rawRest] = part.split("=");
      const key = String(rawKey || "").trim();
      if (!key) continue;
      const rawVal = rawRest.join("=");
      if (key === "romm_sfu_token" || key === "sfu_token") {
        try {
          return decodeURIComponent(String(rawVal || "").trim());
        } catch {
          return String(rawVal || "").trim();
        }
      }
    }
  }

  return null;
}

async function verifySfuTokenAgainstRedis(token, { consume }) {
  if (!SFU_AUTH_SECRET) {
    throw new Error(
      "auth secret missing (ROMM_AUTH_SECRET_KEY/SFU_AUTH_SECRET_KEY)"
    );
  }
  if (!authRedisClient) {
    throw new Error("auth redis not initialized");
  }

  const claims = verifyJwtHs256(token, SFU_AUTH_SECRET);
  if (!claims || claims.iss !== SFU_AUTH_ISSUER) {
    throw new Error("invalid issuer");
  }
  if (claims.type !== "sfu") {
    throw new Error("invalid token type");
  }
  if (!claims.sub || typeof claims.sub !== "string") {
    throw new Error("missing sub");
  }
  if (!claims.jti || typeof claims.jti !== "string") {
    throw new Error("missing jti");
  }

  const allowKey = `${SFU_AUTH_JTI_KEY_PREFIX}${claims.jti}`;

  let record;
  if (consume) {
    const usedKey = `${SFU_AUTH_JTI_KEY_PREFIX}used:${claims.jti}`;
    const res = await authRedisClient.eval(AUTH_USE_JTI_LUA, {
      keys: [allowKey, usedKey],
      arguments: [],
    });
    if (!res) throw new Error("token not allowlisted");
    record = hgetallArrayToObject(res);
  } else {
    record = await authRedisClient.hGetAll(allowKey);
    if (!record || Object.keys(record).length === 0) {
      throw new Error("token not allowlisted");
    }
  }

  if (record.sub !== claims.sub) throw new Error("sub mismatch");
  if (record.iss !== SFU_AUTH_ISSUER) throw new Error("iss mismatch");
  if (record.jti !== claims.jti) throw new Error("jti mismatch");

  return {
    sub: claims.sub,
    netplay_username: record.netplay_username || null,
  };
}

function base64UrlToBuffer(input) {
  // base64url -> base64
  let s = String(input).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  return Buffer.from(s, "base64");
}

function decodeJwtPart(part) {
  const json = base64UrlToBuffer(part).toString("utf8");
  return JSON.parse(json);
}

function verifyJwtHs256(token, secret) {
  if (!token || typeof token !== "string") throw new Error("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt");

  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeJwtPart(headerB64);
  if (!header || header.alg !== "HS256") throw new Error("unsupported jwt alg");

  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac("sha256", Buffer.from(String(secret), "utf8"))
    .update(data)
    .digest();
  const actualSig = base64UrlToBuffer(sigB64);
  if (
    actualSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(actualSig, expectedSig)
  ) {
    throw new Error("bad jwt signature");
  }

  const claims = decodeJwtPart(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  if (claims && claims.nbf !== undefined) {
    const nbf = Number(claims.nbf);
    if (!Number.isFinite(nbf)) throw new Error("invalid nbf");
    if (now + SFU_AUTH_CLOCK_SKEW_SECONDS < nbf)
      throw new Error("jwt not active");
  }

  if (claims && claims.exp !== undefined) {
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp)) throw new Error("invalid exp");
    if (now - SFU_AUTH_CLOCK_SKEW_SECONDS >= exp)
      throw new Error("jwt expired");
  } else {
    throw new Error("missing exp");
  }

  return claims;
}

function pickSfuAuthTokenFromSocket(socket) {
  // Preferred: Socket.IO auth payload.
  if (socket && socket.handshake && socket.handshake.auth) {
    const auth = socket.handshake.auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth.token === "string") return auth.token;
  }

  // Fallback: query string (less ideal, but sometimes convenient).
  if (socket && socket.handshake && socket.handshake.query) {
    const q = socket.handshake.query;
    if (q && typeof q.token === "string") return q.token;
  }

  // Fallback: cookie (recommended for browser clients that cannot pass auth payload).
  if (socket && socket.handshake && socket.handshake.headers) {
    const h = socket.handshake.headers;
    const cookieHeader = h.cookie;
    if (cookieHeader && typeof cookieHeader === "string") {
      const parts = cookieHeader.split(";");
      for (const part of parts) {
        const [rawKey, ...rawRest] = part.split("=");
        const key = String(rawKey || "").trim();
        if (!key) continue;
        const rawVal = rawRest.join("=");
        if (key === "romm_sfu_token" || key === "sfu_token") {
          try {
            return decodeURIComponent(String(rawVal || "").trim());
          } catch {
            return String(rawVal || "").trim();
          }
        }
      }
    }
  }

  // Fallback: Authorization header (if provided by client/proxy).
  if (socket && socket.handshake && socket.handshake.headers) {
    const h = socket.handshake.headers;
    const raw = h.authorization || h.Authorization;
    if (raw && typeof raw === "string") {
      const m = raw.match(/^\s*Bearer\s+(.+)\s*$/i);
      if (m) return m[1];
    }
  }

  return null;
}

function hgetallArrayToObject(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const k = String(arr[i]);
    out[k] = String(arr[i + 1]);
  }
  return out;
}

async function initSfuAuth() {
  if (!SFU_AUTH_SECRET) {
    throw new Error(
      "SFU_REQUIRE_AUTH is enabled but ROMM_AUTH_SECRET_KEY/SFU_AUTH_SECRET_KEY is not set"
    );
  }

  if (!SFU_AUTH_REDIS_URL) {
    throw new Error(
      "SFU_REQUIRE_AUTH is enabled but SFU_AUTH_REDIS_URL/REDIS_URL is not set"
    );
  }

  const { createClient } = require("redis");
  authRedisClient = createClient({ url: SFU_AUTH_REDIS_URL });
  authRedisClient.on("error", (err) => {
    logger.error("SFU auth redis error", err);
  });
  await authRedisClient.connect();
  logger.info("SFU auth enabled", {
    issuer: SFU_AUTH_ISSUER,
    jtiPrefix: SFU_AUTH_JTI_KEY_PREFIX,
  });
}

io.use(async (socket, next) => {
  try {
    const token = pickSfuAuthTokenFromSocket(socket);
    const user = await verifySfuTokenAgainstRedis(token, { consume: true });
    socket.data.sfuUser = user;

    return next();
  } catch (err) {
    logger.warn("SFU auth failed", {
      message: err && err.message ? err.message : String(err),
      ip: socket && socket.handshake ? socket.handshake.address : undefined,
    });
    return next(new Error("unauthorized"));
  }
});

// Simple in-memory storage for transports/producers/consumers per socket
const peers = new Map(); // socketId -> { transports: Map, producers: Map }
const rooms = new Map(); // roomName -> { owner: socketId, players: Map(userid->extra), maxPlayers, password }

let worker;
let router;
let webRtcServer;

async function runMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died, exiting in 2 seconds...");
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = [
    { mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    // Codec order matters for client Auto preference.
    // Present VP9 first, then H264, then VP8.
    { mimeType: "video/VP9", clockRate: 90000 },
    {
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: { "packetization-mode": 1 },
    },
    { mimeType: "video/VP8", clockRate: 90000 },
  ];

  if (USE_WEBRTC_SERVER) {
    const listenInfos = [];

    const udpInfo = {
      protocol: "udp",
      ip: LISTEN_IP,
      port: WEBRTC_UDP_PORT,
    };
    if (ANNOUNCED_ADDRESS) udpInfo.announcedAddress = ANNOUNCED_ADDRESS;
    listenInfos.push(udpInfo);

    if (ENABLE_WEBRTC_TCP) {
      const tcpInfo = {
        protocol: "tcp",
        ip: LISTEN_IP,
        port: WEBRTC_TCP_PORT,
      };
      if (ANNOUNCED_ADDRESS) tcpInfo.announcedAddress = ANNOUNCED_ADDRESS;
      listenInfos.push(tcpInfo);
    }

    webRtcServer = await worker.createWebRtcServer({ listenInfos });
    logger.info("mediasoup WebRtcServer created", {
      udpPort: WEBRTC_UDP_PORT,
      tcpEnabled: ENABLE_WEBRTC_TCP,
      tcpPort: ENABLE_WEBRTC_TCP ? WEBRTC_TCP_PORT : null,
      announcedAddress: ANNOUNCED_ADDRESS,
    });
  } else {
    webRtcServer = null;
  }

  router = await worker.createRouter({ mediaCodecs });
  logger.info("mediasoup router created");
}

io.on("connection", (socket) => {
  logger.debug("client connected", socket.id);
  peers.set(socket.id, {
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    dataProducers: new Map(),
    dataConsumers: new Map(),
    // Server-side identity binding. Do not trust userid inside arbitrary client packets.
    userid: null,
    // Updated on any inbound Socket.IO packet (app-level). Used for takeover heuristics.
    lastSeenAt: Date.now(),
  });

  // Track last activity for takeover grace window checks.
  socket.use((packet, next) => {
    try {
      const peer = peers.get(socket.id);
      if (peer) peer.lastSeenAt = Date.now();
    } catch {
      // ignore
    }
    next();
  });

  const getSocketRoomName = () => {
    for (const name of socket.rooms) {
      if (rooms.has(name)) return name;
    }
    return null;
  };

  const normalizeExtra = (extra) => {
    if (!extra || typeof extra !== "object") return extra;
    // Provide both keys for compatibility with different client versions.
    return {
      ...extra,
      socketId: socket.id,
      socket_id: socket.id,
    };
  };

  // Helper to list room players for client consumption
  const listRoomUsers = (roomName) => {
    const room = rooms.get(roomName);
    if (!room) return {};
    const users = {};
    for (const [uid, extra] of room.players.entries()) {
      users[uid] = extra;
    }
    return users;
  };

  const getAssignedUserid = () => {
    const peer = peers.get(socket.id);
    return peer ? peer.userid : null;
  };

  const bindUseridToSocket = (userid) => {
    const peer = peers.get(socket.id);
    if (!peer) throw new Error("peer not found");

    if (userid === undefined || userid === null || userid === "") {
      throw new Error("invalid userid");
    }

    // Enforce a stable userid per network connection.
    if (peer.userid !== null && String(peer.userid) !== String(userid)) {
      throw new Error("userid mismatch for this connection");
    }

    peer.userid = userid;
  };

  // If SFU auth is enabled, bind the authenticated userid immediately.
  try {
    if (SFU_REQUIRE_AUTH) {
      const sfuUser = socket.data && socket.data.sfuUser;
      if (!sfuUser || !sfuUser.sub) throw new Error("unauthorized");
      bindUseridToSocket(sfuUser.sub);
    }
  } catch (e) {
    logger.warn("disconnecting unauthorized socket", {
      socket: socket.id,
      message: e && e.message ? e.message : String(e),
    });
    socket.disconnect(true);
    return;
  }

  const applyAuthToExtra = (storedExtra) => {
    const assignedUserid = getAssignedUserid();
    if (!assignedUserid) throw new Error("unauthorized");

    // Do not trust client-provided userid when SFU auth is enabled.
    // Some clients send legacy/ephemeral ids that won't match RoMM's userid.
    if (
      storedExtra &&
      storedExtra.userid !== undefined &&
      storedExtra.userid !== null &&
      String(storedExtra.userid) !== String(assignedUserid)
    ) {
      logger.debug(
        "overriding client-provided userid with authenticated userid",
        {
          socket: socket.id,
          clientUserid: storedExtra.userid,
          assignedUserid,
        }
      );
    }

    storedExtra.userid = assignedUserid;

    const sfuUser = socket.data && socket.data.sfuUser;
    if (sfuUser && sfuUser.netplay_username) {
      storedExtra.netplay_username = sfuUser.netplay_username;
      if (!storedExtra.player_name)
        storedExtra.player_name = sfuUser.netplay_username;
    }

    return storedExtra;
  };

  socket.on("sfu-available", (data, cb) => {
    cb && cb({ available: !!router });
  });

  socket.on("sfu-get-router-rtp-capabilities", (data, cb) => {
    cb && cb(null, router.rtpCapabilities);
  });

  // Create a WebRTC transport on the SFU for the client.
  socket.on("sfu-create-transport", async ({ direction }, cb) => {
    try {
      const transportOptions = {
        enableUdp: true,
        enableTcp: ENABLE_WEBRTC_TCP,
        preferUdp: true,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        // STUN-only: configured via SFU_STUN_SERVERS/STUN_SERVERS.
        // Example: SFU_STUN_SERVERS=stun.l.google.com:19302,stun1.example.com:3478
        iceServers: SFU_ICE_SERVERS,
      };

      // Prefer WebRtcServer when enabled; otherwise fall back to per-transport listenIps.
      if (webRtcServer) {
        transportOptions.webRtcServer = webRtcServer;
      } else {
        if (!process.env.ANNOUNCED_IP) {
          throw new Error(
            "CRITICAL: ANNOUNCED_IP environment variable is not defined!"
          );
        }

        transportOptions.listenIps = [
          {
            ip: LISTEN_IP,
            announcedIp: process.env.ANNOUNCED_IP,
          },
        ];
      }

      const transport = await router.createWebRtcTransport(transportOptions);

      peers.get(socket.id).transports.set(transport.id, transport);
      logger.debug("sfu-create-transport:", {
        socket: socket.id,
        direction,
        transportId: transport.id,
      });

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close();
        }
      });

      const info = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      };

      cb && cb(null, info);
    } catch (err) {
      console.error("sfu-create-transport error", err);
      cb && cb(err.message);
    }
  });

  socket.on(
    "sfu-connect-transport",
    async ({ transportId, dtlsParameters }, cb) => {
      try {
        const transport = peers.get(socket.id).transports.get(transportId);
        if (!transport) throw new Error("transport not found");
        await transport.connect({ dtlsParameters });
        cb && cb(null, true);
      } catch (err) {
        console.error("sfu-connect-transport error", err);
        cb && cb(err.message);
      }
    }
  );

  // ICE restart support for clients that experience network path changes.
  // Client calls this when its mediasoup-client Transport connectionState becomes "failed".
  // Server responds with fresh iceParameters from transport.restartIce().
  socket.on("sfu-restart-ice", async ({ transportId }, cb) => {
    try {
      const transport = peers.get(socket.id).transports.get(transportId);
      if (!transport) throw new Error("transport not found");
      if (transport.closed) throw new Error("transport closed");

      const iceParameters = await transport.restartIce();
      logger.debug("sfu-restart-ice: ok", {
        socket: socket.id,
        transportId,
      });
      cb && cb(null, { iceParameters });
    } catch (err) {
      console.error("sfu-restart-ice error", err);
      cb && cb(err.message);
    }
  });

  socket.on("sfu-produce", async ({ transportId, kind, rtpParameters }, cb) => {
    try {
      logger.debug("sfu-produce request from", socket.id, {
        transportId,
        kind,
      });
      const transport = peers.get(socket.id).transports.get(transportId);
      if (!transport) throw new Error("transport not found");

      if (kind === "video") {
        validateVideoRtpLayerPolicy({ socketId: socket.id, rtpParameters });
      }

      // IMPORTANT: We do not currently have explicit client->server signaling
      // to close old producers when the client calls producer.close().
      // If the host re-produces (e.g. after pause/resume), the SFU can end up
      // with multiple server-side producers of the same kind for the same
      // socket, where the older one no longer receives packets.
      // Rejoining clients can then consume the stale producer and see
      // videoWidth/videoHeight remain 0.
      //
      // To keep behavior deterministic: enforce at most one producer per kind
      // per socket by closing/removing any existing same-kind producers here.
      try {
        const peer = peers.get(socket.id);
        if (peer && peer.producers) {
          for (const [pid, existing] of peer.producers.entries()) {
            if (existing && existing.kind === kind) {
              try {
                existing.close();
              } catch (e) {
                // ignore
              }
              peer.producers.delete(pid);
              logger.debug("sfu-produce: closed previous producer of kind", {
                socket: socket.id,
                kind,
                producerId: pid,
              });
            }
          }
        }
      } catch (e) {
        logger.warn("sfu-produce: failed to close previous producers", e);
      }

      const producer = await transport.produce({ kind, rtpParameters });
      peers.get(socket.id).producers.set(producer.id, producer);
      logger.debug("sfu-produce: producer created", {
        socket: socket.id,
        producerId: producer.id,
      });
      producer.observer.on("score", (score) => {
        if (SFU_DEBUG_STATS) logger.debug("Producer score:", score);
      });
      const logProducerStats = async () => {
        if (!SFU_DEBUG_STATS) return;
        if (producer.closed) return;

        const stats = await producer.getStats();

        for (const s of stats) {
          if (s.type === "inbound-rtp") {
            logger.debug("[PRODUCER RTP]", {
              producerId: producer.id,
              kind: producer.kind,
              packetsReceived: s.packetsReceived,
              bytesReceived: s.bytesReceived,
              framesDecoded: s.framesDecoded,
              frameWidth: s.frameWidth,
              frameHeight: s.frameHeight,
              framesPerSecond: s.framesPerSecond,
              jitter: s.jitter,
              packetLoss: s.packetsLost,
            });
          }
        }
      };

      const statsInterval = SFU_DEBUG_STATS
        ? setInterval(logProducerStats, 2000)
        : null;

      producer.on("close", () => {
        if (statsInterval) clearInterval(statsInterval);
      });
      producer.on("transportclose", () => {
        if (statsInterval) clearInterval(statsInterval);
      });

      try {
        logger.debug("producer rtpParameters summary", {
          codecs:
            rtpParameters.codecs &&
            rtpParameters.codecs.map((c) => ({
              mimeType: c.mimeType,
              payloadType: c.payloadType,
            })),
          encodings: rtpParameters.encodings && rtpParameters.encodings.length,
          encodingsSummary: summarizeEncodings(rtpParameters),
        });
      } catch (e) {
        logger.warn("failed to summarize producer rtpParameters", e);
      }

      producer.on("transportclose", () => {
        logger.debug("producer transport closed", {
          socket: socket.id,
          producerId: producer.id,
        });
        peers.get(socket.id).producers.delete(producer.id);
      });

      // Log producer lifecycle events to aid debugging
      producer.on("pause", () =>
        logger.debug("producer paused", {
          socket: socket.id,
          producerId: producer.id,
        })
      );
      producer.on("resume", () =>
        logger.debug("producer resumed", {
          socket: socket.id,
          producerId: producer.id,
        })
      );
      producer.on("close", () => {
        logger.debug("producer closed", {
          socket: socket.id,
          producerId: producer.id,
        });
        peers.get(socket.id).producers.delete(producer.id);
      });

      // Notify other clients in the same room(s) that a new producer is available.
      for (const [roomName, room] of rooms.entries()) {
        try {
          // room.players is a Map of userids->extra; owner is socket id
          const isMember =
            room.owner === socket.id ||
            Array.from(room.players.values()).some(
              (p) =>
                (p && p.socket_id === socket.id) ||
                (p &&
                  p.userid &&
                  room.players.has(p.userid) &&
                  room.players.get(p.userid) &&
                  room.players.get(p.userid).socket_id === socket.id)
            );
          // Fallback: if owner matches or the socket is in the room via socket.io, emit to that room
          if (room.owner === socket.id || socket.rooms.has(roomName)) {
            socket.to(roomName).emit("new-producer", { id: producer.id });
            logger.debug("broadcast new-producer to room", roomName, {
              producerId: producer.id,
            });
          }
        } catch (e) {
          logger.warn("Failed to broadcast new-producer to room", roomName, e);
        }
      }

      cb && cb(null, producer.id);
    } catch (err) {
      console.error("sfu-produce error", err);
      cb && cb(err.message);
    }
  });

  socket.on(
    "sfu-produce-data",
    async (
      { transportId, sctpStreamParameters, label, protocol, appData },
      cb
    ) => {
      try {
        logger.debug("sfu-produce-data request from", socket.id, {
          transportId,
          label,
          protocol,
        });

        // Bind/validate identity for this connection. The SFU must not trust
        // any client-provided userid in data-channel-related metadata.
        const assignedUserid = getAssignedUserid();
        if (
          appData &&
          typeof appData === "object" &&
          appData.userid !== undefined &&
          assignedUserid !== null &&
          String(appData.userid) !== String(assignedUserid)
        ) {
          return cb && cb("userid mismatch for this connection");
        }

        const peer = peers.get(socket.id);
        const transport =
          peer && peer.transports && peer.transports.get(transportId);
        if (!transport) throw new Error("transport not found");

        // Keep only one active inputs channel per socket/label.
        try {
          if (peer && peer.dataProducers) {
            for (const [pid, existing] of peer.dataProducers.entries()) {
              if (existing && existing.label === label) {
                try {
                  existing.close();
                } catch (e) {
                  // ignore
                }
                peer.dataProducers.delete(pid);
              }
            }
          }
        } catch (e) {
          logger.warn(
            "sfu-produce-data: failed to close previous dataProducers",
            e
          );
        }

        const safeAppData =
          appData && typeof appData === "object" ? { ...appData } : {};
        if (assignedUserid !== null) safeAppData.userid = assignedUserid;
        safeAppData.socketId = socket.id;
        safeAppData.socket_id = socket.id;

        const dataProducer = await transport.produceData({
          sctpStreamParameters,
          label,
          protocol,
          appData: safeAppData,
        });

        peer.dataProducers.set(dataProducer.id, dataProducer);

        if (SFU_REQUIRE_BINARY_DATA_CHANNEL) {
          dataProducer.on("message", (message, ppid) => {
            try {
              if (isBinaryDataChannelMessage(message, ppid)) return;

              logger.warn("dataProducer sent non-binary message; closing", {
                socket: socket.id,
                dataProducerId: dataProducer.id,
                label: dataProducer.label,
                protocol: dataProducer.protocol,
                ppid,
                messageType: typeof message,
              });

              try {
                dataProducer.close();
              } catch {
                // ignore
              }
            } catch (e) {
              logger.warn("failed to enforce binary-only data channel", e);
            }
          });
        }

        dataProducer.on("transportclose", () => {
          try {
            peer.dataProducers.delete(dataProducer.id);
          } catch (e) {}
        });
        dataProducer.on("close", () => {
          try {
            peer.dataProducers.delete(dataProducer.id);
          } catch (e) {}
        });

        const roomName = getSocketRoomName();
        if (roomName) {
          socket
            .to(roomName)
            .emit("new-data-producer", { id: dataProducer.id });
          logger.debug("broadcast new-data-producer to room", roomName, {
            dataProducerId: dataProducer.id,
          });
        }

        cb && cb(null, dataProducer.id);
      } catch (err) {
        console.error("sfu-produce-data error", err);
        cb && cb(err.message);
      }
    }
  );

  socket.on("sfu-get-data-producers", (data, cb) => {
    const list = [];
    try {
      const roomName = getSocketRoomName();
      if (!roomName) return cb && cb(null, list);

      const room = rooms.get(roomName);
      const socketIds = new Set();
      if (room && room.owner) socketIds.add(room.owner);
      if (room && room.players) {
        for (const extra of room.players.values()) {
          if (extra && (extra.socketId || extra.socket_id)) {
            socketIds.add(extra.socketId || extra.socket_id);
          }
        }
      }

      for (const sid of socketIds) {
        const pinfo = peers.get(sid);
        if (!pinfo || !pinfo.dataProducers) continue;
        for (const [pid] of pinfo.dataProducers) {
          list.push({ id: pid });
        }
      }

      cb && cb(null, list);
    } catch (err) {
      console.error("sfu-get-data-producers error", err);
      cb && cb(err.message);
    }
  });

  socket.on("sfu-consume-data", async ({ dataProducerId, transportId }, cb) => {
    try {
      logger.debug("sfu-consume-data request from", socket.id, {
        dataProducerId,
        transportId,
      });

      const roomName = getSocketRoomName();
      if (!roomName) throw new Error("no room");

      const room = rooms.get(roomName);
      if (!room) throw new Error("no such room");

      const socketIds = new Set();
      if (room.owner) socketIds.add(room.owner);
      for (const extra of room.players.values()) {
        const sid = extra && (extra.socketId || extra.socket_id);
        if (sid) socketIds.add(sid);
      }

      let dataProducer = null;
      for (const sid of socketIds) {
        const pinfo = peers.get(sid);
        const dp =
          pinfo &&
          pinfo.dataProducers &&
          pinfo.dataProducers.get(dataProducerId);
        if (dp) {
          dataProducer = dp;
          break;
        }
      }
      if (!dataProducer) throw new Error("dataProducer not found");

      const peer = peers.get(socket.id);
      const transport =
        peer && peer.transports && peer.transports.get(transportId);
      if (!transport) throw new Error("transport not found");

      const dataConsumer = await transport.consumeData({ dataProducerId });
      peer.dataConsumers.set(dataConsumer.id, dataConsumer);

      dataConsumer.on("transportclose", () => {
        try {
          peer.dataConsumers.delete(dataConsumer.id);
        } catch (e) {}
      });
      dataConsumer.on("close", () => {
        try {
          peer.dataConsumers.delete(dataConsumer.id);
        } catch (e) {}
      });

      cb &&
        cb(null, {
          id: dataConsumer.id,
          dataProducerId: dataConsumer.dataProducerId,
          sctpStreamParameters: dataConsumer.sctpStreamParameters,
          label: dataConsumer.label,
          protocol: dataConsumer.protocol,
          appData: dataConsumer.appData,
        });
    } catch (err) {
      console.error("sfu-consume-data error", err);
      cb && cb(err.message);
    }
  });

  socket.on("sfu-get-producers", (data, cb) => {
    // Return only producers belonging to sockets in the same room.
    const list = [];
    try {
      const roomName = getSocketRoomName();
      if (!roomName) {
        logger.debug("sfu-get-producers:", {
          socket: socket.id,
          room: null,
          returned: 0,
        });
        return cb && cb(null, list);
      }

      const room = rooms.get(roomName);
      const socketIds = new Set();
      if (room && room.owner) socketIds.add(room.owner);
      if (room && room.players) {
        for (const extra of room.players.values()) {
          if (extra && (extra.socketId || extra.socket_id)) {
            socketIds.add(extra.socketId || extra.socket_id);
          }
        }
      }

      for (const sid of socketIds) {
        const pinfo = peers.get(sid);
        if (!pinfo || !pinfo.producers) continue;
        for (const [pid] of pinfo.producers) {
          list.push({ id: pid });
        }
      }

      logger.debug("sfu-get-producers:", {
        socket: socket.id,
        room: roomName,
        returned: list.length,
      });
      cb && cb(null, list);
    } catch (e) {
      console.error("sfu-get-producers error", e);
      cb && cb(e.message || "error");
    }
  });

  // Basic room signaling handlers (minimal in-memory implementation)
  socket.on("open-room", async (data, cb) => {
    try {
      const { extra, maxPlayers = 4, password = "" } = data || {};
      if (!extra || !extra.room_name) return cb && cb("invalid");
      const roomName = extra.room_name;

      // Multi-node: reject if the room exists on another node.
      if (!rooms.has(roomName) && ENABLE_ROOM_REGISTRY && redisClient) {
        const existing = await registryResolveRoom(roomName);
        if (existing && existing.url && existing.url !== PUBLIC_URL) {
          return cb && cb("room exists");
        }
      }

      if (rooms.has(roomName)) return cb && cb("room exists");
      const players = new Map();
      const storedExtra = applyAuthToExtra(normalizeExtra(extra));

      // Bind this socket to its claimed userid once, server-side.
      bindUseridToSocket(storedExtra.userid);

      players.set(storedExtra.userid, storedExtra);
      rooms.set(roomName, { owner: socket.id, players, maxPlayers, password });
      locallyHostedRooms.add(roomName);
      if (ENABLE_ROOM_REGISTRY && redisClient) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      socket.join(roomName);
      logger.debug(`room opened: ${roomName} by ${socket.id}`);
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      cb && cb(null);
    } catch (err) {
      console.error("open-room error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("join-room", async (data, cb) => {
    try {
      const { extra, password = "" } = data || {};
      if (!extra || !extra.room_name) return cb && cb("invalid");
      const roomName = extra.room_name;

      let room = rooms.get(roomName);
      if (!room && ENABLE_ROOM_REGISTRY && redisClient) {
        const resolved = await registryResolveRoom(roomName);
        if (resolved && resolved.url && resolved.url !== PUBLIC_URL) {
          // Inform clients that support multi-node redirects.
          socket.emit("room-redirect", {
            room_name: roomName,
            url: resolved.url,
            nodeId: resolved.nodeId,
          });

          // Keep callback signature compatible: (err, payload).
          return (
            cb &&
            cb(null, {
              redirect: resolved.url,
              room_name: roomName,
              nodeId: resolved.nodeId,
            })
          );
        }
      }

      room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      if (room.password && room.password !== password)
        return cb && cb("bad password");
      const storedExtra = applyAuthToExtra(normalizeExtra(extra));

      // Bind this socket to its claimed userid once, server-side.
      bindUseridToSocket(storedExtra.userid);

      // Reconnect support: if a player rejoins with the same userid, treat it
      // as a reconnection and replace the stale socketId instead of rejecting
      // the room as "full".
      const isReconnect = room.players.has(storedExtra.userid);
      const existingExtra = isReconnect
        ? room.players.get(storedExtra.userid)
        : null;
      const existingSid =
        existingExtra && (existingExtra.socketId || existingExtra.socket_id);
      const existingSockAlive =
        existingSid &&
        existingSid !== socket.id &&
        io.sockets.sockets.get(existingSid);

      // Mobile network switching can create a brief overlap where the old Socket.IO
      // connection is still alive while the client has already reconnected.
      // When auth is enabled, we can safely allow an immediate takeover by the same
      // authenticated userid.
      let takeoverSid = null;
      let takeoverWasOwner = false;
      if (existingSockAlive) {
        if (SFU_REQUIRE_AUTH && SFU_ALLOW_AUTH_TAKEOVER) {
          if (SFU_AUTH_TAKEOVER_GRACE_SECONDS > 0) {
            const existingPeer = peers.get(existingSid);
            const lastSeenAt = existingPeer && existingPeer.lastSeenAt;
            if (!lastSeenAt || !Number.isFinite(Number(lastSeenAt))) {
              return cb && cb("userid in use");
            }

            const inactiveSeconds = (Date.now() - Number(lastSeenAt)) / 1000;
            if (inactiveSeconds < SFU_AUTH_TAKEOVER_MIN_INACTIVE_SECONDS) {
              return cb && cb("userid in use");
            }
            if (inactiveSeconds > SFU_AUTH_TAKEOVER_GRACE_SECONDS) {
              return cb && cb("userid in use");
            }
          }

          takeoverSid = existingSid;
          takeoverWasOwner = room.owner === existingSid;
          logger.info("allowing authenticated userid takeover", {
            room: roomName,
            userid: storedExtra.userid,
            fromSocket: existingSid,
            toSocket: socket.id,
            wasOwner: takeoverWasOwner,
            graceSeconds: SFU_AUTH_TAKEOVER_GRACE_SECONDS,
          });
        } else {
          return cb && cb("userid in use");
        }
      }
      if (!isReconnect && room.players.size >= room.maxPlayers)
        return cb && cb("full");

      room.players.set(storedExtra.userid, storedExtra);
      socket.join(roomName);

      // If we took over from a still-connected socket, ensure the room stays stable.
      if (takeoverSid) {
        if (takeoverWasOwner) {
          room.owner = socket.id;
        }
        try {
          const oldSocket = io.sockets.sockets.get(takeoverSid);
          if (oldSocket) oldSocket.disconnect(true);
        } catch (e) {
          // ignore
        }
      }

      // Notify other sockets in room of new player via socket.io event.
      // Avoid spamming "joined" messages when this is a reconnect.
      if (!isReconnect) {
        socket.to(roomName).emit("room-player-joined", storedExtra);
      }
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      if (ENABLE_ROOM_REGISTRY && redisClient) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      logger.debug(`socket ${socket.id} joined room ${roomName}`);
      cb && cb(null, listRoomUsers(roomName));
    } catch (err) {
      console.error("join-room error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("leave-room", (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      // Do not trust client-supplied userid here. Only the bound userid for this
      // network connection may leave.
      const assignedUserid = getAssignedUserid();
      let useridToRemove = assignedUserid;

      // Fallback for legacy clients that never joined/opened properly.
      if (!useridToRemove) {
        for (const [uid, extra] of room.players.entries()) {
          if (
            (extra && extra.socketId === socket.id) ||
            (extra && extra.socket_id === socket.id)
          ) {
            useridToRemove = uid;
            break;
          }
        }
      }

      if (!useridToRemove) return cb && cb("not a member");

      room.players.delete(useridToRemove);
      socket.leave(roomName);
      socket.to(roomName).emit("room-player-left", { userid: useridToRemove });
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      if (room.players.size === 0) {
        rooms.delete(roomName);
        locallyHostedRooms.delete(roomName);
        if (ENABLE_ROOM_REGISTRY && redisClient) {
          registryDeleteRoom(roomName).catch((e) => {
            logger.warn("failed to delete room registry", e);
          });
        }
        logger.debug(`room ${roomName} deleted (empty)`);
      } else if (ENABLE_ROOM_REGISTRY && redisClient) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      cb && cb(null);
    } catch (err) {
      console.error("leave-room error", err);
      cb && cb(err.message || "error");
    }
  });

  // Netplay system messages: host pause/resume notifications.
  // These are simple broadcasts so spectators get an explicit UI cue.
  socket.on("netplay-host-paused", (data, cb) => {
    try {
      let roomName = (data && data.roomName) || null;
      // Be robust: if the client sends a wrong/empty roomName, infer it.
      if (!roomName || !rooms.has(roomName) || !socket.rooms.has(roomName)) {
        roomName = getSocketRoomName();
      }
      if (!roomName) return cb && cb("no room");
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      if (room.owner !== socket.id) return cb && cb("not owner");

      logger.debug("netplay-host-paused from", socket.id, "room", roomName);

      io.to(roomName).emit("netplay-host-paused", {
        text: "Host has paused emulation",
      });
      cb && cb(null);
    } catch (err) {
      console.error("netplay-host-paused error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("netplay-host-resumed", (data, cb) => {
    try {
      let roomName = (data && data.roomName) || null;
      if (!roomName || !rooms.has(roomName) || !socket.rooms.has(roomName)) {
        roomName = getSocketRoomName();
      }
      if (!roomName) return cb && cb("no room");
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      if (room.owner !== socket.id) return cb && cb("not owner");

      logger.debug("netplay-host-resumed from", socket.id, "room", roomName);

      io.to(roomName).emit("netplay-host-resumed", {
        text: "Host has resumed emulation",
      });
      cb && cb(null);
    } catch (err) {
      console.error("netplay-host-resumed error", err);
      cb && cb(err.message || "error");
    }
  });

  // P2P signaling relay for control-channel WebRTC.
  // Client sends: { target, offer|answer|candidate|requestRenegotiate }
  // Server relays to: targetSocketId with { sender: socket.id, ... }
  socket.on("webrtc-signal", (data = {}) => {
    try {
      const roomName = data.roomName || getSocketRoomName();
      const target = data.target || data.targetSocketId;
      if (!target) return;

      let targetSocketId = null;

      // If the client already provided a socketId, prefer it.
      if (typeof target === "string" && io.sockets.sockets.get(target)) {
        targetSocketId = target;
      } else if (roomName) {
        // Fallback: treat target as a userid and resolve to socketId.
        const room = rooms.get(roomName);
        const extra = room && room.players.get(target);
        const resolved = extra && (extra.socketId || extra.socket_id);
        if (resolved && io.sockets.sockets.get(resolved)) {
          targetSocketId = resolved;
        }
      }

      if (!targetSocketId) return;

      // Basic sanity check: ensure both sockets are in the same room (if known).
      if (roomName) {
        const targetSock = io.sockets.sockets.get(targetSocketId);
        if (!targetSock || !targetSock.rooms.has(roomName)) return;
      }

      io.to(targetSocketId).emit("webrtc-signal", {
        sender: socket.id,
        offer: data.offer,
        answer: data.answer,
        candidate: data.candidate,
        requestRenegotiate: data.requestRenegotiate,
      });
    } catch (err) {
      console.error("webrtc-signal relay error", err);
    }
  });

  socket.on(
    "sfu-consume",
    async ({ producerId, transportId, rtpCapabilities }, cb) => {
      try {
        logger.debug("sfu-consume request from", socket.id, {
          producerId,
          transportId,
        });
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("cannot consume");
        }
        const transportOwner = peers.get(socket.id).transports.get(transportId);
        if (!transportOwner) throw new Error("transport not found");

        const consumer = await transportOwner.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        peers.get(socket.id).consumers.set(consumer.id, consumer);

        logger.debug("sfu-consume: consumer created", {
          socket: socket.id,
          consumerId: consumer.id,
          producerId: consumer.producerId,
        });
        try {
          logger.debug("consumer rtpParameters summary", {
            codecs:
              consumer.rtpParameters.codecs &&
              consumer.rtpParameters.codecs.map((c) => ({
                mimeType: c.mimeType,
                payloadType: c.payloadType,
              })),
            encodings:
              consumer.rtpParameters.encodings &&
              consumer.rtpParameters.encodings.length,
          });
        } catch (e) {
          logger.warn("failed to summarize consumer rtpParameters", e);
        }
        consumer.on("transportclose", () =>
          peers.get(socket.id).consumers.delete(consumer.id)
        );

        const params = {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
        try {
          logger.debug(
            "sfu-consume: returning params with rtpParameters summary",
            {
              id: params.id,
              producerId: params.producerId,
              codecs:
                params.rtpParameters.codecs &&
                params.rtpParameters.codecs.map((c) => c.mimeType),
            }
          );
        } catch (e) {
          /* ignore */
        }

        cb && cb(null, params);
      } catch (err) {
        console.error("sfu-consume error", err);
        cb && cb(err.message);
      }
    }
  );

  socket.on("disconnect", (reason) => {
    logger.debug("client disconnected", socket.id, { reason });

    // Remove from any rooms and notify members.
    for (const [roomName, room] of rooms.entries()) {
      if (room.owner === socket.id) {
        rooms.delete(roomName);
        locallyHostedRooms.delete(roomName);
        if (ENABLE_ROOM_REGISTRY && redisClient) {
          registryDeleteRoom(roomName).catch((e) => {
            logger.warn("failed to delete room registry", e);
          });
        }
        io.to(roomName).emit("users-updated", {});
        continue;
      }
      let removedUserid = null;
      for (const [uid, extra] of room.players.entries()) {
        if (
          (extra && extra.socketId === socket.id) ||
          (extra && extra.socket_id === socket.id)
        ) {
          room.players.delete(uid);
          removedUserid = uid;
          break;
        }
      }
      if (removedUserid) {
        io.to(roomName).emit("room-player-left", { userid: removedUserid });
        io.to(roomName).emit("users-updated", listRoomUsers(roomName));
        if (room.players.size === 0) {
          rooms.delete(roomName);
          locallyHostedRooms.delete(roomName);
          if (ENABLE_ROOM_REGISTRY && redisClient) {
            registryDeleteRoom(roomName).catch((e) => {
              logger.warn("failed to delete room registry", e);
            });
          }
          logger.debug(`room ${roomName} deleted (empty)`);
        } else if (ENABLE_ROOM_REGISTRY && redisClient) {
          registryUpsertRoom(roomName).catch((e) => {
            logger.warn("failed to upsert room registry", e);
          });
        }
      }
    }

    const p = peers.get(socket.id);
    if (p) {
      for (const transport of p.transports.values()) transport.close();
      for (const producer of p.producers.values()) producer.close();
      for (const consumer of p.consumers.values()) consumer.close();
      if (p.dataProducers)
        for (const dataProducer of p.dataProducers.values())
          dataProducer.close();
      if (p.dataConsumers)
        for (const dataConsumer of p.dataConsumers.values())
          dataConsumer.close();
    }
    peers.delete(socket.id);
  });
});

runMediasoup()
  .then(() => initRoomRegistry())
  .then(() => initSfuAuth())
  .then(() => {
    // Debug endpoints
    app.get("/debug/all-producers", (req, res) => {
      try {
        const out = [];
        for (const [sid, pinfo] of peers) {
          for (const [pid] of pinfo.producers) {
            out.push({ socket: sid, producerId: pid });
          }
        }
        res.json(out);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/debug/room-producers", (req, res) => {
      try {
        const roomName = req.query.room;
        if (!roomName)
          return res
            .status(400)
            .json({ error: "missing room query parameter" });
        const room = rooms.get(roomName);
        if (!room) return res.status(404).json({ error: "no such room" });
        const ownerSocket = room.owner;
        const pinfo = peers.get(ownerSocket);
        const prodArr = [];
        if (pinfo)
          for (const [pid] of pinfo.producers)
            prodArr.push({ producerId: pid });
        res.json({ room: roomName, owner: ownerSocket, producers: prodArr });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    server.listen(PORT, "0.0.0.0", () =>
      logger.info(`SFU server listening on port ${PORT} (bound to 0.0.0.0)`)
    );
  })
  .catch((err) => {
    console.error("Failed to start mediasoup", err);
    process.exit(1);
  });
