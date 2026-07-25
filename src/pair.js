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
// Reconnects are expected (see below), but a socket that keeps flapping should
// give up rather than hold a slot for the full TTL.
const MAX_ATTEMPTS = 6;

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
 * The important subtlety is that WhatsApp *closes the socket* as part of a
 * successful pairing-code link: once the code is accepted it replies 515
 * (restartRequired), expecting the client to reconnect using the credentials
 * it just wrote. So a close is not necessarily a failure — on 515 the socket
 * is rebuilt against the same auth directory and the code is NOT re-requested,
 * because the credentials already carry the registration.
 *
 * Credential hygiene:
 *   • creds live in a per-request temp directory, never a shared one
 *   • the directory is removed in a finally that also runs on timeout/failure
 *   • the session ID is sent to the user and then dropped — never logged
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
    let attempt = 0;
    let codeRequested = false;
    let credsWritten = false;

    const cleanup = async () => {
      try {
        // ws.close() — NOT logout(). Logging out would invalidate the very
        // credentials just issued, leaving the user with a dead session ID.
        sock?.ws?.close();
      } catch {}
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    const fail = async (message, code) => {
      if (settled) return;
      settled = true;
      job.state = "failed";
      job.error = message;
      console.log(`[${id}] failed${code ? ` (${code})` : ""}: ${message}`);
      await cleanup();
    };

    job.abort = () => void fail("Timed out — the code was never used.");

    await fs.promises.mkdir(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const deliver = async () => {
      settled = true;
      job.state = "linked";
      console.log(`[${id}] linked, preparing session`);

      try {
        // creds.json isn't on disk until the first creds.update lands, and the
        // account JID isn't stable for a moment after open.
        const credsPath = path.join(dir, "creds.json");
        const deadline = Date.now() + 15_000;
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
        console.log(`[${id}] session delivered`);
      } catch (err) {
        job.state = "failed";
        job.error = `Linked, but I couldn't send your session ID: ${err.message}`;
        console.log(`[${id}] delivery failed: ${err.message}`);
      } finally {
        await cleanup();
      }
    };

    const connect = async () => {
      if (settled) return;
      attempt += 1;

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      sock.ev.on("creds.update", async () => {
        credsWritten = true;
        await saveCreds();
      });

      // Only ever request one code — on a reconnect the credentials already
      // carry the registration, and asking again would invalidate it.
      if (!codeRequested) {
        codeRequested = true;
        setTimeout(async () => {
          if (settled) return;
          try {
            const code = await sock.requestPairingCode(phone);
            job.code = String(code).match(/.{1,4}/g).join("-");
            job.state = "waiting";
            console.log(`[${id}] code issued`);
          } catch (err) {
            await fail(`WhatsApp wouldn't issue a code: ${err.message}`);
          }
        }, 2500);
      }

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (settled) return;

        if (connection === "open") return void (await deliver());
        if (connection !== "close") return;

        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${id}] closed (${code ?? "unknown"}) attempt ${attempt}`);

        // A real rejection — no amount of reconnecting will help.
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
          return void (await fail("The pairing was rejected or cancelled on the phone.", code));
        }
        if (code === DisconnectReason.multideviceMismatch) {
          return void (await fail(
            "This number needs multi-device enabled in WhatsApp before it can link.",
            code
          ));
        }

        // Everything else is transient. 515 in particular is the *expected*
        // close after a code is accepted — reconnecting is how pairing
        // completes, not a retry of a failure. It's also the first reliable
        // signal that the code worked, so surface it.
        if (code === DisconnectReason.restartRequired) job.state = "linking";

        if (attempt >= MAX_ATTEMPTS) {
          return void (await fail(
            "WhatsApp kept dropping the connection. Please try again in a minute.",
            code
          ));
        }

        try {
          sock.ev.removeAllListeners("connection.update");
          sock.ev.removeAllListeners("creds.update");
        } catch {}

        setTimeout(() => connect().catch((e) => fail(e.message)), 1200);
      });
    };

    await connect();
  })().catch(async (err) => {
    job.state = "failed";
    job.error = err.message;
    console.log(`[${id}] crashed: ${err.message}`);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  return publicView(job);
}

const getJob = (id) => {
  const job = jobs.get(id);
  return job ? publicView(job) : null;
};

module.exports = { startPairing, getJob, jobs, JOB_TTL };
