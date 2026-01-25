const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const http = require("http");
const https = require("https");
const express = require("express");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

// Simple Mutex implementation using Promises
class Mutex {
  constructor() {
    this._locked = false;
    this._waiting = [];
  }

  async runExclusive(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this._locked = false;
          if (this._waiting.length > 0) {
            const next = this._waiting.shift();
            next();
          }
        }
      };

      if (this._locked) {
        this._waiting.push(run);
      } else {
        this._locked = true;
        run();
      }
    });
  }
}

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
  10,
);
const ENABLE_WEBRTC_TCP = process.env.ENABLE_WEBRTC_TCP !== "0";
const WEBRTC_TCP_PORT = Number.parseInt(
  process.env.WEBRTC_TCP_PORT || String(WEBRTC_PORT),
  10,
);

// Worker scaling
// - SFU_WORKER_COUNT: desired mediasoup worker count.
// - Uses os.availableParallelism() when available (container-aware).
// - Caps to available logical cores to prevent accidental oversubscription.
const SFU_WORKER_COUNT_RAW = Number.parseInt(
  process.env.SFU_WORKER_COUNT || "1",
  10,
);
const SFU_CPU_CORES = (() => {
  try {
    if (typeof os.availableParallelism === "function") {
      return Number(os.availableParallelism()) || 1;
    }
  } catch {
    // ignore
  }
  try {
    const n = (os.cpus && os.cpus().length) || 1;
    return Number(n) || 1;
  } catch {
    return 1;
  }
})();
const SFU_WORKER_COUNT = (() => {
  const desired = Number.isFinite(SFU_WORKER_COUNT_RAW)
    ? SFU_WORKER_COUNT_RAW
    : 1;
  const normalized = Math.max(1, Math.floor(desired));
  if (normalized > SFU_CPU_CORES) {
    logger.warn(
      "SFU_WORKER_COUNT exceeds available CPU cores; capping to core count",
      {
        requested: normalized,
        availableCores: SFU_CPU_CORES,
      },
    );
    return SFU_CPU_CORES;
  }
  return normalized;
})();

if (SFU_WORKER_COUNT > 1 && !USE_WEBRTC_SERVER) {
  // Without WebRtcServer, each worker needs its own non-overlapping RTC port range.
  // This server does not currently partition RTC_MIN_PORT/RTC_MAX_PORT, so fail fast.
  throw new Error(
    "SFU_WORKER_COUNT>1 requires USE_WEBRTC_SERVER=1 (per-worker WebRtcServer ports)",
  );
}

// Optional: enable cross-worker fan-out for large rooms.
const SFU_FANOUT_ENABLED = process.env.SFU_FANOUT_ENABLED === "1";
const SFU_FANOUT_VIEWER_THRESHOLD = Number.parseInt(
  process.env.SFU_FANOUT_VIEWER_THRESHOLD || "500",
  10,
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
        `VP9 without scalabilityMode (expected ${SFU_EXPECT_VP9_SVC_MODE})`,
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

function normalizeIceUrl(url, defaultScheme) {
  const t = String(url || "")
    .trim()
    .replace(/^\/\//, "");
  if (!t) return null;
  const lower = t.toLowerCase();

  if (
    lower.startsWith("stun:") ||
    lower.startsWith("stuns:") ||
    lower.startsWith("turn:") ||
    lower.startsWith("turns:")
  ) {
    return t;
  }

  // If they provided some other scheme (e.g. https://), ignore it.
  if (lower.includes("://")) return null;

  return `${defaultScheme}:${t}`;
}

function splitServerTokens(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function parseStunServersFromEnv() {
  const raw = (
    process.env.SFU_STUN_SERVERS ||
    process.env.STUN_SERVERS ||
    ""
  ).trim();

  logger.warn("SFU_STUN_SERVERS environment variable:", {
    SFU_STUN_SERVERS: process.env.SFU_STUN_SERVERS,
    STUN_SERVERS: process.env.STUN_SERVERS,
    raw: raw,
    rawLength: raw.length,
  });

  // Keep a sane default when unset.
  if (!raw) {
    logger.warn("No SFU_STUN_SERVERS configured, using default Google STUN");
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }

  const out = [];
  for (const token of splitServerTokens(raw)) {
    const url = normalizeIceUrl(token, "stun");
    if (!url) {
      logger.warn("Ignoring ICE server with unsupported scheme", {
        value: token,
      });
      continue;
    }
    // Only allow STUN in this variable (TURN has separate env vars).
    const lower = url.toLowerCase();
    if (lower.startsWith("turn:") || lower.startsWith("turns:")) {
      logger.warn(
        "Ignoring TURN ICE server in SFU_STUN_SERVERS; use SFU_TURN_SERVERS/SFU_TURN_SERVER*",
        { value: token },
      );
      continue;
    }
    out.push({ urls: url });
  }

  return out;
}

function parseTurnServersFromJsonEnv() {
  const raw = String(process.env.SFU_TURN_SERVERS || "").trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Invalid SFU_TURN_SERVERS JSON; ignoring", {
      length: raw.length,
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn("SFU_TURN_SERVERS must be a JSON array; ignoring", {
      type: typeof parsed,
    });
    return [];
  }

  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const urlsRaw = entry.urls;
    const username =
      entry.username !== undefined && entry.username !== null
        ? String(entry.username)
        : null;
    const credential =
      entry.credential !== undefined && entry.credential !== null
        ? String(entry.credential)
        : null;

    const urls = Array.isArray(urlsRaw) ? urlsRaw : [urlsRaw];
    const normalizedUrls = [];
    for (const u of urls) {
      if (typeof u !== "string") continue;
      const nu = normalizeIceUrl(u, "turn");
      if (!nu) continue;
      const lower = nu.toLowerCase();
      if (!lower.startsWith("turn:") && !lower.startsWith("turns:")) continue;
      normalizedUrls.push(nu);
    }
    if (normalizedUrls.length === 0) continue;
    if (!username || !credential) {
      logger.warn(
        "Ignoring TURN server from SFU_TURN_SERVERS without username/credential",
      );
      continue;
    }
    out.push({ urls: normalizedUrls, username, credential });
  }

  return out;
}

function parseTurnServersFromNumberedEnv(limit = 4) {
  const out = [];
  for (let i = 1; i <= limit; i++) {
    const server = String(process.env[`SFU_TURN_SERVER${i}`] || "").trim();
    if (!server) continue;

    const username = String(process.env[`SFU_TURN_USER${i}`] || "").trim();
    const credential = String(process.env[`SFU_TURN_PASS${i}`] || "").trim();
    if (!username || !credential) {
      logger.warn(
        `Ignoring SFU_TURN_SERVER${i} because SFU_TURN_USER${i} or SFU_TURN_PASS${i} is missing`,
      );
      continue;
    }

    const urls = [];
    for (const token of splitServerTokens(server)) {
      const url = normalizeIceUrl(token, "turn");
      if (!url) continue;
      const lower = url.toLowerCase();
      if (!lower.startsWith("turn:") && !lower.startsWith("turns:")) continue;
      urls.push(url);
    }

    if (urls.length === 0) {
      logger.warn(
        `Ignoring SFU_TURN_SERVER${i} because no valid TURN urls were found`,
      );
      continue;
    }

    out.push({ urls, username, credential });
  }
  return out;
}

function parseIceServersFromEnv() {
  const stun = parseStunServersFromEnv();
  const turn = [
    ...parseTurnServersFromJsonEnv(),
    ...parseTurnServersFromNumberedEnv(4),
  ];
  return [...stun, ...turn];
}

const SFU_ICE_SERVERS = parseIceServersFromEnv();

// Signalling port must remain open and available even when using WebRtcServer.
// Default differs from common 3000 dev ports (e.g. Vite).
const PORT = process.env.PORT || 3001;

// Multi-node support (optional)
// Rooms are registered in RomM (which stores them in its internal Valkey/Redis).
// This avoids exposing Redis to SFU nodes.
const ROMM_API_BASE_URL = (
  process.env.ROMM_API_BASE_URL ||
  process.env.ROMM_BASE_URL ||
  process.env.ROMM_URL ||
  ""
).trim();
const ROMM_SFU_INTERNAL_SECRET = process.env.ROMM_SFU_INTERNAL_SECRET || "";
const USE_ROMM_INTERNAL_API = !!ROMM_API_BASE_URL;

const ENABLE_ROOM_REGISTRY = USE_ROMM_INTERNAL_API;

const ROOM_REGISTRY_TTL_SECONDS = Number.parseInt(
  process.env.ROOM_REGISTRY_TTL_SECONDS || "60",
  10,
);
const NODE_ID = process.env.NODE_ID || crypto.randomUUID();
// Public URL that clients should use to reach this node (signaling base URL).
// In multi-node deployments behind a LB, set this explicitly.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${String(PORT)}`;
const locallyHostedRooms = new Set();

function rommInternalRequest({ method, path, body, timeoutMs = 5000 }) {
  if (!USE_ROMM_INTERNAL_API) {
    throw new Error("RomM internal API not configured (ROMM_API_BASE_URL)");
  }
  if (!ROMM_SFU_INTERNAL_SECRET) {
    throw new Error(
      "RomM internal API secret missing (ROMM_SFU_INTERNAL_SECRET)",
    );
  }

  const url = new URL(path, ROMM_API_BASE_URL);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {
    "x-romm-sfu-secret": ROMM_SFU_INTERNAL_SECRET,
    Accept: "application/json",
  };
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const code = res.statusCode || 0;

          // Comment out successful API response logging to reduce log spam
          // logger.debug("RomM API response", {
          //   method,
          //   path: url.pathname,
          //   statusCode: code,
          //   responseBody: raw.substring(0, 200) + (raw.length > 200 ? "..." : ""),
          //   hasSecret: !!headers["x-romm-sfu-secret"]
          // });

          if (code >= 400) {
            let detail = "";
            if (code === 403 && typeof raw === "string") {
              const lower = raw.toLowerCase();
              if (
                lower.includes("csrf") &&
                lower.includes("verification failed")
              ) {
                detail =
                  " (likely CSRF protection blocking SFU internal API; RomM must exempt /api/sfu/internal/* from CSRF)";
              }
            }
            const err = new Error(
              `RomM internal API error ${code} for ${method} ${url.pathname}${detail}`,
            );
            err.statusCode = code;
            err.body = raw;
            return reject(err);
          }

          if (!raw) return resolve(null);
          try {
            return resolve(JSON.parse(raw));
          } catch {
            return resolve(null);
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("RomM internal API request timeout"));
    });

    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function initRoomRegistry() {
  if (!ENABLE_ROOM_REGISTRY) return;

  logger.info("Room registry enabled (via RomM)", {
    nodeId: NODE_ID,
    publicUrl: PUBLIC_URL,
    ttlSeconds: ROOM_REGISTRY_TTL_SECONDS,
  });

  const refreshMs = Math.max(
    5000,
    Math.floor((ROOM_REGISTRY_TTL_SECONDS * 1000) / 2),
  );
  setInterval(() => {
    refreshLocalRoomRegistry().catch((e) => {
      logger.warn("room registry refresh failed", e);
    });
  }, refreshMs).unref();
}

async function registryUpsertRoom(roomName) {
  if (!ENABLE_ROOM_REGISTRY) return;
  const room = rooms.get(roomName);
  if (!room) return;

  const record = {
    room_name: roomName,
    current: countActivePlayers(room),
    max: room.maxPlayers,
    hasPassword: !!room.password,
    netplay_mode: room.netplay_mode || "live_stream",
    room_phase: room.room_phase || "running",
    sync_config: room.sync_config || null,
    spectator_mode: room.spectator_mode || 1,
    game_id: room.game_id || null,
    // Include metadata for DELAY_SYNC rooms
    metadata: room.metadata || null,
    // Legacy fields for backward compatibility
    rom_hash: room.rom_hash || null,
    core_type: room.core_type || null,
    nodeId: NODE_ID,
    url: PUBLIC_URL,
    updatedAt: Date.now(),
  };

  await rommInternalRequest({
    method: "POST",
    path: "/api/sfu/internal/rooms/upsert",
    body: record,
  });
}

async function registryDeleteRoom(roomName) {
  if (!ENABLE_ROOM_REGISTRY) return;
  await rommInternalRequest({
    method: "POST",
    path: "/api/sfu/internal/rooms/delete",
    body: { room_name: roomName },
  });
}

async function registryResolveRoom(roomName) {
  if (!ENABLE_ROOM_REGISTRY) return null;
  try {
    const rec = await rommInternalRequest({
      method: "GET",
      path: `/api/sfu/internal/rooms/resolve?room=${encodeURIComponent(
        roomName,
      )}`,
    });
    return rec || null;
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw err;
  }
}

async function registryListRooms() {
  if (!ENABLE_ROOM_REGISTRY) return null;
  const out = await rommInternalRequest({
    method: "GET",
    path: "/api/sfu/internal/rooms/list",
  });
  return out || {};
}

async function refreshLocalRoomRegistry() {
  if (!ENABLE_ROOM_REGISTRY) return;
  for (const roomName of locallyHostedRooms) {
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
app.use(express.json());

// Simple HTTP endpoint used by clients to list available rooms.
// Strict auth: must present a RoMM-issued JWT and it must be allowlisted by RomM.
// If the RomM room registry is enabled, this is a cluster-wide list.
app.get("/list", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenViaRomm(token, { consume: false });

    if (ENABLE_ROOM_REGISTRY) {
      const out = (await registryListRooms()) || {};
      return res.json(out);
    }

    const out = {};
    const now = Date.now();
    for (const [name, info] of rooms.entries()) {
      // Debug: log room state for this room
      if (name === "sdfdsf" || name.includes("sdf")) {
        console.log(`[HTTP /list] Room ${name} state:`, {
          netplay_mode: info.netplay_mode,
          rom_hash: info.rom_hash,
          rom_name: info.rom_name,
          core_type: info.core_type,
          coreId: info.coreId,
          system: info.system,
          platform: info.platform,
          allKeys: Object.keys(info),
        });
      }

      const webSocketPlayers = countActivePlayers(info);
      const httpJoinedPlayers = info.joinedPlayers
        ? info.joinedPlayers.size
        : 0;
      const currentPlayers = webSocketPlayers + httpJoinedPlayers;

      // Skip empty rooms that are older than 5 minutes (unless HTTP-created and very recent)
      const isEmpty = currentPlayers === 0;
      const ageMinutes = (now - (info.created_at || 0)) / (1000 * 60);

      if (isEmpty) {
        // Keep HTTP-created rooms for 1 minute, WebSocket-created for 5 minutes
        const keepMinutes = info.http_created ? 1 : 5;
        if (ageMinutes > keepMinutes) {
          console.log(
            `[HTTP] Skipping old empty room: ${name} (${ageMinutes.toFixed(1)} minutes old)`,
          );
          continue;
        }
      }

      out[name] = {
        room_name: name,
        current: currentPlayers,
        max: info.maxPlayers,
        hasPassword: !!info.password,
        netplay_mode:
          info.netplay_mode === "delay_sync" || info.netplay_mode === 1
            ? "delay_sync"
            : "live_stream", // Ensure consistent string format
        sync_config: info.sync_config || null,
        spectator_mode: info.spectator_mode || 1,
        rom_hash: info.rom_hash || null,
        core_type: info.core_type || null,
        rom_name: info.rom_name || null,
        system: info.system || null,
        platform: info.platform || null,
        coreId: info.coreId || null,
        coreVersion: info.coreVersion || null,
        romHash: info.romHash || null,
        systemType: info.systemType || null, // Add missing field
      };
    }
    res.json(out);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});

// Create a new room via HTTP
app.post("/create", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    const authResult = await verifySfuTokenViaRomm(token, { consume: true });

    const {
      room_name,
      max_players = 4,
      password,
      allow_spectators = true,
      netplay_mode = 0,
      sync_config = null,
      spectator_mode = 1,
      domain,
      game_id,
      rom_hash,
      core_type,
    } = req.body;

    if (!room_name) {
      return res.status(400).json({ error: "room_name is required" });
    }

    if (rooms.has(room_name)) {
      return res.status(409).json({ error: "room already exists" });
    }

    // Create room data structure similar to WebSocket room creation
    const players = new Map();
    const joinedPlayers = new Set();

    // Add the room creator to joined players
    if (authResult.netplay_username) {
      joinedPlayers.add(authResult.netplay_username);
    }

    const roomData = {
      owner: null, // HTTP-created rooms don't have an immediate owner socketi
      game_id,
      players,
      joinedPlayers, // Track HTTP-joined players
      maxPlayers: max_players,
      password,
      netplay_mode: netplay_mode === 1 ? "delay_sync" : "live_stream",
      room_phase: netplay_mode === 1 ? "lobby" : "running",
      sync_config,
      spectator_mode,
      // Legacy fields for backward compatibility
      rom_hash,
      core_type,
      // New structured metadata for DELAY_SYNC
      metadata:
        netplay_mode === 1
          ? {
              rom: {
                displayName: rom_hash || "Unknown ROM",
                hash: rom_hash ? { algo: "sha256", value: rom_hash } : null,
              },
              emulator: {
                id: core_type || "unknown",
                displayName: core_type || "Unknown Emulator",
                coreVersion: null,
              },
            }
          : null,
      http_created: true, // Mark as HTTP-created
      created_at: Date.now(),
      chatHistory: [],
    };

    // Add lobby state for delay sync rooms
    if (netplay_mode === 1) {
      roomData.lobby_state = {
        phase: "waiting",
        player_ready: new Map(),
      };
    }

    rooms.set(room_name, roomData);
    locallyHostedRooms.add(room_name);

    // Room assignment: choose a worker using least-loaded strategy
    await ensureRoomPrimaryAssigned(room_name);

    console.log(
      `[HTTP] Room created: ${room_name} (${max_players} players, mode: ${netplay_mode}, core: ${core_type}, rom: ${rom_hash})`,
    );

    res.json({
      room_id: room_name,
      room: {
        room_name,
        current: joinedPlayers.size, // Creator is already joined
        max: max_players,
        hasPassword: !!password,
        netplay_mode,
        sync_config,
        spectator_mode,
        game_id,
        rom_hash,
        core_type,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[HTTP] Room creation error:", msg);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});

// Join a room via HTTP
app.post("/join/:roomId", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenViaRomm(token, { consume: false });

    const { roomId } = req.params;
    const { password, player_name, domain } = req.body;

    if (!rooms.has(roomId)) {
      return res.status(404).json({ error: "room not found" });
    }

    const room = rooms.get(roomId);

    // Check password if required
    if (room.password && room.password !== password) {
      return res.status(403).json({ error: "incorrect password" });
    }

    // Check if room is full (count both HTTP-joined and WebSocket-connected players)
    const totalJoinedPlayers =
      (room.joinedPlayers ? room.joinedPlayers.size : 0) +
      countActivePlayers(room);
    if (totalJoinedPlayers >= room.maxPlayers) {
      return res.status(409).json({ error: "room is full" });
    }

    // Track HTTP-joined players
    if (!room.joinedPlayers) {
      room.joinedPlayers = new Set();
    }
    room.joinedPlayers.add(player_name);

    console.log(
      `[HTTP] Player ${player_name} joined room: ${roomId} (${room.joinedPlayers.size} HTTP joins, ${countActivePlayers(room)} WebSocket connections)`,
    );

    const webSocketPlayers = countActivePlayers(room);
    const httpJoinedPlayers = room.joinedPlayers ? room.joinedPlayers.size : 0;

    res.json({
      room_id: roomId,
      room: {
        room_name: roomId,
        current: webSocketPlayers + httpJoinedPlayers,
        max: room.maxPlayers,
        hasPassword: !!room.password,
        netplay_mode: room.netplay_mode || "live_stream",
        room_phase: room.room_phase || "running",
        sync_config: room.sync_config || null,
        spectator_mode: room.spectator_mode || 1,
        game_id: room.game_id || null,
        rom_hash: room.rom_hash || null,
        core_type: room.core_type || null,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[HTTP] Room join error:", msg);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});

// Leave a room via HTTP
app.post("/leave/:roomId", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenViaRomm(token, { consume: false });

    const { roomId } = req.params;

    if (!rooms.has(roomId)) {
      return res.status(404).json({ error: "room not found" });
    }

    // Note: HTTP leave is more of a notification - actual cleanup happens via WebSocket
    // This endpoint mainly serves to notify the server that a client is leaving
    console.log(`[HTTP] Player left room: ${roomId}`);

    res.json({ success: true });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[HTTP] Room leave error:", msg);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
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
    await verifySfuTokenViaRomm(token, { consume: false });

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

    if (!ENABLE_ROOM_REGISTRY) {
      return res.status(404).json({ error: "not found" });
    }

    const rec = await registryResolveRoom(roomName);
    if (!rec || !rec.url) {
      return res.status(404).json({ error: "not found" });
    }

    return res.json({ room_name: roomName, url: rec.url, nodeId: rec.nodeId });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});

// Return the ICE server list this node is configured to use.
// Auth matches /list and /resolve (RoMM-issued JWT verified via RomM internal API).
// Clients may use this to prefer node-local TURN/STUN servers, then append any
// local fallback list they have configured.
app.get("/ice", async (req, res) => {
  try {
    const token = pickSfuAuthTokenFromHttp(req);
    await verifySfuTokenViaRomm(token, { consume: false });

    logger.warn("/ice endpoint called, returning ICE servers:", {
      iceServers: SFU_ICE_SERVERS,
      iceServerCount: SFU_ICE_SERVERS.length,
      nodeId: NODE_ID,
    });

    return res.json({
      iceServers: SFU_ICE_SERVERS,
      nodeId: NODE_ID,
      url: PUBLIC_URL,
      announcedIp: process.env.ANNOUNCED_IP || null,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (
      msg.includes("not initialized") ||
      msg.includes("missing") ||
      msg.includes("not configured") ||
      msg.includes("timeout")
    ) {
      return res.status(503).json({ error: "auth unavailable" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
});
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  // Keep the SFU Socket.IO endpoint distinct from RomM's app Socket.IO
  // (RomM uses /ws/socket.io via the backend mount).
  path: "/socket.io",
});

// --- SFU authentication (RoMM-issued JWT + one-time JTI allowlist via RomM API) ---
//
// Flow:
// 1) Client requests POST /api/sfu/token from RoMM and gets a short-lived JWT (30s) with jti.
// 2) Client connects to SFU with that JWT (Socket.IO auth token).
// 3) SFU calls back into RoMM (/api/sfu/internal/verify) which verifies the JWT signature,
//    checks the Redis-backed allowlist, and optionally marks the token as used.

const SFU_AUTH_ISSUER = process.env.SFU_AUTH_ISSUER || "romm:sfu";
const SFU_AUTH_JTI_KEY_PREFIX =
  process.env.SFU_AUTH_JTI_KEY_PREFIX || "sfu:auth:jti:";
const SFU_AUTH_CLOCK_SKEW_SECONDS = Number.parseInt(
  process.env.SFU_AUTH_CLOCK_SKEW_SECONDS || "5",
  10,
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
    process.env.SFU_AUTH_TAKEOVER_GRACE_SECONDS || "30",
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

// Auth is verified by calling back into RomM (server-to-server), which checks
// JWT signature + Redis-backed JTI allowlist.

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

async function verifySfuTokenViaRomm(token, { consume }) {
  if (!token || typeof token !== "string") throw new Error("missing token");

  // Comment out token verification logging to reduce log spam
  // logger.debug("Verifying SFU token with RomM", {
  //   tokenPrefix: token.substring(0, 20) + "...",
  //   consume: !!consume
  // });

  const res = await rommInternalRequest({
    method: "POST",
    path: "/api/sfu/internal/verify",
    body: { token, consume: !!consume },
  });

  // Comment out token verification result logging to reduce log spam
  // logger.debug("RomM token verification result", {
  //   hasResponse: !!res,
  //   hasSub: res && !!res.sub,
  //   sub: res?.sub,
  //   netplayUsername: res?.netplay_username
  // });

  if (!res || !res.sub) throw new Error("unauthorized");
  return {
    sub: res.sub,
    netplay_username: res.netplay_username || null,
  };
}

function pickSfuAuthTokenFromSocket(socket) {
  // Preferred: Socket.IO auth payload.
  if (socket && socket.handshake && socket.handshake.auth) {
    const auth = socket.handshake.auth;
    logger.debug("SFU auth - handshake.auth:", JSON.stringify(auth));
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

// Decode JWT payload without verification (for checking token type)
// This is safe because we only use it to check the 'type' claim after
// the token has already been verified via RomM API.
function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Decode base64url-encoded payload (second part)
    const payload = parts[1];
    // Replace URL-safe base64 characters
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// Require write token for room operations (create/join)
function requireWriteToken(socket) {
  const tokenType = socket.data?.sfuTokenType;
  if (!tokenType || (tokenType !== "sfu:write" && tokenType !== "sfu")) {
    throw new Error("write token required for room operations");
  }
}

async function initSfuAuth() {
  if (!USE_ROMM_INTERNAL_API) {
    throw new Error("SFU auth requires ROMM_API_BASE_URL (RomM internal API)");
  }
  if (!ROMM_SFU_INTERNAL_SECRET) {
    throw new Error("SFU auth requires ROMM_SFU_INTERNAL_SECRET");
  }
  logger.info("SFU auth enabled (via RomM)", {
    issuer: SFU_AUTH_ISSUER,
    jtiPrefix: SFU_AUTH_JTI_KEY_PREFIX,
  });
}

io.use(async (socket, next) => {
  try {
    const token = pickSfuAuthTokenFromSocket(socket);
    logger.debug("SFU socket auth attempt", {
      hasToken: !!token,
      tokenPrefix: token ? token.substring(0, 20) + "..." : null,
      socketId: socket.id,
    });

    const user = await verifySfuTokenViaRomm(token, { consume: true });
    socket.data.sfuUser = user;

    return next();
  } catch (err) {
    logger.warn("SFU auth failed", {
      message: err && err.message ? err.message : String(err),
      ip: socket && socket.handshake ? socket.handshake.address : undefined,
      statusCode: err.statusCode,
      responseBody: err.body ? err.body.substring(0, 200) : undefined,
    });
    return next(new Error("unauthorized"));
  }
});

// Simple in-memory storage for transports/producers/consumers per socket
const peers = new Map(); // socketId -> { transports: Map, producers: Map }
const rooms = new Map(); // roomName -> { owner: socketId, players: Map(userid->extra), maxPlayers, password }

// mediasoup runtime state
// Worker pool allows vertical scaling on multi-core systems.
// Each worker has its own WebRtcServer (port = WEBRTC_PORT + idx).
const workerPool = []; // [{ idx, worker, webRtcServer, roomCount, rooms:Set<string> }]

// Per-room mediasoup state.
// - primaryWorkerIdx: chosen by least-loaded strategy.
// - routersByWorkerIdx: Map(workerIdx -> Router)
// - producerPipes: Map(sourceProducerId -> { sourceWorkerIdx, perWorker: Map(workerIdx -> producerId) })
// - dataProducerPipes: Map(sourceDataProducerId -> { sourceWorkerIdx, perWorker: Map(workerIdx -> dataProducerId) })
// - peerCounts: Map(workerIdx -> number)
const roomMediasoup = new Map();

// Track producer origin for mapping and debugging.
const producerMeta = new Map(); // producerId -> { roomName, workerIdx, socketId, kind }
const dataProducerMeta = new Map(); // dataProducerId -> { roomName, workerIdx, socketId, label, protocol }

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      stereo: 1,
    },
  },
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

function getOrCreateRoomState(roomName) {
  let st = roomMediasoup.get(roomName);
  if (!st) {
    st = {
      roomName,
      primaryWorkerIdx: null,
      routersByWorkerIdx: new Map(),
      producerPipes: new Map(),
      dataProducerPipes: new Map(),
      peerCounts: new Map(),
    };
    roomMediasoup.set(roomName, st);
  }
  return st;
}

function pickLeastLoadedWorkerIdx() {
  if (workerPool.length === 0) return 0;
  let bestIdx = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < workerPool.length; i++) {
    const w = workerPool[i];
    const roomCount = w && typeof w.roomCount === "number" ? w.roomCount : 0;
    if (roomCount < bestScore) {
      bestScore = roomCount;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function getOrCreateRoomRouter(roomName, workerIdx) {
  const st = getOrCreateRoomState(roomName);
  if (st.routersByWorkerIdx.has(workerIdx)) {
    return st.routersByWorkerIdx.get(workerIdx);
  }

  const w = workerPool[workerIdx];
  if (!w || !w.worker) throw new Error("worker not available");
  const r = await w.worker.createRouter({ mediaCodecs });
  st.routersByWorkerIdx.set(workerIdx, r);
  w.rooms.add(roomName);
  w.roomCount = w.rooms.size;
  logger.info("mediasoup router created for room", {
    room: roomName,
    workerIdx,
    roomsOnWorker: w.roomCount,
  });
  return r;
}

async function ensureRoomPrimaryAssigned(roomName) {
  const st = getOrCreateRoomState(roomName);
  if (typeof st.primaryWorkerIdx === "number") return st.primaryWorkerIdx;
  const chosen = pickLeastLoadedWorkerIdx();
  st.primaryWorkerIdx = chosen;
  await getOrCreateRoomRouter(roomName, chosen);
  return chosen;
}

function isViewerExtra(extra) {
  // Check explicit spectator flag first
  if (extra && extra.is_spectator === true) {
    return true;
  }

  // Heuristic: if player_slot is a valid controller slot, treat as a player.
  // Viewers typically won't set it, or have slot 8 (spectator).
  try {
    const ps = extra && extra.player_slot;
    if (ps === 0 || ps === 1 || ps === 2 || ps === 3) return false;
    if (ps === 8) return true; // Explicitly mark slot 8 as spectator
  } catch {
    // ignore
  }
  return true;
}

function countActivePlayers(room) {
  // Count players that are not spectators
  if (!room || !room.players) return 0;
  let count = 0;
  for (const extra of room.players.values()) {
    if (!isViewerExtra(extra)) {
      count++;
    }
  }
  return count;
}

function getPeerAssignedWorkerIdx(socketId, roomName) {
  const peer = peers.get(socketId);
  if (peer && typeof peer.workerIdx === "number") return peer.workerIdx;
  const st = roomName ? roomMediasoup.get(roomName) : null;
  if (st && typeof st.primaryWorkerIdx === "number") return st.primaryWorkerIdx;
  return 0;
}

function incrementRoomPeerCount(roomName, workerIdx, delta) {
  const st = getOrCreateRoomState(roomName);
  const prev = st.peerCounts.get(workerIdx) || 0;
  const next = Math.max(0, prev + delta);
  st.peerCounts.set(workerIdx, next);
}

function cleanupRoomMediasoup(roomName) {
  try {
    const st = roomMediasoup.get(roomName);
    if (st && st.routersByWorkerIdx) {
      for (const r of st.routersByWorkerIdx.values()) {
        try {
          r && r.close && r.close();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    for (const w of workerPool) {
      if (!w || !w.rooms) continue;
      if (w.rooms.delete(roomName)) {
        w.roomCount = w.rooms.size;
      }
    }
  } catch {
    // ignore
  }

  try {
    roomMediasoup.delete(roomName);
  } catch {
    // ignore
  }
}

async function ensurePipedProducerForWorker({
  roomName,
  sourceProducerId,
  targetWorkerIdx,
}) {
  const st = getOrCreateRoomState(roomName);
  const pipeRec = st.producerPipes.get(sourceProducerId);
  if (!pipeRec) return null;
  if (pipeRec.perWorker.has(targetWorkerIdx))
    return pipeRec.perWorker.get(targetWorkerIdx);

  const sourceWorkerIdx = pipeRec.sourceWorkerIdx;
  if (sourceWorkerIdx === targetWorkerIdx) {
    pipeRec.perWorker.set(targetWorkerIdx, sourceProducerId);
    return sourceProducerId;
  }

  const sourceRouter = st.routersByWorkerIdx.get(sourceWorkerIdx);
  const targetRouter = st.routersByWorkerIdx.get(targetWorkerIdx);
  if (!sourceRouter || !targetRouter) return null;

  const { pipeProducer } = await sourceRouter.pipeToRouter({
    producerId: sourceProducerId,
    router: targetRouter,
  });
  pipeRec.perWorker.set(targetWorkerIdx, pipeProducer.id);
  logger.info("piped producer to worker", {
    room: roomName,
    sourceProducerId,
    sourceWorkerIdx,
    targetWorkerIdx,
    pipedProducerId: pipeProducer.id,
  });
  return pipeProducer.id;
}

async function registerRoomProducer({ roomName, producerId, sourceWorkerIdx }) {
  const st = getOrCreateRoomState(roomName);
  if (!st.producerPipes.has(producerId)) {
    st.producerPipes.set(producerId, {
      sourceWorkerIdx,
      perWorker: new Map([[sourceWorkerIdx, producerId]]),
    });
  }
  // If the room already has routers on other workers, pre-pipe now.
  for (const workerIdx of st.routersByWorkerIdx.keys()) {
    if (workerIdx === sourceWorkerIdx) continue;
    try {
      await ensurePipedProducerForWorker({
        roomName,
        sourceProducerId: producerId,
        targetWorkerIdx: workerIdx,
      });
    } catch (e) {
      logger.warn("failed piping producer", {
        room: roomName,
        producerId,
        targetWorkerIdx: workerIdx,
        error: e && e.message ? e.message : String(e),
      });
    }
  }
}

async function ensurePipedDataProducerForWorker({
  roomName,
  sourceDataProducerId,
  targetWorkerIdx,
}) {
  const st = getOrCreateRoomState(roomName);
  const pipeRec = st.dataProducerPipes.get(sourceDataProducerId);
  if (!pipeRec) return null;
  if (pipeRec.perWorker.has(targetWorkerIdx))
    return pipeRec.perWorker.get(targetWorkerIdx);

  const sourceWorkerIdx = pipeRec.sourceWorkerIdx;
  if (sourceWorkerIdx === targetWorkerIdx) {
    pipeRec.perWorker.set(targetWorkerIdx, sourceDataProducerId);
    return sourceDataProducerId;
  }

  const sourceRouter = st.routersByWorkerIdx.get(sourceWorkerIdx);
  const targetRouter = st.routersByWorkerIdx.get(targetWorkerIdx);
  if (!sourceRouter || !targetRouter) return null;

  const res = await sourceRouter.pipeToRouter({
    dataProducerId: sourceDataProducerId,
    router: targetRouter,
  });

  const piped = res && (res.pipeDataProducer || res.pipeProducer);
  if (!piped || !piped.id) return null;

  pipeRec.perWorker.set(targetWorkerIdx, piped.id);
  logger.info("piped dataProducer to worker", {
    room: roomName,
    sourceDataProducerId,
    sourceWorkerIdx,
    targetWorkerIdx,
    pipedDataProducerId: piped.id,
  });
  return piped.id;
}

async function registerRoomDataProducer({
  roomName,
  dataProducerId,
  sourceWorkerIdx,
}) {
  const st = getOrCreateRoomState(roomName);
  if (!st.dataProducerPipes.has(dataProducerId)) {
    st.dataProducerPipes.set(dataProducerId, {
      sourceWorkerIdx,
      perWorker: new Map([[sourceWorkerIdx, dataProducerId]]),
    });
  }
  // If the room already has routers on other workers, pre-pipe now.
  for (const workerIdx of st.routersByWorkerIdx.keys()) {
    if (workerIdx === sourceWorkerIdx) continue;
    try {
      await ensurePipedDataProducerForWorker({
        roomName,
        sourceDataProducerId: dataProducerId,
        targetWorkerIdx: workerIdx,
      });
    } catch (e) {
      logger.warn("failed piping dataProducer", {
        room: roomName,
        dataProducerId,
        targetWorkerIdx: workerIdx,
        error: e && e.message ? e.message : String(e),
      });
    }
  }
}

async function runMediasoup() {
  logger.info("initializing mediasoup", {
    requestedWorkers: SFU_WORKER_COUNT_RAW,
    workerCount: SFU_WORKER_COUNT,
    availableCores: SFU_CPU_CORES,
    useWebRtcServer: USE_WEBRTC_SERVER,
    baseWebRtcPort: WEBRTC_PORT,
    udpBasePort: WEBRTC_UDP_PORT,
    tcpEnabled: ENABLE_WEBRTC_TCP,
    tcpBasePort: WEBRTC_TCP_PORT,
    fanoutEnabled: SFU_FANOUT_ENABLED,
    fanoutViewerThreshold: SFU_FANOUT_VIEWER_THRESHOLD,
  });

  workerPool.length = 0;
  for (let idx = 0; idx < SFU_WORKER_COUNT; idx++) {
    const w = await mediasoup.createWorker({
      rtcMinPort: RTC_MIN_PORT,
      rtcMaxPort: RTC_MAX_PORT,
    });

    w.on("died", () => {
      console.error("mediasoup worker died, exiting in 2 seconds...", {
        workerIdx: idx,
      });
      setTimeout(() => process.exit(1), 2000);
    });

    let webRtcServer = null;
    if (USE_WEBRTC_SERVER) {
      const listenInfos = [];

      // Increment based on WEBRTC_PORT (and derived UDP/TCP ports).
      const udpInfo = {
        protocol: "udp",
        ip: LISTEN_IP,
        port: WEBRTC_UDP_PORT + idx,
      };
      if (ANNOUNCED_ADDRESS) udpInfo.announcedAddress = ANNOUNCED_ADDRESS;
      listenInfos.push(udpInfo);

      if (ENABLE_WEBRTC_TCP) {
        const tcpInfo = {
          protocol: "tcp",
          ip: LISTEN_IP,
          port: WEBRTC_TCP_PORT + idx,
        };
        if (ANNOUNCED_ADDRESS) tcpInfo.announcedAddress = ANNOUNCED_ADDRESS;
        listenInfos.push(tcpInfo);
      }

      webRtcServer = await w.createWebRtcServer({ listenInfos });
      logger.info("mediasoup WebRtcServer created", {
        workerIdx: idx,
        udpPort: WEBRTC_UDP_PORT + idx,
        tcpEnabled: ENABLE_WEBRTC_TCP,
        tcpPort: ENABLE_WEBRTC_TCP ? WEBRTC_TCP_PORT + idx : null,
        announcedAddress: ANNOUNCED_ADDRESS,
      });
    }

    workerPool.push({
      idx,
      worker: w,
      webRtcServer,
      roomCount: 0,
      rooms: new Set(),
    });
  }
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
      // Create a client-safe version of the extra data
      // Exclude server-only fields like player_name (uncensored netplayID)
      const clientExtra = { ...extra };
      // Mark the room owner
      if (extra.userid === room.owner) {
        console.log(`[SFU] Setting is_host for player ${uid}`);
        clientExtra.is_host = true;
      }
      delete clientExtra.player_name; // Server-side only - uncensored netplayID
      // Keep netplay_username for display (censored if needed)
      users[uid] = clientExtra;
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

  const sfuUser = socket.data && socket.data.sfuUser;
  // If SFU auth is enabled, generate a UUID for the userid and bind it immediately.
  let authUserid = null;
  try {
    if (SFU_REQUIRE_AUTH) {
      // Generate a stable UUID based on the JWT sub for consistent user identification
      const crypto = require("crypto");
      authUserid = crypto
        .createHash("sha256")
        .update(sfuUser.sub)
        .digest("hex")
        .substring(0, 36);
      authUserid =
        authUserid.substring(0, 8) +
        "-" +
        authUserid.substring(8, 12) +
        "-" +
        authUserid.substring(12, 16) +
        "-" +
        authUserid.substring(16, 20) +
        "-" +
        authUserid.substring(20, 36);
      bindUseridToSocket(authUserid);
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

    // For SFU auth, use the JWT sub as the player display name
    if (SFU_REQUIRE_AUTH && sfuUser) {
      storedExtra.player_name = sfuUser.sub; // Use JWT sub as display name
    }

    // Do not trust client-provided userid when SFU auth is enabled.
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
        },
      );
    }

    // We use player_name as single source of truth for client software
    // netplay_username is only used for server side identification.
    // This allows server side identification, but censor for clients.
    if (!storedExtra.player_name) {
      storedExtra.player_name = assignedUserid;
    }

    // Backup the original netplay username if we apply rewriting.
    // Example, if enforcing server side censorship on federated netplay.
    // This way we can identify users on server, but censor for clients.
    if (sfuUser) {
      storedExtra.netplay_username = storedExtra.player_name;
    }
    storedExtra.userid = assignedUserid;

    return storedExtra;
  };

  socket.on("sfu-available", (data, cb) => {
    cb && cb({ available: workerPool.length > 0 });
  });

  socket.on("sfu-get-router-rtp-capabilities", (data, cb) => {
    try {
      const roomName = getSocketRoomName();
      if (roomName) {
        ensureRoomPrimaryAssigned(roomName)
          .then((primaryIdx) => getOrCreateRoomRouter(roomName, primaryIdx))
          .then((r) => cb && cb(null, r.rtpCapabilities))
          .catch((e) => cb && cb(e.message || "error"));
        return;
      }

      // Fallback before join/open: return capabilities from a temporary router
      // on worker 0 (ensures client can bootstrap).
      const tempRoom = "__bootstrap__";
      ensureRoomPrimaryAssigned(tempRoom)
        .then((primaryIdx) => getOrCreateRoomRouter(tempRoom, primaryIdx))
        .then((r) => cb && cb(null, r.rtpCapabilities))
        .catch((e) => cb && cb(e.message || "error"));
    } catch (e) {
      cb && cb(e.message || "error");
    }
  });

  // Create a WebRTC transport on the SFU for the client.
  socket.on("sfu-create-transport", async ({ direction }, cb) => {
    try {
      const roomName = getSocketRoomName();
      if (!roomName) throw new Error("no room");
      await ensureRoomPrimaryAssigned(roomName);

      const peer = peers.get(socket.id);
      if (!peer) throw new Error("peer not found");
      // If the peer isn't assigned yet, default them to the room's primary worker.
      if (typeof peer.workerIdx !== "number") {
        const st = getOrCreateRoomState(roomName);
        peer.workerIdx = st.primaryWorkerIdx;
        peer.roomName = roomName;
        incrementRoomPeerCount(roomName, peer.workerIdx, 1);
      }

      // Ensure the room has a router on this worker.
      // For fanout, viewers may be assigned to a secondary worker.
      const workerIdx = peer.workerIdx;
      const roomRouter = await getOrCreateRoomRouter(roomName, workerIdx);
      const w = workerPool[workerIdx];
      const webRtcServer = w ? w.webRtcServer : null;

      const transportOptions = {
        enableUdp: true,
        enableTcp: ENABLE_WEBRTC_TCP,
        preferUdp: true,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        // ICE servers: STUN via SFU_STUN_SERVERS, TURN via SFU_TURN_SERVERS or SFU_TURN_SERVER1..4.
        iceServers: SFU_ICE_SERVERS,
      };

      // Prefer WebRtcServer when enabled; otherwise fall back to per-transport listenIps.
      if (webRtcServer) {
        transportOptions.webRtcServer = webRtcServer;
      } else {
        if (!process.env.ANNOUNCED_IP) {
          throw new Error(
            "CRITICAL: ANNOUNCED_IP environment variable is not defined!",
          );
        }

        transportOptions.listenIps = [
          {
            ip: LISTEN_IP,
            announcedIp: process.env.ANNOUNCED_IP,
          },
        ];
      }

      const transport =
        await roomRouter.createWebRtcTransport(transportOptions);

      peers.get(socket.id).transports.set(transport.id, transport);
      logger.debug("sfu-create-transport:", {
        socket: socket.id,
        direction,
        transportId: transport.id,
        room: roomName,
        workerIdx,
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
    },
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

      // Record origin for mapping/piping.
      const roomNameForProducer = getSocketRoomName();
      const producingPeer = peers.get(socket.id);
      const sourceWorkerIdx = producingPeer
        ? getPeerAssignedWorkerIdx(socket.id, roomNameForProducer)
        : 0;
      if (roomNameForProducer) {
        producerMeta.set(producer.id, {
          roomName: roomNameForProducer,
          workerIdx: sourceWorkerIdx,
          socketId: socket.id,
          kind,
        });
        // Ensure producer is registered and piped to any existing secondary routers.
        await registerRoomProducer({
          roomName: roomNameForProducer,
          producerId: producer.id,
          sourceWorkerIdx,
        });
      }
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
        producerMeta.delete(producer.id);
      });

      // Log producer lifecycle events to aid debugging
      producer.on("pause", () =>
        logger.debug("producer paused", {
          socket: socket.id,
          producerId: producer.id,
        }),
      );
      producer.on("resume", () =>
        logger.debug("producer resumed", {
          socket: socket.id,
          producerId: producer.id,
        }),
      );
      producer.on("close", () => {
        logger.debug("producer closed", {
          socket: socket.id,
          producerId: producer.id,
        });
        peers.get(socket.id).producers.delete(producer.id);
        producerMeta.delete(producer.id);
      });

      // Notify other clients in the same room that a new producer is available.
      // If fan-out is enabled and the room spans multiple workers, each receiver
      // must be told the correct producer id for its worker's router.
      const roomName = roomNameForProducer || getSocketRoomName();
      if (roomName && rooms.has(roomName)) {
        try {
          const st = getOrCreateRoomState(roomName);
          const socketsInRoom = await io.in(roomName).fetchSockets();
          for (const s of socketsInRoom) {
            if (!s || s.id === socket.id) continue;
            const targetWorkerIdx = getPeerAssignedWorkerIdx(s.id, roomName);
            let idForTarget = producer.id;
            if (
              SFU_FANOUT_ENABLED &&
              typeof targetWorkerIdx === "number" &&
              typeof sourceWorkerIdx === "number" &&
              targetWorkerIdx !== sourceWorkerIdx
            ) {
              // Ensure a router exists on that worker; then ensure piping.
              await getOrCreateRoomRouter(roomName, targetWorkerIdx);
              const pipedId = await ensurePipedProducerForWorker({
                roomName,
                sourceProducerId: producer.id,
                targetWorkerIdx,
              });
              if (pipedId) idForTarget = pipedId;
            }
            s.emit("new-producer", { id: idForTarget, kind: producer.kind });
          }
          logger.debug("broadcast new-producer to room", roomName, {
            producerId: producer.id,
          });
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
    "producedata",
    async (
      { transportId, sctpStreamParameters, label, protocol, appData },
      cb,
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
            e,
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

        // Record origin for mapping/piping.
        const roomNameForProducer = getSocketRoomName();
        const sourceWorkerIdx = peer
          ? getPeerAssignedWorkerIdx(socket.id, roomNameForProducer)
          : 0;
        if (roomNameForProducer) {
          dataProducerMeta.set(dataProducer.id, {
            roomName: roomNameForProducer,
            workerIdx: sourceWorkerIdx,
            socketId: socket.id,
            label,
            protocol,
          });
          await registerRoomDataProducer({
            roomName: roomNameForProducer,
            dataProducerId: dataProducer.id,
            sourceWorkerIdx,
          });
        }

        if (SFU_REQUIRE_BINARY_DATA_CHANNEL) {
          dataProducer.on("message", (message, ppid) => {
            try {
              // Allow JSON protocol data channels (used by EmulatorJS for input relay)
              if (
                dataProducer.protocol === "json" ||
                isBinaryDataChannelMessage(message, ppid)
              )
                return;

              logger.warn("dataProducer sent non-binary message; closing", {
                socket: socket.id,
                dataProducerId: dataProducer.id,
                label: dataProducer.label,
                protocol: dataProducer.protocol,
                ppid,
                messageType: typeof message,
              });

              logger.error("Closing data producer due to non-binary message", {
                dataProducerId: dataProducer.id,
                socket: socket.id,
                label: dataProducer.label,
                protocol: dataProducer.protocol,
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
          logger.warn("Data producer transport closed", {
            dataProducerId: dataProducer.id,
            socket: socket.id,
            label: dataProducer.label,
            protocol: dataProducer.protocol,
          });
          try {
            peer.dataProducers.delete(dataProducer.id);
            dataProducerMeta.delete(dataProducer.id);
          } catch (e) {}
        });
        dataProducer.on("close", () => {
          try {
            peer.dataProducers.delete(dataProducer.id);
            dataProducerMeta.delete(dataProducer.id);
          } catch (e) {}
        });

        const roomName = roomNameForProducer || getSocketRoomName();
        if (roomName && rooms.has(roomName)) {
          try {
            const socketsInRoom = await io.in(roomName).fetchSockets();
            logger.info("data producer created", {
              producerSocketId: socket.id,
              roomName,
              dataProducerId: dataProducer.id,
              label: dataProducer.label,
              totalSocketsInRoom: socketsInRoom.length,
              socketIdsInRoom: socketsInRoom.map((s) => s.id),
            });

            for (const s of socketsInRoom) {
              if (!s || s.id === socket.id) {
                logger.info("skipping socket for data producer broadcast", {
                  skippedSocketId: s?.id,
                  producerSocketId: socket.id,
                  reason:
                    s?.id === socket.id ? "same socket" : "invalid socket",
                });
                continue;
              }
              const targetWorkerIdx = getPeerAssignedWorkerIdx(s.id, roomName);
              let idForTarget = dataProducer.id;
              if (
                SFU_FANOUT_ENABLED &&
                typeof targetWorkerIdx === "number" &&
                typeof sourceWorkerIdx === "number" &&
                targetWorkerIdx !== sourceWorkerIdx
              ) {
                await getOrCreateRoomRouter(roomName, targetWorkerIdx);
                const pipedId = await ensurePipedDataProducerForWorker({
                  roomName,
                  sourceDataProducerId: dataProducer.id,
                  targetWorkerIdx,
                });
                if (pipedId) idForTarget = pipedId;
              }
              logger.info("emitting new-data-producer to socket", {
                targetSocketId: s.id,
                producerSocketId: socket.id,
                dataProducerId: idForTarget,
                roomName,
                targetConnected: s.connected,
              });
              s.emit("new-data-producer", { id: idForTarget });
            }

            logger.info("broadcast new-data-producer to room", roomName, {
              dataProducerId: dataProducer.id,
              label: dataProducer.label,
              sockets: socketsInRoom.length,
            });
          } catch (e) {
            logger.warn(
              "Failed to broadcast new-data-producer to room",
              roomName,
              e,
            );
          }
        }

        cb && cb(null, dataProducer.id);
      } catch (err) {
        console.error("sfu-produce-data error", err);
        cb && cb(err.message);
      }
    },
  );

  socket.on("sfu-get-data-producers", async (data, cb) => {
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
          let outId = pid;

          if (SFU_FANOUT_ENABLED && workerPool.length > 1) {
            const targetWorkerIdx = getPeerAssignedWorkerIdx(
              socket.id,
              roomName,
            );
            const meta = dataProducerMeta.get(pid);
            const sourceWorkerIdx =
              meta && typeof meta.workerIdx === "number"
                ? meta.workerIdx
                : getPeerAssignedWorkerIdx(sid, roomName);

            if (
              typeof targetWorkerIdx === "number" &&
              typeof sourceWorkerIdx === "number" &&
              targetWorkerIdx !== sourceWorkerIdx
            ) {
              const st = getOrCreateRoomState(roomName);
              if (!st.dataProducerPipes.has(pid)) {
                st.dataProducerPipes.set(pid, {
                  sourceWorkerIdx,
                  perWorker: new Map([[sourceWorkerIdx, pid]]),
                });
              }
              await getOrCreateRoomRouter(roomName, sourceWorkerIdx);
              await getOrCreateRoomRouter(roomName, targetWorkerIdx);
              const pipedId = await ensurePipedDataProducerForWorker({
                roomName,
                sourceDataProducerId: pid,
                targetWorkerIdx,
              });
              if (pipedId) outId = pipedId;
            }
          }

          list.push({ id: outId, kind: "data" });
        }
      }

      cb && cb(null, list);
    } catch (err) {
      console.error("sfu-get-data-producers error", err);
      cb && cb(err.message);
    }
  });

  socket.on("consumedata", async ({ dataProducerId, transportId }, cb) => {
    try {
      logger.debug("sfu-consume-data request from", socket.id, {
        dataProducerId,
        transportId,
      });

      const roomName = getSocketRoomName();
      if (!roomName) throw new Error("no room");

      const room = rooms.get(roomName);
      if (!room) throw new Error("no such room");

      const peer = peers.get(socket.id);
      if (!peer) throw new Error("peer not found");

      const transport =
        peer && peer.transports && peer.transports.get(transportId);
      if (!transport) throw new Error("transport not found");

      const consumerWorkerIdx = getPeerAssignedWorkerIdx(socket.id, roomName);
      // Ensure the room router exists for this worker (consumeData must match router).
      await getOrCreateRoomRouter(roomName, consumerWorkerIdx);

      let effectiveDataProducerId = dataProducerId;

      const tryConsume = async (id) => {
        const dc = await transport.consumeData({ dataProducerId: id });
        return dc;
      };

      // Fast path: if it's already a local id for this router, consume directly.
      let dataConsumer = null;
      try {
        dataConsumer = await tryConsume(effectiveDataProducerId);
      } catch {
        dataConsumer = null;
      }

      if (!dataConsumer) {
        // Determine source mapping for fan-out.
        const st = getOrCreateRoomState(roomName);
        let sourceDataProducerId = dataProducerId;
        let sourceWorkerIdx = null;

        const meta = dataProducerMeta.get(dataProducerId);
        if (meta && typeof meta.workerIdx === "number") {
          sourceWorkerIdx = meta.workerIdx;
        } else {
          const rec = st.dataProducerPipes.get(dataProducerId);
          if (rec && typeof rec.sourceWorkerIdx === "number") {
            sourceWorkerIdx = rec.sourceWorkerIdx;
          }
        }

        // If they passed a piped id already, attempt to find the source mapping.
        if (sourceWorkerIdx === null) {
          for (const [srcId, rec] of st.dataProducerPipes.entries()) {
            if (!rec || !rec.perWorker) continue;
            for (const pipedId of rec.perWorker.values()) {
              if (pipedId === dataProducerId) {
                sourceDataProducerId = srcId;
                sourceWorkerIdx = rec.sourceWorkerIdx;
                break;
              }
            }
            if (sourceWorkerIdx !== null) break;
          }
        }

        // Last resort: validate the id belongs to the room by scanning known producers.
        if (sourceWorkerIdx === null) {
          const socketIds = new Set();
          if (room.owner) socketIds.add(room.owner);
          for (const extra of room.players.values()) {
            const sid = extra && (extra.socketId || extra.socket_id);
            if (sid) socketIds.add(sid);
          }
          for (const sid of socketIds) {
            const pinfo = peers.get(sid);
            const dp =
              pinfo &&
              pinfo.dataProducers &&
              pinfo.dataProducers.get(dataProducerId);
            if (dp) {
              sourceWorkerIdx = getPeerAssignedWorkerIdx(sid, roomName);
              break;
            }
          }
        }

        if (
          SFU_FANOUT_ENABLED &&
          typeof sourceWorkerIdx === "number" &&
          consumerWorkerIdx !== sourceWorkerIdx
        ) {
          if (!st.dataProducerPipes.has(sourceDataProducerId)) {
            st.dataProducerPipes.set(sourceDataProducerId, {
              sourceWorkerIdx,
              perWorker: new Map([[sourceWorkerIdx, sourceDataProducerId]]),
            });
          }

          await getOrCreateRoomRouter(roomName, sourceWorkerIdx);
          await getOrCreateRoomRouter(roomName, consumerWorkerIdx);

          const pipedId = await ensurePipedDataProducerForWorker({
            roomName,
            sourceDataProducerId,
            targetWorkerIdx: consumerWorkerIdx,
          });
          if (pipedId) {
            effectiveDataProducerId = pipedId;
          }
        }

        // Try again after mapping/piping.
        dataConsumer = await tryConsume(effectiveDataProducerId);
      }

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

  socket.on("sfu-get-producers", async (data, cb) => {
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

      console.log(
        `[SFU] sfu-get-producers: checking producers for sockets:`,
        Array.from(socketIds),
      );
      for (const sid of socketIds) {
        const pinfo = peers.get(sid);
        if (!pinfo || !pinfo.producers) {
          console.log(
            `[SFU] sfu-get-producers: no producers for socket ${sid}`,
          );
          continue;
        }
        console.log(
          `[SFU] sfu-get-producers: found ${pinfo.producers.size} producers for socket ${sid}`,
        );
        for (const [pid] of pinfo.producers) {
          console.log(
            `[SFU] sfu-get-producers: processing producer ${pid} from socket ${sid}`,
          );
          let outId = pid;

          // Check if piping is needed
          const targetWorkerIdx = getPeerAssignedWorkerIdx(socket.id, roomName);
          const sourceWorkerIdx = getPeerAssignedWorkerIdx(sid, roomName);
          console.log(
            `[SFU] sfu-get-producers: producer ${pid} - source worker: ${sourceWorkerIdx}, target worker: ${targetWorkerIdx}`,
          );

          if (sourceWorkerIdx !== targetWorkerIdx) {
            console.log(
              `[SFU] sfu-get-producers: attempting to pipe producer ${pid} from worker ${sourceWorkerIdx} to ${targetWorkerIdx}`,
            );
            try {
              const pipedId = await ensurePipedProducerForWorker({
                roomName,
                sourceProducerId: pid,
                targetWorkerIdx,
              });
              if (pipedId) {
                console.log(
                  `[SFU] sfu-get-producers: successfully piped ${pid} -> ${pipedId}`,
                );
                outId = pipedId;
              } else {
                console.log(
                  `[SFU] sfu-get-producers: piping failed for ${pid}, using original ID`,
                );
              }
            } catch (pipeError) {
              console.error(
                `[SFU] sfu-get-producers: piping error for ${pid}:`,
                pipeError,
              );
            }
          } else {
            console.log(
              `[SFU] sfu-get-producers: no piping needed for ${pid} (same worker)`,
            );
          }

          if (SFU_FANOUT_ENABLED && workerPool.length > 1) {
            const targetWorkerIdx = getPeerAssignedWorkerIdx(
              socket.id,
              roomName,
            );
            const meta = producerMeta.get(pid);
            const sourceWorkerIdx =
              meta && typeof meta.workerIdx === "number"
                ? meta.workerIdx
                : getPeerAssignedWorkerIdx(sid, roomName);

            if (
              typeof targetWorkerIdx === "number" &&
              typeof sourceWorkerIdx === "number" &&
              targetWorkerIdx !== sourceWorkerIdx
            ) {
              const st = getOrCreateRoomState(roomName);
              if (!st.producerPipes.has(pid)) {
                st.producerPipes.set(pid, {
                  sourceWorkerIdx,
                  perWorker: new Map([[sourceWorkerIdx, pid]]),
                });
              }
              await getOrCreateRoomRouter(roomName, sourceWorkerIdx);
              await getOrCreateRoomRouter(roomName, targetWorkerIdx);
              const pipedId = await ensurePipedProducerForWorker({
                roomName,
                sourceProducerId: pid,
                targetWorkerIdx,
              });
              if (pipedId) outId = pipedId;
            }
          }

          // Include producer metadata for proper client handling
          const producer = pinfo.producers.get(pid); // Get the actual producer object
          const meta = producerMeta.get(pid); // Get producer metadata
          const producerKind = meta
            ? meta.kind
            : producer
              ? producer.kind
              : "unknown";

          list.push({
            id: outId,
            kind: producerKind,
          });
        } // Close inner for loop
      } // Close outer for loop

      console.log("sfu-get-producers result:", {
        socket: socket.id,
        room: roomName,
        returned: list.length,
        producers: list,
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
      if (!rooms.has(roomName) && ENABLE_ROOM_REGISTRY) {
        const existing = await registryResolveRoom(roomName);
        if (existing && existing.url && existing.url !== PUBLIC_URL) {
          return cb && cb("room exists");
        }
      }

      let room;
      if (rooms.has(roomName)) {
        // Allow joining existing HTTP-created rooms via Socket.IO open-room
        room = rooms.get(roomName);
        if (room && room.http_created) {
          // Join existing HTTP-created room
          console.log(`[SFU] Joining existing HTTP-created room: ${roomName}`);
        } else {
          return cb && cb("room exists");
        }
      } else {
        // Create new room
        const assignedUserid = getAssignedUserid();

        // Extract netplay data from extra (before normalization/auth)
        const clientNetplayMode =
          extra.netplay_mode === 1 ? "delay_sync" : "live_stream";
        const clientRoomPhase =
          extra.room_phase ||
          (clientNetplayMode === "delay_sync" ? "lobby" : "running");
        const romHash = extra.romHash || extra.rom_hash || null;
        const romName = extra.rom_name || extra.romFilename || null;
        const coreType = extra.core_type || extra.coreId || null;

        room = {
          owner: assignedUserid,
          players: new Map(),
          maxPlayers,
          password,
          netplay_mode: clientNetplayMode,
          room_phase: clientRoomPhase,
          sync_config: extra.sync_config || null,
          spectator_mode:
            extra.spectator_mode !== undefined ? extra.spectator_mode : 1,
          game_id: extra.game_id || null,
          rom_hash: romHash,
          core_type: coreType,
          rom_name: romName,
          system: extra.system || null,
          platform: extra.platform || null,
          coreId: coreType,
          coreVersion: extra.coreVersion || null,
          romHash: romHash,
          systemType: extra.systemType || null,
          lobby_state:
            clientNetplayMode === "delay_sync"
              ? {
                  phase: "waiting",
                  player_ready: new Map(),
                }
              : null,
          chatHistory: [],
          mutex: new Mutex(),
          http_created: false,
        };
        rooms.set(roomName, room);
        locallyHostedRooms.add(roomName);
      }

      const storedExtra = applyAuthToExtra(normalizeExtra(extra));

      // Debug: log what we received from client
      console.log(
        `[SFU] open-room received storedExtra for room ${roomName}:`,
        {
          netplay_mode: storedExtra.netplay_mode,
          romHash: storedExtra.romHash,
          rom_hash: storedExtra.rom_hash,
          rom_name: storedExtra.rom_name,
          romFilename: storedExtra.romFilename,
          coreId: storedExtra.coreId,
          core_type: storedExtra.core_type,
          system: storedExtra.system,
          platform: storedExtra.platform,
          allKeys: Object.keys(storedExtra),
        },
      );

      // Set room netplay_mode from client data when creating new room (not HTTP-created)
      if (room && !room.http_created) {
        const clientMode =
          storedExtra.netplay_mode === 1 ? "delay_sync" : "live_stream";
        room.netplay_mode = clientMode;
        room.room_phase =
          storedExtra.room_phase ||
          (clientMode === "delay_sync" ? "lobby" : "running");
        console.log(
          `[SFU] Room ${roomName} created with netplay_mode: ${clientMode}, room_phase: ${room.room_phase}`,
        );
        console.log(
          `[SFU] Room ${roomName} creation - ROM metadata received:`,
          {
            romHash: storedExtra.romHash || storedExtra.rom_hash,
            rom_name: storedExtra.rom_name || storedExtra.romFilename,
            core_type: storedExtra.core_type || storedExtra.coreId,
            system: storedExtra.system,
            platform: storedExtra.platform,
          },
        );
      }

      // For room creation, ensure the host gets player slot 0
      if (!room.players.has(storedExtra.userid)) {
        storedExtra.player_slot = 0;
      }

      // Bind this socket to its claimed userid once, server-side.
      bindUseridToSocket(storedExtra.userid);

      // Add player to room (or update if already exists)
      // Initialize ready state for DELAY_SYNC rooms
      if (room.netplay_mode === "delay_sync") {
        storedExtra.ready = false;
      }
      room.players.set(storedExtra.userid, storedExtra);

      // Set as owner if room doesn't have one (HTTP-created rooms start with null owner)
      if (!room.owner) {
        room.owner = socket.id;
      }

      // Update room metadata from extra data
      if (storedExtra.room_phase !== undefined)
        room.room_phase = storedExtra.room_phase;
      if (storedExtra.sync_config !== undefined)
        room.sync_config = storedExtra.sync_config;
      if (storedExtra.spectator_mode !== undefined)
        room.spectator_mode = storedExtra.spectator_mode;
      if (storedExtra.rom_name !== undefined)
        room.rom_name = storedExtra.rom_name;
      if (storedExtra.romFilename !== undefined && !room.rom_name)
        room.rom_name = storedExtra.romFilename;
      if (storedExtra.system !== undefined) room.system = storedExtra.system;
      if (storedExtra.platform !== undefined)
        room.platform = storedExtra.platform;
      if (storedExtra.coreId !== undefined) room.coreId = storedExtra.coreId;
      if (storedExtra.coreVersion !== undefined)
        room.coreVersion = storedExtra.coreVersion;
      // Handle romHash/rom_hash (prefer romHash, fallback to rom_hash)
      if (storedExtra.romHash !== undefined) {
        room.romHash = storedExtra.romHash;
        room.rom_hash = storedExtra.romHash;
      } else if (storedExtra.rom_hash !== undefined) {
        room.rom_hash = storedExtra.rom_hash;
        room.romHash = storedExtra.rom_hash;
      }
      if (storedExtra.systemType !== undefined)
        room.systemType = storedExtra.systemType;
      // Handle core_type/coreId (prefer core_type, fallback to coreId)
      if (storedExtra.core_type !== undefined) {
        room.core_type = storedExtra.core_type;
        if (!room.coreId) room.coreId = storedExtra.core_type;
      } else if (storedExtra.coreId !== undefined && !room.core_type) {
        room.coreId = storedExtra.coreId;
        room.core_type = storedExtra.coreId;
      }

      // Room assignment: choose a worker using least-loaded strategy and
      // create a dedicated router for this room on that worker.
      await ensureRoomPrimaryAssigned(roomName);

      // Pin the owner socket to the room's primary worker.
      try {
        const peer = peers.get(socket.id);
        if (peer) {
          const st = getOrCreateRoomState(roomName);
          peer.roomName = roomName;
          peer.workerIdx = st.primaryWorkerIdx;
          peer.role = "owner";
          incrementRoomPeerCount(roomName, peer.workerIdx, 1);
        }
      } catch (e) {
        // ignore
      }
      if (ENABLE_ROOM_REGISTRY) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      socket.join(roomName);
      logger.debug(`room opened: ${roomName} by ${socket.id}`);
      const roomUsers = listRoomUsers(roomName);
      logger.debug("sending users-updated to room (open-room)", {
        roomName,
        netplay_mode: room.netplay_mode || "live_stream",
        room_phase: room.room_phase || "running",
        userCount: Object.keys(roomUsers).length,
        users: roomUsers,
      });
      io.to(roomName).emit("users-updated", roomUsers);

      // Debug: log room state before broadcasting
      const roomBeforeBroadcast = rooms.get(roomName);
      if (roomBeforeBroadcast) {
        console.log(
          `[SFU] Room ${roomName} state before broadcastRoomList():`,
          {
            netplay_mode: roomBeforeBroadcast.netplay_mode,
            rom_hash: roomBeforeBroadcast.rom_hash,
            rom_name: roomBeforeBroadcast.rom_name,
            core_type: roomBeforeBroadcast.core_type,
            coreId: roomBeforeBroadcast.coreId,
            system: roomBeforeBroadcast.system,
            platform: roomBeforeBroadcast.platform,
          },
        );
      }

      broadcastRoomList();
      cb && cb(null);
    } catch (err) {
      console.error("open-room error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("join-room", async (data, cb) => {
    console.log(`[SFU] join-room event received from ${socket.id}:`, {
      roomName: data?.extra?.room_name,
      playerName: data?.extra?.player_name,
      playerId: data?.extra?.userid,
    });

    try {
      const { extra, password = "" } = data || {};
      if (!extra || !extra.room_name) {
        console.log(
          "[SFU] join-room: invalid data, missing extra or room_name",
        );
        return cb && cb("invalid");
      }
      const roomName = extra.room_name;
      console.log(`[SFU] Processing join-room for ${roomName}`);

      let room = rooms.get(roomName);
      if (!room && ENABLE_ROOM_REGISTRY) {
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
        } else if (
          resolved &&
          resolved.url === PUBLIC_URL &&
          resolved.nodeId === NODE_ID
        ) {
          // Room exists in registry for this node but is missing from memory (e.g., after SFU restart).
          // Clean up the stale registry entry since the room no longer exists.
          logger.warn("Cleaning up stale room registry entry", {
            roomName,
            nodeId: resolved.nodeId,
          });
          await registryDeleteRoom(roomName).catch((e) => {
            logger.warn("Failed to clean up stale room registry", e);
          });
          return cb && cb("no such room");
        }
      }

      room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      if (room.password && room.password !== password)
        return cb && cb("bad password");
      const storedExtra = applyAuthToExtra(normalizeExtra(extra));

      // Validate ROM and core compatibility for player join (delay_sync only)
      const isSpectatorJoin = storedExtra.is_spectator || false;
      // Only perform ROM/core validation for delay_sync rooms, not live_stream
      if (
        !isSpectatorJoin &&
        room.netplay_mode === "delay_sync" &&
        room.rom_hash &&
        room.core_type
      ) {
        // Check if joining client has compatible ROM and core
        const clientRomHash = storedExtra.rom_hash;
        const clientCoreType = storedExtra.core_type;

        const romMatch = !clientRomHash || clientRomHash === room.rom_hash;
        const coreMatch = !clientCoreType || clientCoreType === room.core_type;

        if (!romMatch || !coreMatch) {
          // ROM/Core mismatch - check if spectators are allowed
          if (room.spectator_mode === 1) {
            // Spectators allowed - suggest joining as spectator
            return (
              cb &&
              cb({
                error: "incompatible_game",
                message: "ROM or emulator core doesn't match room requirements",
                canJoinAsSpectator: true,
                requiredRomHash: room.rom_hash,
                requiredCoreType: room.core_type,
              })
            );
          } else {
            // Spectators not allowed - reject join
            return (
              cb &&
              cb({
                error: "incompatible_game",
                message:
                  "ROM or emulator core doesn't match room requirements and spectators are not allowed",
                canJoinAsSpectator: false,
              })
            );
          }
        }
      }

      // Strict validation for delay sync rooms - requires exact ROM hash and coreId match
      if (room.netplay_mode === "delay_sync" && !isSpectatorJoin) {
        const validationErrors = [];

        // Critical requirements for delay sync: exact ROM hash match (REQUIRED)
        if (!room.rom_hash) {
          return (
            cb &&
            cb({
              error: "delay_sync_requirements_not_met",
              message:
                "Room host has not provided ROM hash. Delay sync requires exact ROM matching.",
              canJoinAsSpectator: false,
            })
          );
        }

        if (!storedExtra.rom_hash || storedExtra.rom_hash !== room.rom_hash) {
          return (
            cb &&
            cb({
              error: "delay_sync_requirements_not_met",
              message: `ROM hash mismatch: room requires '${room.rom_hash}', client has '${storedExtra.rom_hash || "none"}'. Delay sync requires exact ROM match.`,
              canJoinAsSpectator: false,
              compatibilityIssues: [
                `ROM hash: room requires '${room.rom_hash}', client has '${storedExtra.rom_hash || "none"}'`,
              ],
              requiredMetadata: {
                rom_hash: room.rom_hash,
                rom_name: room.rom_name,
                core_type: room.core_type,
              },
            })
          );
        }

        // Critical requirements for delay sync: exact coreId/core_type match (REQUIRED)
        if (!room.core_type) {
          return (
            cb &&
            cb({
              error: "delay_sync_requirements_not_met",
              message:
                "Room host has not provided emulator core type. Delay sync requires exact core matching.",
              canJoinAsSpectator: false,
            })
          );
        }

        if (
          !storedExtra.core_type ||
          storedExtra.core_type !== room.core_type
        ) {
          return (
            cb &&
            cb({
              error: "delay_sync_requirements_not_met",
              message: `Emulator core mismatch: room requires '${room.core_type}', client has '${storedExtra.core_type || "none"}'. Delay sync requires exact core match.`,
              canJoinAsSpectator: false,
              compatibilityIssues: [
                `Emulator core: room requires '${room.core_type}', client has '${storedExtra.core_type || "none"}'`,
              ],
              requiredMetadata: {
                rom_hash: room.rom_hash,
                rom_name: room.rom_name,
                core_type: room.core_type,
              },
            })
          );
        }

        // Additional compatibility checks (warnings, not blocking)
        if (
          storedExtra.system &&
          room.system &&
          storedExtra.system !== room.system
        ) {
          console.warn(
            `[SFU] System mismatch in delay sync room: room=${room.system}, client=${storedExtra.system}`,
          );
        }
      }

      // Bind this socket to its claimed userid once, server-side.
      bindUseridToSocket(storedExtra.userid);

      // Reconnect support: if a player rejoins with the same userid, treat it
      // as a reconnection and replace the stale socketId instead of rejecting
      // the room as "full".
      const isReconnect = room.players.has(storedExtra.userid);
      const existingExtra = isReconnect
        ? room.players.get(storedExtra.userid)
        : null;

      // Check room capacity for active players only (exclude spectators)
      const activePlayerCount = countActivePlayers(room);
      const isSpectator = isViewerExtra(storedExtra);
      if (
        !isReconnect &&
        !isSpectator &&
        activePlayerCount >= room.maxPlayers
      ) {
        return cb && cb("room full");
      }

      // Validate and assign player slot (only for active players, not spectators)
      if (!isSpectator && !isReconnect) {
        try {
          await room.mutex.runExclusive(async () => {
            const requestedSlot = storedExtra.player_slot || 0;
            const takenSlots = new Set();

            // Collect all taken slots from existing players
            for (const [playerId, playerExtra] of room.players) {
              if (
                !isViewerExtra(playerExtra) &&
                playerExtra.player_slot !== undefined
              ) {
                takenSlots.add(playerExtra.player_slot);
              }
            }

            // If requested slot is taken or invalid, find the next available slot
            let assignedSlot = requestedSlot;
            if (
              takenSlots.has(requestedSlot) ||
              requestedSlot < 0 ||
              (requestedSlot >= room.maxPlayers && requestedSlot !== 8)
            ) {
              // Find first available slot
              assignedSlot = 0;
              while (
                takenSlots.has(assignedSlot) &&
                assignedSlot < room.maxPlayers
              ) {
                assignedSlot++;
              }

              if (assignedSlot >= room.maxPlayers) {
                throw new Error("no available slots");
              }

              console.log(
                `[SFU] Reassigning player slot: ${requestedSlot} -> ${assignedSlot} for ${storedExtra.player_name}`,
              );
            }

            // Update the stored extra with the assigned slot
            storedExtra.player_slot = assignedSlot;
          });
        } catch (error) {
          return cb && cb(error.message || "slot assignment failed");
        }
      }
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

      // Assign this socket to a worker for this room.
      // Persistence: once assigned, the socket stays on that worker for all SFU operations.
      try {
        await ensureRoomPrimaryAssigned(roomName);
        const peer = peers.get(socket.id);
        if (peer) {
          peer.roomName = roomName;
          // Default: same worker as the room's primary router.
          let chosenWorkerIdx = getOrCreateRoomState(roomName).primaryWorkerIdx;

          // Fan-out: distribute viewers across workers once the room is large.
          const roomRec = rooms.get(roomName);
          const roomSize =
            roomRec && roomRec.players ? roomRec.players.size : 0;
          const viewer = isViewerExtra(storedExtra);
          if (
            SFU_FANOUT_ENABLED &&
            viewer &&
            workerPool.length > 1 &&
            roomSize >= SFU_FANOUT_VIEWER_THRESHOLD
          ) {
            // Ensure routers exist on additional workers as we need them.
            // Pick the worker with the fewest peers for this room.
            const st = getOrCreateRoomState(roomName);
            let bestIdx = chosenWorkerIdx;
            let bestPeers = st.peerCounts.get(bestIdx) || 0;
            for (let i = 0; i < workerPool.length; i++) {
              const c = st.peerCounts.get(i) || 0;
              if (c < bestPeers) {
                bestPeers = c;
                bestIdx = i;
              }
            }
            chosenWorkerIdx = bestIdx;
            await getOrCreateRoomRouter(roomName, chosenWorkerIdx);
          }

          peer.workerIdx = chosenWorkerIdx;
          peer.role = viewer ? "viewer" : "player";
          incrementRoomPeerCount(roomName, chosenWorkerIdx, 1);
          logger.info("assigned socket to room worker", {
            room: roomName,
            socket: socket.id,
            workerIdx: chosenWorkerIdx,
            role: peer.role,
          });
        }
      } catch (e) {
        logger.warn("failed to assign socket to room worker", {
          room: roomName,
          socket: socket.id,
          error: e && e.message ? e.message : String(e),
        });
      }

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
      const roomUsers = listRoomUsers(roomName);
      logger.debug("sending users-updated to room", {
        roomName,
        userCount: Object.keys(roomUsers).length,
        users: roomUsers,
      });
      io.to(roomName).emit("users-updated", roomUsers);
      if (ENABLE_ROOM_REGISTRY) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      logger.debug(`socket ${socket.id} joined room ${roomName}`);
      const response = {
        users: roomUsers,
        netplay_mode: room.netplay_mode || "live_stream",
        room_phase: room.room_phase || "running",
        game_id: room.game_id || null,
        sync_config: room.sync_config || null,
      };

      // Include lobby state for delay sync rooms
      if (room.lobby_state) {
        response.lobby_state = {
          phase: room.lobby_state.phase,
          player_ready: Object.fromEntries(room.lobby_state.player_ready),
        };
      }

      cb && cb(null, response);
    } catch (err) {
      console.error("join-room error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Request current room state (for clients that need to sync)
  socket.on("request-room-state", (data, cb) => {
    broadcastRoomList();
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Check if user is actually in this room
      if (!room.players.has(assignedUserid)) {
        return cb && cb("not in room");
      }

      const roomUsers = listRoomUsers(roomName);
      cb &&
        cb(null, {
          users: roomUsers,
          netplay_mode: room.netplay_mode || "live_stream",
          room_phase: room.room_phase || "running",
          game_id: room.game_id || null,
          sync_config: room.sync_config || null,
        });
    } catch (err) {
      console.error("request-room-state error", err);
      cb && cb(err.message || "error");
    }
  });

  // Request current room list (for clients connecting or refreshing)
  socket.on("request-room-list", (data, cb) => {
    console.log(`[SFU] request-room-list received from socket ${socket.id}`);
    console.log(`[SFU] Current rooms count: ${rooms.size}`);
    broadcastRoomList();
    if (cb) cb(null);
  });

  socket.on("leave-room", (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      // Update per-room worker accounting.
      try {
        const peer = peers.get(socket.id);
        if (
          peer &&
          peer.roomName === roomName &&
          typeof peer.workerIdx === "number"
        ) {
          incrementRoomPeerCount(roomName, peer.workerIdx, -1);
        }
        if (peer && peer.roomName === roomName) {
          peer.roomName = null;
          peer.workerIdx = undefined;
          peer.role = undefined;
        }
      } catch {
        // ignore
      }

      // Do not trust client-supplied userid here. Only the bound userid for this
      // network connection may leave.
      const assignedUserid = getAssignedUserid();
      let useridToRemove = assignedUserid;

      // Fallback for legacy clients that never joined/opened properly.
      if (!useridToRemove) {
        for (const [uid, extra] of room.players.entries()) {
          // Create a client-safe version of the extra data
          // Exclude server-only fields like player_name (uncensored netplayID)
          const clientExtra = { ...extra };
          delete clientExtra.player_name; // Server-side only - uncensored netplayID
          // Keep netplay_username for display (censored if needed)

          // Mark the room owner
          console.log(
            `[SFU] Checking player ${uid}, socketId: ${extra.socketId}, room.owner: ${room.owner}`,
          );
          if (extra.socketId === room.owner) {
            console.log(`[SFU] Setting is_host for player ${uid}`);
            clientExtra.is_host = true;
          }

          users[uid] = clientExtra;
        }
      }

      if (!useridToRemove) return cb && cb("not a member");

      room.players.delete(useridToRemove);
      socket.leave(roomName);
      socket.to(roomName).emit("room-player-left", { userid: useridToRemove });
      const roomUsers = listRoomUsers(roomName);
      logger.debug("sending users-updated to room (leave-room)", {
        roomName,
        userCount: Object.keys(roomUsers).length,
        users: roomUsers,
      });
      io.to(roomName).emit("users-updated", roomUsers);
      if (room.players.size === 0) {
        rooms.delete(roomName);
        locallyHostedRooms.delete(roomName);
        cleanupRoomMediasoup(roomName);
        if (ENABLE_ROOM_REGISTRY) {
          registryDeleteRoom(roomName).catch((e) => {
            logger.warn("failed to delete room registry", e);
          });
        }
        logger.debug(`room ${roomName} deleted (empty)`);
      } else if (ENABLE_ROOM_REGISTRY) {
        registryUpsertRoom(roomName).catch((e) => {
          logger.warn("failed to upsert room registry", e);
        });
      }
      cb && cb(null);
    } catch (err) {
      console.error("leave-room error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Lobby management for delay sync rooms
  socket.on("player-ready", (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room || !room.lobby_state) return cb && cb("not a delay sync room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      const playerExtra = room.players.get(assignedUserid);
      if (!playerExtra || isViewerExtra(playerExtra)) {
        return cb && cb("spectators cannot participate in lobby");
      }

      room.lobby_state.player_ready.set(assignedUserid, true);

      // Check if all active players are ready
      const activePlayers = Array.from(room.players.values()).filter(
        (p) => !isViewerExtra(p),
      );
      const allReady = activePlayers.every((p) =>
        room.lobby_state.player_ready.get(p.userid),
      );

      if (allReady && room.lobby_state.phase === "waiting") {
        room.lobby_state.phase = "ready";
      }

      // Broadcast lobby state update
      io.to(roomName).emit("lobby-state", {
        phase: room.lobby_state.phase,
        player_ready: Object.fromEntries(room.lobby_state.player_ready),
      });

      cb && cb(null);
    } catch (err) {
      console.error("player-ready error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("player-unready", (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room || !room.lobby_state) return cb && cb("not a delay sync room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      room.lobby_state.player_ready.set(assignedUserid, false);

      if (room.lobby_state.phase === "ready") {
        room.lobby_state.phase = "waiting";
      }

      // Broadcast lobby state update
      io.to(roomName).emit("lobby-state", {
        phase: room.lobby_state.phase,
        player_ready: Object.fromEntries(room.lobby_state.player_ready),
      });

      cb && cb(null);
    } catch (err) {
      console.error("player-unready error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("launch-game", (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room || !room.lobby_state) return cb && cb("not a delay sync room");

      // Only owner can launch
      if (room.owner !== socket.id) return cb && cb("not room owner");

      // Must be in ready state
      if (room.lobby_state.phase !== "ready")
        return cb && cb("not all players ready");

      room.lobby_state.phase = "launching";

      // Broadcast launch command
      io.to(roomName).emit("game-launch", {
        seed: Date.now(), // Simple seed based on timestamp
        delay: room.sync_config?.frameDelay || 2,
        start_frame: 1,
      });

      room.lobby_state.phase = "started";

      cb && cb(null);
    } catch (err) {
      console.error("launch-game error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Player slot updates for delay sync rooms
  socket.on("update-player-slot", async (data, cb) => {
    try {
      const { roomName, playerSlot } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Validate and update player's slot
      const playerExtra = room.players.get(assignedUserid);
      if (playerExtra) {
        try {
          await room.mutex.runExclusive(async () => {
            // Check if the requested slot is available (not taken by another active player)
            const isSpectator = isViewerExtra(playerExtra);
            if (!isSpectator && playerSlot !== playerExtra.player_slot) {
              // Check if slot is already taken by another player
              // Spectators (slot 8) don't conflict with each other
              let slotTaken = false;
              if (playerSlot !== 8) {
                for (const [otherPlayerId, otherExtra] of room.players) {
                  if (
                    otherPlayerId !== assignedUserid &&
                    !isViewerExtra(otherExtra) &&
                    otherExtra.player_slot === playerSlot
                  ) {
                    slotTaken = true;
                    break;
                  }
                }
              }

              if (playerSlot === playerExtra.player_slot) {
                throw new Error(`you already have slot ${playerSlot}`);
              }

              if (slotTaken) {
                throw new Error("slot taken");
              }

              // Validate slot range
              // Allow slot 8 for spectators, otherwise restrict to valid player slots
              if (
                playerSlot < 0 ||
                (playerSlot >= room.maxPlayers && playerSlot !== 8)
              ) {
                throw new Error("invalid slot");
              }
            }

            // Update the slot
            const oldSlot = playerExtra.player_slot;
            playerExtra.player_slot = playerSlot;

            console.log(
              `[SFU] Updated player slot: ${assignedUserid} from ${oldSlot} to ${playerSlot}`,
            );
          });

          // Broadcast slot update to all players in room
          console.log(
            `[SFU] Broadcasting player-slot-updated to room ${roomName}:`,
            {
              playerId: assignedUserid,
              playerSlot: playerSlot,
            },
          );
          io.to(roomName).emit("player-slot-updated", {
            playerId: assignedUserid,
            playerSlot: playerSlot,
          });
        } catch (error) {
          console.log(
            `[SFU] Slot update failed for ${assignedUserid}: ${error.message}`,
          );
          return cb && cb(error.message);
        }
      }

      cb && cb(null);
    } catch (err) {
      console.error("update-player-slot error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // DELAY_SYNC: Toggle ready state
  socket.on("toggle-ready", async (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Only allow in DELAY_SYNC rooms in lobby phase
      if (room.netplay_mode !== "delay_sync" || room.room_phase !== "lobby") {
        return cb && cb("not in delay sync lobby");
      }

      const playerExtra = room.players.get(assignedUserid);
      if (!playerExtra) return cb && cb("not in room");

      // Toggle ready state
      playerExtra.ready = !playerExtra.ready;

      console.log(
        `[SFU] Player ${assignedUserid} ready state: ${playerExtra.ready}`,
      );

      // Broadcast ready state update
      io.to(roomName).emit("player-ready-updated", {
        playerId: assignedUserid,
        ready: playerExtra.ready,
      });

      cb && cb(null);
    } catch (err) {
      console.error("toggle-ready error", err);
      cb && cb(err.message || "error");
    }
  });

  // DELAY_SYNC: Start game (host only)
  socket.on("start-game", async (data, cb) => {
    try {
      const { roomName } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Only allow in DELAY_SYNC rooms in lobby phase
      if (room.netplay_mode !== "delay_sync" || room.room_phase !== "lobby") {
        return cb && cb("not in delay sync lobby");
      }

      // Check if caller is host
      const playerExtra = room.players.get(assignedUserid);
      if (!playerExtra) return cb && cb("not in room");

      const isHost = assignedUserid === room.owner;
      if (!isHost) return cb && cb("not host");

      // Check if all players are ready
      let allReady = true;
      for (const [playerId, extra] of room.players) {
        if (!isViewerExtra(extra) && !extra.ready) {
          allReady = false;
          break;
        }
      }

      if (!allReady) {
        return cb && cb("not all players ready");
      }

      // Transition to PREPARE phase
      room.room_phase = "prepare";

      console.log(`[SFU] Starting DELAY_SYNC game in room ${roomName}`);

      // Broadcast prepare start
      io.to(roomName).emit("prepare-start", {
        startTime: Date.now() + 2000, // 2 seconds from now
        startFrame: 1,
      });

      cb && cb(null);
    } catch (err) {
      console.error("start-game error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // DELAY_SYNC: Join info with validation data
  socket.on("join-info", async (data, cb) => {
    try {
      const { roomName, romHash, emulatorId, emulatorVersion } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // In SFU server join-room handler
      if (storedExtra.netplay_mode !== undefined) {
        const clientMode =
          storedExtra.netplay_mode === 1 ? "delay_sync" : "live_stream";
        if (clientMode !== room.netplay_mode) {
          return (
            cb &&
            cb({
              error: "mode_mismatch",
              message: `Room is ${room.netplay_mode} but client expects ${clientMode}`,
            })
          );
        }
      }

      // Only validate for DELAY_SYNC rooms
      if (room.netplay_mode !== "delay_sync") {
        return cb && cb(null); // No validation needed for live stream
      }

      const playerExtra = room.players.get(assignedUserid);
      if (!playerExtra) return cb && cb("not in room");

      // Perform validation against room metadata
      let validationStatus = "ok";
      let validationReason = null;

      if (room.metadata && room.metadata.rom && room.metadata.rom.hash) {
        if (!romHash || romHash !== room.metadata.rom.hash.value) {
          validationStatus = "rom_mismatch";
          validationReason = `ROM mismatch: host is using ${room.metadata.rom.displayName || "Unknown ROM"}`;
        }
      }

      if (room.metadata && room.metadata.emulator) {
        if (emulatorId && emulatorId !== room.metadata.emulator.id) {
          validationStatus = "emulator_mismatch";
          validationReason = `Emulator mismatch: host is using ${room.metadata.emulator.displayName || room.metadata.emulator.id}`;
        }
        // Optional version check
        if (
          emulatorVersion &&
          room.metadata.emulator.coreVersion &&
          emulatorVersion !== room.metadata.emulator.coreVersion
        ) {
          validationStatus = "version_mismatch";
          validationReason = `Core version mismatch: host is using ${room.metadata.emulator.coreVersion}`;
        }
      }

      // Store validation status on player
      playerExtra.validationStatus = validationStatus;
      playerExtra.validationReason = validationReason;

      console.log(
        `[SFU] Player ${assignedUserid} validation: ${validationStatus}`,
        validationReason ? `(${validationReason})` : "",
      );

      // Broadcast validation status update
      io.to(roomName).emit("player-validation-updated", {
        playerId: assignedUserid,
        validationStatus: validationStatus,
        validationReason: validationReason,
      });

      cb && cb(null);
    } catch (err) {
      console.error("join-info error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Update room metadata
  socket.on("update-room-metadata", async (data, cb) => {
    try {
      // Define metadata object
      const { roomName, metadata } = data || {};
      // Get room from rooms map
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      if (metadata) {
        if (metadata.rom_name !== undefined) room.rom_name = metadata.rom_name;
        if (metadata.core_type !== undefined)
          room.core_type = metadata.core_type;
        if (metadata.system !== undefined) room.system = metadata.system;
        if (metadata.platform !== undefined) room.platform = metadata.platform;
        if (metadata.coreId !== undefined) room.coreId = metadata.coreId;
        if (metadata.coreVersion !== undefined)
          room.coreVersion = metadata.coreVersion;
        if (metadata.romHash !== undefined) {
          room.romHash = metadata.romHash;
          // Also set rom_hash for backward compatibility
          if (!room.rom_hash) room.rom_hash = metadata.romHash;
        }
        if (metadata.systemType !== undefined)
          room.systemType = metadata.systemType;
        if (metadata.netplay_mode !== undefined) {
          room.netplay_mode = metadata.netplay_mode;
        }
        // Ensure rom_hash is set if romHash exists
        if (room.romHash && !room.rom_hash) {
          room.rom_hash = room.romHash;
        }
        // Ensure core_type is set if coreId exists
        if (room.coreId && !room.core_type) {
          room.core_type = room.coreId;
        }
      }

      console.log(`[SFU] Updated room ${roomName} metadata:`, metadata);
      console.log(`[SFU] Room ${roomName} state after update:`, {
        netplay_mode: room.netplay_mode,
        rom_hash: room.rom_hash,
        rom_name: room.rom_name,
        core_type: room.core_type,
      });
    } catch (err) {
      console.error("update-room-metadata error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Update player metadata (emulator/core info)
  socket.on("update-player-metadata", async (data, cb) => {
    try {
      const { roomName, metadata } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Get and update player metadata
      const playerExtra = room.players.get(assignedUserid);
      if (playerExtra) {
        // Initialize metadata object if it doesn't exist
        if (!playerExtra.metadata) {
          playerExtra.metadata = {};
        }

        // Update metadata fields
        if (metadata) {
          Object.assign(playerExtra.metadata, metadata);
          // Handle netplay_mode separately (top-level player property)
          if (metadata.netplay_mode !== undefined) {
            playerExtra.netplay_mode = metadata.netplay_mode;
            // Remove from metadata object to avoid duplication
            const { netplay_mode, ...metadataWithoutNetplayMode } = metadata;
            Object.assign(playerExtra.metadata, metadataWithoutNetplayMode);
          } else {
            Object.assign(playerExtra.metadata, metadata);
          }
        }

        console.log(
          `[SFU] Updated player ${assignedUserid} metadata in room ${roomName}:`,
          metadata,
        );

        // Broadcast updated player list to all clients in the room
        const roomUsers = listRoomUsers(roomName);
        io.to(roomName).emit("users-updated", roomUsers);
      }

      cb && cb(null);
    } catch (err) {
      console.error("update-player-metadata error", err);
      cb && cb(err.message || "error");
    }
    broadcastRoomList();
  });

  // Deterministic preload sequence for delay sync rooms
  socket.on("ready-at-frame-1", (data, cb) => {
    try {
      const { roomName, frame } = data || {};
      const room = rooms.get(roomName);
      if (
        !room ||
        room.netplay_mode !== "delay_sync" ||
        room.room_phase !== "prepare"
      ) {
        return cb && cb("not in prepare phase");
      }

      const assignedUserid = getAssignedUserid();
      if (!assignedUserid) return cb && cb("not authenticated");

      // Track ready status for deterministic start
      if (!room.ready_at_frame_1) {
        room.ready_at_frame_1 = new Map();
      }
      room.ready_at_frame_1.set(assignedUserid, true);

      // Check if all active players are ready
      const activePlayers = Array.from(room.players.values()).filter(
        (p) => !isViewerExtra(p),
      );
      const allReady = activePlayers.every((p) =>
        room.ready_at_frame_1.get(p.userid),
      );

      if (allReady) {
        // All players ready - transition to running phase and send START signal
        room.room_phase = "running";
        const startTime = Date.now() + 2000; // Start in 2 seconds
        io.to(roomName).emit("start-game", {
          frame: frame,
          start_time: startTime,
        });
        console.log(
          `[SFU] All players ready at frame ${frame}, starting game at ${startTime}`,
        );
      }

      cb && cb(null);
    } catch (err) {
      console.error("ready-at-frame-1 error", err);
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
        const room = rooms.get(roomName);
        if (target === "host") {
          // Special case: "host" resolves to the room owner
          targetSocketId = room && room.owner;
        } else {
          // Fallback: treat target as a userid and resolve to socketId.
          const extra = room && room.players.get(target);
          const resolved = extra && (extra.socketId || extra.socket_id);
          if (resolved && io.sockets.sockets.get(resolved)) {
            targetSocketId = resolved;
          }
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
    async ({ producerId, transportId, rtpCapabilities, ignoreDtx }, cb) => {
      console.log(
        `[SFU] sfu-consume request from ${socket.id}: producerId=${producerId}, transportId=${transportId}`,
      );
      try {
        const roomName = getSocketRoomName();
        if (!roomName) throw new Error("no room");
        if (!rooms.has(roomName)) throw new Error("no such room");

        const peer = peers.get(socket.id);
        if (!peer) throw new Error("peer not found");

        const consumerWorkerIdx = getPeerAssignedWorkerIdx(socket.id, roomName);
        const consumerRouter = await getOrCreateRoomRouter(
          roomName,
          consumerWorkerIdx,
        );

        let effectiveProducerId = producerId;

        const canConsumeDirect = () => {
          try {
            return consumerRouter.canConsume({
              producerId: effectiveProducerId,
              rtpCapabilities,
            });
          } catch {
            return false;
          }
        };

        if (!canConsumeDirect()) {
          // If fan-out is enabled, the client may be requesting a source producerId
          // that lives on another worker. Try to map it to a piped producer on this worker.
          const st = getOrCreateRoomState(roomName);
          let sourceProducerId = producerId;
          let sourceWorkerIdx = null;

          const meta = producerMeta.get(producerId);
          if (meta && typeof meta.workerIdx === "number") {
            sourceWorkerIdx = meta.workerIdx;
          } else {
            const rec = st.producerPipes.get(producerId);
            if (rec && typeof rec.sourceWorkerIdx === "number") {
              sourceWorkerIdx = rec.sourceWorkerIdx;
            }
          }

          // If they passed a piped id already, attempt to find the source mapping.
          if (sourceWorkerIdx === null) {
            for (const [srcId, rec] of st.producerPipes.entries()) {
              if (!rec || !rec.perWorker) continue;
              for (const pipedId of rec.perWorker.values()) {
                if (pipedId === producerId) {
                  sourceProducerId = srcId;
                  sourceWorkerIdx = rec.sourceWorkerIdx;
                  break;
                }
              }
              if (sourceWorkerIdx !== null) break;
            }
          }

          if (
            SFU_FANOUT_ENABLED &&
            typeof sourceWorkerIdx === "number" &&
            consumerWorkerIdx !== sourceWorkerIdx
          ) {
            if (!st.producerPipes.has(sourceProducerId)) {
              st.producerPipes.set(sourceProducerId, {
                sourceWorkerIdx,
                perWorker: new Map([[sourceWorkerIdx, sourceProducerId]]),
              });
            }

            await getOrCreateRoomRouter(roomName, sourceWorkerIdx);
            await getOrCreateRoomRouter(roomName, consumerWorkerIdx);

            const pipedId = await ensurePipedProducerForWorker({
              roomName,
              sourceProducerId,
              targetWorkerIdx: consumerWorkerIdx,
            });
            if (pipedId) {
              effectiveProducerId = pipedId;
            }
          }
        }

        if (!canConsumeDirect()) {
          throw new Error("cannot consume");
        }

        const transportOwner = peer.transports.get(transportId);
        if (!transportOwner) throw new Error("transport not found");

        console.log(
          `[SFU] Attempting to consume producer ${effectiveProducerId} on transport ${transportId}`,
        );
        console.log(`[SFU] Consumer router instance:`, consumerRouter);
        console.log(
          `[SFU] Transport router:`,
          transportOwner.router ? "same router" : "different router",
        );

        // Check if producer exists on router
        try {
          const producers = consumerRouter.producers;
          console.log(`[SFU] Router has ${producers.size} producers`);
          const producerExists = Array.from(producers.keys()).includes(
            effectiveProducerId,
          );
          console.log(
            `[SFU] Producer ${effectiveProducerId} exists on router: ${producerExists}`,
          );
        } catch (e) {
          console.log(`[SFU] Error checking producers:`, e.message);
        }

        // Determine if this is an audio consumer to apply ignoreDtx
        // Check producer metadata or get producer from router to determine kind
        let isAudioConsumer = false;
        if (ignoreDtx !== undefined) {
          isAudioConsumer = ignoreDtx;
        } else {
          // Fallback: check producer metadata or producer object
          const meta = producerMeta.get(effectiveProducerId);
          if (meta && meta.kind === "audio") {
            isAudioConsumer = true;
          } else {
            // Try to get producer from router
            try {
              const producer =
                consumerRouter.producers.get(effectiveProducerId);
              if (producer && producer.kind === "audio") {
                isAudioConsumer = true;
              }
            } catch (e) {
              // Ignore errors, default to false
            }
          }
        }

        const consumer = await transportOwner.consume({
          producerId: effectiveProducerId,
          rtpCapabilities,
          paused: false,
          ignoreDtx: isAudioConsumer, // Ignore DTX for audio consumers to prevent sync drift
        });
        console.log(
          `[SFU] Successfully created consumer ${consumer.id} for producer ${effectiveProducerId}`,
        );

        peer.consumers.set(consumer.id, consumer);

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
        consumer.on("transportclose", () => peer.consumers.delete(consumer.id));

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
            },
          );
        } catch (e) {
          /* ignore */
        }

        cb && cb(null, params);
      } catch (err) {
        console.error("sfu-consume error", err);
        cb && cb(err.message);
      }
    },
  );

  socket.on("data-message", (data) => {
    const roomName = getSocketRoomName();
    if (roomName && rooms.has(roomName)) {
      logger.debug("broadcasting data-message to room", {
        fromSocket: socket.id,
        roomName,
        dataKeys: Object.keys(data || {}),
      });
      // Broadcast to all other sockets in the room
      socket.to(roomName).emit("data-message", data);
    } else {
      logger.warn("data-message received but no room found", {
        socket: socket.id,
        roomName,
        hasRoom: rooms.has(roomName || ""),
      });
    }
  });

  socket.on("chat-message", (data) => {
    const roomName = getSocketRoomName();
    if (roomName && rooms.has(roomName)) {
      const room = rooms.get(roomName);
      const peer = peers.get(socket.id);

      if (!peer || !peer.userid) {
        logger.warn("chat-message received but no peer/userid found", {
          socket: socket.id,
          roomName,
        });
        return;
      }

      // Extract player name from room data
      const playerData = room.players.get(peer.userid);
      const playerName = playerData?.player_name || peer.userid || "Unknown";

      // Validate message
      if (!data || !data.message || typeof data.message !== "string") {
        logger.warn("chat-message received with invalid data", {
          socket: socket.id,
          roomName,
          data,
        });
        return;
      }

      // Trim and limit message length
      const message = data.message.trim();
      if (message.length === 0 || message.length > 500) {
        logger.warn("chat-message rejected: empty or too long", {
          socket: socket.id,
          roomName,
          length: message.length,
        });
        return;
      }

      // Create chat message object
      const chatMessage = {
        userid: peer.userid,
        playerName: playerName,
        message: message,
        timestamp: Date.now(),
        messageId: `${peer.userid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      };

      // Store in room's chat history (limit to 100 messages)
      if (!room.chatHistory) {
        room.chatHistory = [];
      }
      room.chatHistory.push(chatMessage);
      if (room.chatHistory.length > 100) {
        room.chatHistory = room.chatHistory.slice(-100);
      }

      logger.debug("broadcasting chat-message to room", {
        fromSocket: socket.id,
        roomName,
        playerName,
        messageLength: message.length,
      });

      // Broadcast to all sockets in the room (including sender)
      io.to(roomName).emit("chat-message", chatMessage);
    } else {
      logger.warn("chat-message received but no room found", {
        socket: socket.id,
        roomName,
        hasRoom: rooms.has(roomName || ""),
      });
    }
  });

  socket.on("disconnect", (reason) => {
    logger.debug("client disconnected", socket.id, { reason });

    // Update per-room worker accounting for this peer.
    try {
      const peer = peers.get(socket.id);
      if (
        peer &&
        peer.roomName &&
        typeof peer.workerIdx === "number" &&
        rooms.has(peer.roomName)
      ) {
        incrementRoomPeerCount(peer.roomName, peer.workerIdx, -1);
      }
    } catch {
      // ignore
    }

    // Remove from any rooms and notify members.
    for (const [roomName, room] of rooms.entries()) {
      if (room.owner === socket.id) {
        rooms.delete(roomName);
        locallyHostedRooms.delete(roomName);
        cleanupRoomMediasoup(roomName);
        if (ENABLE_ROOM_REGISTRY) {
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
        const roomUsers = listRoomUsers(roomName);
        logger.debug("sending users-updated to room (disconnect)", {
          roomName,
          userCount: Object.keys(roomUsers).length,
          users: roomUsers,
        });
        io.to(roomName).emit("users-updated", roomUsers);
        if (room.players.size === 0) {
          rooms.delete(roomName);
          locallyHostedRooms.delete(roomName);
          cleanupRoomMediasoup(roomName);
          if (ENABLE_ROOM_REGISTRY) {
            registryDeleteRoom(roomName).catch((e) => {
              logger.warn("failed to delete room registry", e);
            });
          }
          logger.debug(`room ${roomName} deleted (empty)`);
        } else if (ENABLE_ROOM_REGISTRY) {
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

// Add helper function to broadcast room updates
function broadcastRoomList() {
  const now = Date.now();
  const roomList = Array.from(rooms.entries())
    .map(([roomName, room]) => {
      // Use countActivePlayers to exclude spectators (consistent with HTTP /list endpoint)
      const currentPlayers = countActivePlayers(room);
      const isEmpty = currentPlayers === 0;
      const ageMinutes = (now - (room.created_at || 0)) / (1000 * 60);
      
      // Filter out empty rooms that are older than grace period
      // Keep HTTP-created rooms for 30 seconds, WebSocket-created for 1 minute
      // This gives a brief grace period for reconnection but removes stale empty rooms quickly
      const keepMinutes = room.http_created ? 0.5 : 1; // 30 seconds for HTTP, 1 minute for WebSocket
      if (isEmpty && ageMinutes > keepMinutes) {
        return null; // Filter out old empty rooms
      }
      
      return {
        id: roomName, // Use roomName as id
        name: roomName, // Use roomName as name
        current: currentPlayers, // Use countActivePlayers instead of room.players.size
        max: room.maxPlayers,
        hasPassword: !!room.password,
        netplay_mode: room.netplay_mode || "live_stream",
        rom_hash: room.rom_hash || null,
        core_type: room.core_type || null,
        system: room.system || null,
        platform: room.platform || null,
        coreId: room.coreId || null,
        coreVersion: room.coreVersion || null,
        romHash: room.romHash || null,
        systemType: room.systemType || null,
        rom_name: room.rom_name || null,
      };
    })
    .filter((room) => room !== null); // Remove filtered-out rooms

  // Debug: log what we're broadcasting
  if (roomList.length > 0) {
    console.log("[SFU] Broadcasting room list update:", {
      roomCount: roomList.length,
      firstRoom: {
        id: roomList[0].id,
        netplay_mode: roomList[0].netplay_mode,
        rom_name: roomList[0].rom_name,
        rom_hash: roomList[0].rom_hash,
        core_type: roomList[0].core_type,
      },
    });
  }
  console.log(
    `[SFU] broadcastRoomList: Emitting rooms-updated to all clients with ${roomList.length} rooms`,
  );
  if (roomList.length > 0) {
    console.log(`[SFU] broadcastRoomList: First room in broadcast:`, {
      id: roomList[0].id,
      netplay_mode: roomList[0].netplay_mode,
      rom_name: roomList[0].rom_name,
      core_type: roomList[0].core_type,
    });
  }
  io.emit("rooms-updated", roomList); // Broadcast to ALL connected clients
  console.log(
    `[SFU] broadcastRoomList: rooms-updated event emitted via io.emit()`,
  );
}

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

    // Periodic cleanup of old empty rooms
    setInterval(() => {
      const now = Date.now();
      const toDelete = [];

      for (const [roomName, room] of rooms.entries()) {
        const currentPlayers = countActivePlayers(room);
        if (currentPlayers === 0) {
          const ageMinutes = (now - (room.created_at || 0)) / (1000 * 60);

          // Delete HTTP-created rooms after 2 minutes, WebSocket-created after 10 minutes
          const deleteMinutes = room.http_created ? 2 : 10;

          if (ageMinutes > deleteMinutes) {
            console.log(
              `[Cleanup] Deleting old empty room: ${roomName} (${ageMinutes.toFixed(1)} minutes old)`,
            );
            toDelete.push(roomName);
          }
        }
      }

      for (const roomName of toDelete) {
        cleanupRoomMediasoup(roomName);
        locallyHostedRooms.delete(roomName);
      }
    }, 60000); // Check every minute

    server.listen(PORT, "0.0.0.0", () =>
      logger.info(`SFU server listening on port ${PORT} (bound to 0.0.0.0)`),
    );
  })
  .catch((err) => {
    console.error("Failed to start mediasoup", err);
    process.exit(1);
  });
