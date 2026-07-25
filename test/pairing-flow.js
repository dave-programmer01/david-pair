/**
 * Drives the pairing state machine against a fake WhatsApp socket.
 *
 * The case that matters is 515 (restartRequired): WhatsApp closes the socket
 * *as part of* a successful link and expects the client to reconnect. An
 * earlier version treated that close as a failure, so every pair reported
 * "the connection dropped before pairing finished".
 */
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const real = Module.prototype.require;
const sockets = [];
const sent = [];

// Intercept the Baileys import inside src/pair.js.
Module.prototype.require = function (id) {
  if (id !== "@whiskeysockets/baileys") return real.apply(this, arguments);
  const actual = real.call(this, id);
  const fake = {
    ...actual,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    useMultiFileAuthState: async (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      return {
        state: { creds: {}, keys: {} },
        saveCreds: async () => {
          // Mimic Baileys writing creds once the link completes.
          fs.writeFileSync(
            path.join(dir, "creds.json"),
            JSON.stringify({ noiseKey: "x", me: { id: "15551234567:3@s.whatsapp.net", name: "Test" } })
          );
        },
      };
    },
    makeWASocket: () => {
      const sock = new EventEmitter();
      sock.ev = new EventEmitter();
      sock.ws = { close: () => {} };
      sock.user = { id: "15551234567:3@s.whatsapp.net", name: "Test" };
      sock.requestPairingCode = async () => "ABCD1234";
      sock.sendMessage = async (jid, content) => {
        sent.push({ jid, text: content.text });
        return { key: { id: "M" } };
      };
      sockets.push(sock);
      return sock;
    },
  };
  // pair.js imports it as `default: makeWASocket`, so both must be replaced.
  fake.default = fake.makeWASocket;
  return fake;
};

const { startPairing, getJob } = require("../src/pair");
const { DisconnectReason } = real.call(module, "@whiskeysockets/baileys");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 25_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(150);
  }
  return false;
};

let failures = 0;
const assert = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

(async () => {
  console.log("\n── Successful pair, with the 515 restart ──────────\n");

  const job = await startPairing("15551234567", { site: "https://example.com" });

  assert(await until(() => getJob(job.id).code), "pairing code issued", getJob(job.id).code);
  assert(getJob(job.id).state === "waiting", "state is waiting");
  assert(sockets.length === 1, "one socket so far");

  // WhatsApp accepts the code, writes creds, and closes with 515.
  await sockets[0].ev.emit("creds.update", {});
  sockets[0].ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
  });

  assert(await until(() => getJob(job.id).state === "linking"), "515 reported as 'linking', not a failure");
  assert(await until(() => sockets.length === 2), "reconnected with a second socket", `sockets=${sockets.length}`);
  assert(getJob(job.id).state !== "failed", "did NOT fail on the restart close");

  // The reconnected socket opens — this is where a real pair completes.
  sockets[1].ev.emit("connection.update", { connection: "open" });

  assert(await until(() => getJob(job.id).state === "sent"), "session delivered", getJob(job.id).state);
  assert(sent.length === 2, "two messages sent (id + tutorial)", `got ${sent.length}`);
  assert(sent[0]?.text?.startsWith("David~"), "first message is the bare session ID");
  assert(!sent[0]?.text?.includes("STEP"), "session ID message has nothing else in it");
  assert(sent[1]?.text?.includes("config.js"), "second message is the tutorial");
  assert(sent[0].jid === "15551234567@s.whatsapp.net", "sent to the user's own number, device suffix stripped");

  console.log("\n── Genuine rejection still fails ─────────────────\n");

  sockets.length = 0;
  const job2 = await startPairing("15559999999", { site: "https://example.com" });
  await until(() => getJob(job2.id).code);
  sockets[0].ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });
  assert(await until(() => getJob(job2.id).state === "failed"), "loggedOut fails immediately");
  assert(/rejected or cancelled/.test(getJob(job2.id).error || ""), "with a message about cancelling on the phone");
  assert(sockets.length === 1, "did not reconnect after a real rejection");

  console.log("\n── Endless flapping gives up ─────────────────────\n");

  sockets.length = 0;
  const job3 = await startPairing("15558888888", { site: "https://example.com" });
  await until(() => getJob(job3.id).code);
  for (let i = 0; i < 8; i++) {
    const s = sockets[sockets.length - 1];
    if (!s) break;
    s.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
    });
    await wait(1500);
  }
  assert(await until(() => getJob(job3.id).state === "failed"), "gives up after repeated drops");
  assert(sockets.length <= 6, "stopped at the attempt cap", `sockets=${sockets.length}`);

  // Nothing should be left behind in the temp dir.
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("pair-"));
  assert(leftovers.length === 0, "no temp credential directories left behind", `found ${leftovers.length}`);

  console.log(failures ? `\n❌ ${failures} assertion(s) failed\n` : "\n✅ all pairing-flow assertions passed\n");
  process.exit(failures ? 1 : 0);
})();
