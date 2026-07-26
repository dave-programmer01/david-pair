const REPO = process.env.BOT_REPO || "dave-programmer01/david-md";

/**
 * The deploy tutorial sent to the user right after their session ID.
 *
 * Every path shares the same first three steps — download, open one file,
 * paste — so the only thing that differs between hosts is how it's started.
 */
function deployMessage({ site } = {}) {
  const repoUrl = `https://github.com/${REPO}`;

  return `╭═══〘 *𝖣𝖺𝗏𝗂𝖽-𝗆𝖽* 〙═══⊷❍
┃◬│ *Your session ID is the message above.*
┃◬│ Long-press it → Copy.
╰═════════════════⊷

⚠️ *Keep it private*
That ID is a full login to this WhatsApp account. Anyone who has it can control your account. Don't post it, screenshot it, or put it in a public GitHub repo.

━━━━━━━━━━━━━━━━━━

*STEP 1 — Get the bot*

${repoUrl}

Click *Code → Download ZIP*, then unzip it.

*STEP 2 — Open \`config.js\`*

It's in the main folder. Near the top you'll see:

\`\`\`const SESSION_ID = "PASTE_YOUR_SESSION_ID_HERE";\`\`\`

Replace the text between the quotes with the ID you just copied:

\`\`\`const SESSION_ID = "David~eyJub2lzZ...";\`\`\`

Save the file. *That's the only edit you need.*

_Tip: the ID is a few thousand characters long. If you paste only part of it the bot will tell you so — copy the whole message._

*STEP 3 — Start it*

Pick whichever suits you 👇

━━━━━━━━━━━━━━━━━━

🖥️ *VPS / any Linux server*

\`\`\`npm install
npm start\`\`\`

To keep it running after you log out:

\`\`\`npm install -g pm2
pm2 start index.js --name david-md
pm2 save\`\`\`

━━━━━━━━━━━━━━━━━━

🐳 *Docker* — easiest, nothing to install

\`\`\`docker compose up -d\`\`\`

That's it. ffmpeg and yt-dlp are already inside the image.

Watch it start: \`docker compose logs -f\`

━━━━━━━━━━━━━━━━━━

🎮 *Pterodactyl panel*

1. Make a *Node.js* server
2. Upload the folder (with your edited config.js)
3. Startup command: \`node index.js\`
4. In the console: \`npm install\`
5. Press *Start*

━━━━━━━━━━━━━━━━━━

☁️ *Heroku*

Heroku deploys from GitHub, and your config.js holds a live login — so *don't fork* the repo. Forks of a public repo can never be made private.

1. Create a *new private repo* on GitHub
2. Push your edited folder to it
3. Heroku → *New → Create new app*
4. *Deploy → GitHub →* pick your private repo
5. *Resources →* switch the *worker* dyno on

Also add the *Heroku Postgres* add-on — Heroku wipes files daily, so without it your settings reset every day.

━━━━━━━━━━━━━━━━━━

*Once it's running*

Message yourself \`.menu\` to see all 162 commands.

Worth trying first:
\`.ping\` — check it's alive
\`.sticker\` — send a photo captioned .sticker
\`.setprefix !\` — use a different symbol
\`.mode public\` — let others use it

━━━━━━━━━━━━━━━━━━

*Something not working?*

_"NO SESSION ID FOUND"_ → config.js still has the placeholder text
_"SESSION ID LOOKS TOO SHORT"_ → the paste got cut off, copy the whole message again
_"LOGGED OUT"_ → unlink the device on your phone and generate a fresh ID${site ? ` at ${site}` : ""}

Full guide: ${repoUrl}#readme`;
}

module.exports = { deployMessage, REPO };
