const io = require("socket.io-client");

const SERVER = process.env.SFU_SERVER || "http://localhost:3001";

async function main() {
  console.log("Connecting to", SERVER);
  const socket = io(SERVER, { reconnection: false });

  socket.on("connect", async () => {
    console.log("connected, id=", socket.id);

    socket.emit("sfu-available", {}, (resp) => {
      console.log("sfu-available ->", resp);
    });

    socket.emit("sfu-get-router-rtp-capabilities", {}, (err, caps) => {
      if (err)
        return console.error("sfu-get-router-rtp-capabilities error", err);
      console.log("router rtpCapabilities keys:", Object.keys(caps || {}));

      // Request a recv transport (role=recv)
      socket.emit(
        "sfu-create-transport",
        { direction: "recv" },
        (err2, info) => {
          if (err2) return console.error("sfu-create-transport error", err2);
          console.log(
            "sfu-create-transport -> transport info id:",
            info && info.id
          );

          // We won't actually connect DTLS here; just finish the smoke test by asking for producers
          socket.emit("sfu-get-producers", {}, (err3, producers) => {
            if (err3) return console.error("sfu-get-producers error", err3);
            console.log("sfu-get-producers ->", producers);
            socket.close();
          });
        }
      );
    });
  });

  socket.on("connect_error", (err) => {
    console.error("connect_error", err);
    process.exit(1);
  });

  socket.on("disconnect", () => {
    console.log("disconnected");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("test client error", err);
  process.exit(1);
});
