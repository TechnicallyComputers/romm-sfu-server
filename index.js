const fs = require("fs");
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

const app = express();
const cors = require("cors");
app.use(cors());

// Simple HTTP endpoint used by clients to list available rooms
app.get("/list", (req, res) => {
  try {
    const { domain, game_id } = req.query;
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
    res.status(500).json({ error: err.message || "error" });
  }
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Simple in-memory storage for transports/producers/consumers per socket
const peers = new Map(); // socketId -> { transports: Map, producers: Map }
const rooms = new Map(); // roomName -> { owner: socketId, players: Map(userid->extra), maxPlayers, password }

let worker;
let router;

async function runMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 20000,
    rtcMaxPort: 20200,
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

  socket.on("sfu-available", (data, cb) => {
    cb && cb({ available: !!router });
  });

  socket.on("sfu-get-router-rtp-capabilities", (data, cb) => {
    cb && cb(null, router.rtpCapabilities);
  });

  socket.on("sfu-create-transport", async ({ direction }, cb) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [
          {
            ip: "0.0.0.0",
            announcedIp: process.env.ANNOUNCED_IP || "192.168.66.3",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        iceServers: [
          {
            urls: "stun:turn.technicallycomputers.ca:3478",
            username: "emulatorjs",
            credential: "rCGKgDisoVJcdFRhltm3",
          },
          {
            urls: "turn:turn.technicallycomputers.ca:3478",
            username: "emulatorjs",
            credential: "rCGKgDisoVJcdFRhltm3",
          },
        ],
      });

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

        const dataProducer = await transport.produceData({
          sctpStreamParameters,
          label,
          protocol,
          appData,
        });

        peer.dataProducers.set(dataProducer.id, dataProducer);

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
    // (Old behavior returned *all* producers across all rooms.)
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
  socket.on("open-room", (data, cb) => {
    try {
      const { extra, maxPlayers = 4, password = "" } = data || {};
      if (!extra || !extra.room_name) return cb && cb("invalid");
      const roomName = extra.room_name;
      if (rooms.has(roomName)) return cb && cb("room exists");
      const players = new Map();
      const storedExtra = normalizeExtra(extra);
      players.set(storedExtra.userid, storedExtra);
      rooms.set(roomName, { owner: socket.id, players, maxPlayers, password });
      socket.join(roomName);
      logger.debug(`room opened: ${roomName} by ${socket.id}`);
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      cb && cb(null);
    } catch (err) {
      console.error("open-room error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("join-room", (data, cb) => {
    try {
      const { extra, password = "" } = data || {};
      if (!extra || !extra.room_name) return cb && cb("invalid");
      const roomName = extra.room_name;
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      if (room.password && room.password !== password)
        return cb && cb("bad password");
      const storedExtra = normalizeExtra(extra);

      // Reconnect support: if a player rejoins with the same userid, treat it
      // as a reconnection and replace the stale socketId instead of rejecting
      // the room as "full".
      const isReconnect = room.players.has(storedExtra.userid);
      if (!isReconnect && room.players.size >= room.maxPlayers)
        return cb && cb("full");

      room.players.set(storedExtra.userid, storedExtra);
      socket.join(roomName);

      // Notify other sockets in room of new player via socket.io event.
      // Avoid spamming "joined" messages when this is a reconnect.
      if (!isReconnect) {
        socket.to(roomName).emit("room-player-joined", storedExtra);
      }
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      logger.debug(`socket ${socket.id} joined room ${roomName}`);
      cb && cb(null, listRoomUsers(roomName));
    } catch (err) {
      console.error("join-room error", err);
      cb && cb(err.message || "error");
    }
  });

  socket.on("leave-room", (data, cb) => {
    try {
      const { roomName, userid } = data || {};
      const room = rooms.get(roomName);
      if (!room) return cb && cb("no such room");
      room.players.delete(userid);
      socket.leave(roomName);
      socket.to(roomName).emit("room-player-left", { userid });
      io.to(roomName).emit("users-updated", listRoomUsers(roomName));
      if (room.players.size === 0) {
        rooms.delete(roomName);
        logger.debug(`room ${roomName} deleted (empty)`);
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
          logger.debug(`room ${roomName} deleted (empty)`);
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

const PORT = process.env.PORT || 3001;

runMediasoup()
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
