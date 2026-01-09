const puppeteer = require("puppeteer");

(async () => {
  const ROOT = process.env.ROOT_URL || "http://localhost:8086";
  const PAGE = ROOT + "/index.html?debug=true";

  console.log("Launching headless browser to", PAGE);
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  page.on("console", (msg) => {
    console.log("PAGE:", msg.type(), msg.text());
  });
  page.on("pageerror", (err) => {
    console.error("PAGE ERROR:", err);
  });

  // Ensure the client uses our local SFU server
  await page.evaluateOnNewDocument(() => {
    window.EJS_netplayServer = "http://localhost:3001";
    window.EJS_netplayICEServers = [];
    window.EJS_DEBUG_XX = true;
  });

  await page.goto(PAGE, { waitUntil: "networkidle2", timeout: 60000 });
  console.log("Page loaded, waiting for Emulator to initialize...");

  // Poll for the emulator to initialize (more robust than waitForFunction)
  console.log("Polling for window.EJS_emulator...");
  const start = Date.now();
  let found = false;
  while (Date.now() - start < 120000) {
    try {
      found = await page.evaluate(() => {
        try {
          return !!(window.EJS_emulator && window.EJS_emulator.netplay);
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      console.error("evaluate error", e);
    }
    if (found) break;
    console.log("Still waiting for emulator...");
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!found) {
    console.error(
      "Emulator not detected within timeout — dumping some diagnostics:"
    );
    const keys = await page.evaluate(() => Object.keys(window).slice(0, 200));
    console.error("window keys:", keys.join(", "));
    const loaderScript = await page.evaluate(
      () => !!document.querySelector('script[src*="loader.js"]')
    );
    console.error("loader.js present in DOM:", loaderScript);
    const socketIo = await page.evaluate(() => !!window.io);
    console.error("socket.io client present (window.io):", socketIo);
    throw new Error("Emulator failed to initialize in headless session");
  }

  console.log("Emulator present, opening room as owner...");

  await page.evaluate(() => {
    try {
      window.EJS_emulator.netplay.name = "HeadlessOwner";
      window.EJS_emulator.netplay.openRoom("headless-room", 4, "");
      console.log("Requested openRoom");
    } catch (e) {
      console.error("openRoom failed", e);
    }
  });

  // Allow time for mediasoup-client to load and for producer to be created
  await page.waitForTimeout(8000);
  console.log("Done — closing browser.");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("puppeteer-owner error", err);
  process.exit(1);
});
