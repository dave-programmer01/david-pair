const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { deployMessage } = require("./tutorial");

const logger = pino({ level: "silent" });

// A pairing attempt is abandoned if the code isn't used within this window.
const JOB_TTL = 5 * 60_000;
const jobs = new Map();

const publicView = (job) => ({
  id: job.id,
  state: job.state,
  code: job.code || null,
  error: job.error || null,
  sentTo: job.sentTo || null,
});

function reap() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL) {
      job.abort?.();
      jobs.delete(id);
    }
  }
}
setInterval(reap, 30_000).unref();

/**
 * Run one pairing attempt.
 *
 * Credential hygiene is the whole point of this file:
 *   • creds live in a per-request temp directory, never a shared one
 *   • the directory is removed in a finally block that also runs on timeout
 *     and on failure
 *   • the session ID is sent to the user and then dropped — nothing about it
 *     is logged or persisted here
 */
async function startPairing(phone, { site }) {
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(os.tmpdir(), `pair-${id}`);

  const job = {
    id,
    state: "starting",
    code: null,
    error: null,
    sentTo: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  (async () => {
    let sock = null;
    let settled = false;

    const cleanup = async () => {
      try {
        // ws.close() — NOT logout(). Logging out would invalidate the very
        // credentials we just issued, leaving the user with a dead session ID.
        sock?.ws?.close();
      } catch {}
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    const fail = async (message) => {
      if (settled) return;
      settled = true;
      job.state = "failed";
      job.error = message;
      await cleanup();
    };

    job.abort = () => void fail("Timed out — the code was never used.");

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      let credsWritten = false;
      sock.ev.on("creds.update", async () => {
        credsWritten = true;
        await saveCreds();
      });

      // Baileys needs a moment on the socket before it will issue a code.
      setTimeout(async () => {
        if (settled) return;
        try {
          const code = await sock.requestPairingCode(phone);
          job.code = String(code).match(/.{1,4}/g).join("-");
          job.state = "waiting";
        } catch (err) {
          await fail(`WhatsApp wouldn't issue a code: ${err.message}`);
        }
      }, 2500);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close" && !settled) {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut || code === 401) {
            await fail("The pairing was rejected or cancelled on the phone.");
          } else if (job.state === "waiting") {
            await fail("The connection dropped before pairing finished. Please try again.");
          }
          return;
        }

        if (connection !== "open" || settled) return;
        settled = true;
        job.state = "linked";

        try {
          // creds.json isn't on disk until the first creds.update lands, and
          // the account's own JID isn't stable for a moment after open.
          const deadline = Date.now() + 15_000;
          const credsPath = path.join(dir, "creds.json");
          while ((!credsWritten || !fs.existsSync(credsPath)) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
          }
          await new Promise((r) => setTimeout(r, 2500));

          if (!fs.existsSync(credsPath)) throw new Error("WhatsApp never sent the session data.");

          const raw = await fs.promises.readFile(credsPath);
          const sessionId = `David~${raw.toString("base64")}`;

          // sock.user.id carries a :device suffix that will not route.
          const me = jidNormalizedUser(sock.user.id);

          // Two messages on purpose: the ID alone is one long-press to copy,
          // with no surrounding text to accidentally select.
          await sock.sendMessage(me, { text: sessionId });
          await sock.sendMessage(me, { text: deployMessage({ site }) });

          job.state = "sent";
          job.sentTo = me.split("@")[0];
        } catch (err) {
          job.state = "failed";
          job.error = `Linked, but I couldn't send your session ID: ${err.message}`;
        } finally {
          await cleanup();
        }
      });
    } catch (err) {
      await fail(err.message);
    }
  })().catch(async (err) => {
    job.state = "failed";
    job.error = err.message;
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  return publicView(job);
}

const getJob = (id) => {
  const job = jobs.get(id);
  return job ? publicView(job) : null;
};

module.exports = { startPairing, getJob, jobs, JOB_TTL };
