// ZINERK-XMD - WhatsApp bot (Baileys) with PAIRING CODE login (no QR)
// Works in Termux, no root needed.
// Extra dependency: jimp  ->  npm i @whiskeysockets/baileys pino jimp
import http from "http";

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Running");
}).listen(PORT, "0.0.0.0");

// Code above was added to run an open port for Web service for the Render
//to know the bot is Alive
import makeWASocket, {
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Jimp } from "jimp";
import pino from "pino";
import readline from "readline";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";

/* ════════════════════════════════════════════
   1. CONFIG + SAVED SETTINGS
   ════════════════════════════════════════════ */

const CONFIG = {
    botName: "ZINERK-XMD",
    ownerName: "└──▓ RUST ▓🧘──┘",
    extraOwners: [], // extra owner numbers, e.g. ["2547XXXXXXXX"]
    settingsFile: "settings.json",
    menuImage: "menu.jpg",
    secretCommand: "zkey", // HIDDEN command name (not in menu/help). Rename it to anything
    debug: true, // prints incoming messages in the terminal (set false once all works)
    maxSessions: 5, // how many other people can link their own number
};

const defaults = {
    prefix: ".",
    mode: "public", // public = everyone, self = only owner
    menuStyle: "neo", // neo | minimal
    autoView: true, // auto view statuses
    autoReact: true, // auto react to statuses
    reactEmojis: ["❤️", "🔥", "😂", "👏", "💯", "🎃"],
    autoRead: false,
    autoTyping: false,
    antiCall: false,
    antiLink: {}, // groupJid -> "on" | "wa"
    welcome: {}, // groupJid -> true
    warns: {}, // "groupJid|number" -> count
    sudo: [], // numbers with owner-level power (added by the secret command)
    users: [], // numbers allowed to use the bot in private mode
};

function loadSettings(file, base = {}) {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    return { ...structuredClone(defaults), ...base, ...saved };
}

// Every linked session (yours + people who paired their number) has its OWN
// settings. AsyncLocalStorage remembers which session is handling the current
// message, so the rest of the code keeps using plain `settings.xxx` and `save()`.
const als = new AsyncLocalStorage();
const mainStore = {
    id: "main",
    main: true,
    dir: ".",
    settingsFile: CONFIG.settingsFile,
    settings: loadSettings(CONFIG.settingsFile),
    retry: 0,
    dropped: false,
};
const store = () => als.getStore() || mainStore;
const settings = new Proxy({}, {
    get: (_, k) => store().settings[k],
    set: (_, k, v) => {
        store().settings[k] = v;
        return true;
    },
});
const save = () =>
    fs.writeFileSync(
        store().settingsFile,
        JSON.stringify(store().settings, null, 2),
    );
const menuPath = () =>
    store().main ? CONFIG.menuImage : path.join(store().dir, "menu.jpg");

const logger = pino({ level: "silent" });

/* ════════════════════════════════════════════
   2. SMALL HELPERS
   ════════════════════════════════════════════ */

// ask a question in the terminal
const ask = (q) =>
    new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(q, (a) => {
            rl.close();
            resolve(a);
        });
    });

// time + day in West Virginia (Eastern Time)
function wvTime() {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const day = now.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
    });
    return { time, day };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const num = (j) => (j || "").split("@")[0].split(":")[0];
const bar = (p) =>
    "█".repeat(Math.round(p / 10)) + "░".repeat(10 - Math.round(p / 10));
const tick = (b) => (b ? "✅ ON" : "❌ OFF");
const onOff = (v) =>
    /^(on|enable|true|1)$/i.test(v || "")
        ? true
        : /^(off|disable|false|0)$/i.test(v || "")
        ? false
        : null;
const mb = (b) => (b / 1048576).toFixed(0) + " MB";
const hashNum = (s) =>
    parseInt(crypto.createHash("md5").update(s).digest("hex").slice(0, 6), 16) %
    101;

function fmtUptime(sec) {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d ? d + "d " : ""}${h ? h + "h " : ""}${m}m ${sec % 60}s`;
}

async function getJSON(url, headers = {}) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
}
async function getText(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
}

// WhatsApp wraps some messages (disappearing, view-once...) - unwrap them
const unwrap = (m) =>
    m?.ephemeralMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.documentWithCaptionMessage?.message ||
    m;
// contextInfo holds mentions + the message being replied to
const ctxInfo = (m) =>
    Object.values(m || {})
        .map((v) => v?.contextInfo)
        .find(Boolean);

// group admin checks (tolerant to different id formats)
const idsOf = (p) =>
    [p.id, p.phoneNumber, p.lid, p.jid].filter(Boolean).map(num);
const isAdminIn = (meta, jid) =>
    !!meta?.participants?.find((p) => p.admin && idsOf(p).includes(num(jid)));

const metaCache = new Map();
async function getMeta(sock, jid) {
    const key = sock._sid + "|" + jid;
    const hit = metaCache.get(key);
    if (hit && Date.now() - hit.t < 30000) return hit.m;
    const m = await sock.groupMetadata(jid);
    metaCache.set(key, { m, t: Date.now() });
    return m;
}

// get an image buffer from the message itself or the message it replies to
async function getImageBuffer(sock, msg) {
    const opts = { logger, reuploadRequest: sock.updateMediaMessage };
    const m = unwrap(msg.message);
    if (m?.imageMessage) return downloadMediaMessage(msg, "buffer", {}, opts);
    const ci = ctxInfo(msg.message);
    const q = unwrap(ci?.quotedMessage);
    if (q?.imageMessage) {
        const fake = {
            key: {
                remoteJid: msg.key.remoteJid,
                id: ci.stanzaId,
                participant: ci.participant,
            },
            message: ci.quotedMessage,
        };
        return downloadMediaMessage(fake, "buffer", {}, opts);
    }
    return null;
}

// Jimp: make ANY size image a 640x640 profile picture.
// crop=false -> whole image kept, blurred background fills the empty space
// crop=true  -> classic center crop
async function makeSquare(buf, crop = false) {
    const size = 640;
    const img = await Jimp.read(buf);
    if (crop) {
        img.cover({ w: size, h: size });
        return img.getBuffer("image/jpeg", { quality: 92 });
    }
    const bg = img.clone().cover({ w: size, h: size }).blur(20);
    const fg = img.clone().scaleToFit({ w: size, h: size });
    bg.composite(
        fg,
        Math.round((size - fg.bitmap.width) / 2),
        Math.round((size - fg.bitmap.height) / 2),
    );
    return bg.getBuffer("image/jpeg", { quality: 92 });
}

/* ════════════════════════════════════════════
   3. COMMAND REGISTRY
   cmd({ name, alias, cat, desc, usage, owner, group, admin, botAdmin, run })
   ════════════════════════════════════════════ */

const list = [];
const commands = new Map();
function cmd(def) {
    if (!def.hidden) list.push(def);
    commands.set(def.name, def);
    for (const a of def.alias || []) commands.set(a, def);
}

const CATS = {
    core: ["✨", "CORE"],
    group: ["👥", "GROUP"],
    owner: ["👑", "OWNER"],
    tools: ["🛠️", "TOOLS"],
    fun: ["🎲", "FUN"],
};

/* ════════════════════════════════════════════
   4. THE MENU / HELP UI
   ════════════════════════════════════════════ */

function buildMenu(only) {
    const { time, day } = wvTime();
    const p = settings.prefix;
    const cats = Object.keys(CATS).filter((c) => !only || c === only);
    let out = "";

    if (settings.menuStyle === "minimal") {
        out += `*${CONFIG.botName}*  ·  ${CONFIG.ownerName}\n`;
        out += `prefix [ ${p} ] · ${list.length} cmds · ${settings.mode}\n\n`;
        for (const c of cats) {
            const names = list
                .filter((x) => x.cat === c)
                .map((x) => p + x.name)
                .join("  ");
            out += `${CATS[c][0]} *${CATS[c][1]}*\n${names}\n\n`;
        }
    } else {
        out += `╔═══《 ✦ *${CONFIG.botName}* ✦ 》═══╗\n`;
        out += `┏━━━━━━━━━━━━━━━━━━━\n`;
        out += `┃ 👑 Owner   : ${CONFIG.ownerName}\n`;
        out += `┃ 🌐 Mode    : ${settings.mode}\n`;
        out += `┃ 🔰 Prefix  : [ ${p} ]\n`;
        out += `┃ 📦 Commands: ${list.length}\n`;
        out += `┃ ⏳ Uptime  : ${fmtUptime(process.uptime())}\n`;
        out += `┃ 💾 RAM     : ${mb(process.memoryUsage().rss)} / ${
            mb(os.totalmem())
        }\n`;
        out += `┃ 🕒 Time    : ${time} · ${day}\n`;
        out += `┗━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const c of cats) {
            out += `╭─「 ${CATS[c][0]} *${CATS[c][1]}* 」\n`;
            for (const x of list.filter((x) => x.cat === c)) {
                out += `│ ⌬ ${p}${x.name}\n`;
            }
            out += `╰───────────\n\n`;
        }
    }
    out += `_Details: ${p}help <command>  ·  Category: ${p}menu <${
        Object.keys(CATS).join("|")
    }>_\n`;
    out += `> ⚡ ${CONFIG.botName} · built by ${CONFIG.ownerName}`;
    return out;
}

/* ════════════════════════════════════════════
   5. COMMANDS
   ctx = { sock, msg, jid, isGroup, sender, args, text, isOwner,
           meta, isBotAdmin, botJid, reply, target }
   ════════════════════════════════════════════ */

// ───────── CORE ─────────
cmd({
    name: "menu",
    alias: ["m", "commands"],
    cat: "core",
    desc: "Show the full command menu",
    usage: "[category]",
    run: async (c) => {
        const only = c.args[0]?.toLowerCase();
        const caption = buildMenu(CATS[only] ? only : null);
        if (fs.existsSync(menuPath())) {
            await c.sock.sendMessage(
                c.jid,
                { image: fs.readFileSync(menuPath()), caption },
                { quoted: c.msg },
            );
        } else await c.reply(caption);
    },
});

cmd({
    name: "help",
    alias: ["h"],
    cat: "core",
    desc: "Details about one command",
    usage: "<command>",
    run: async (c) => {
        const p = settings.prefix;
        const name = c.args[0]?.toLowerCase().replace(p, "");
        const x = name && commands.get(name);
        if (!x || x.hidden) {
            return c.reply(
                `❓ *HELP*\nUse *${p}help <command>* for details.\nSee all commands with *${p}menu*.\n\nSpecial trigger: *.xml* (works anywhere, no prefix).`,
            );
        }
        const perms = [
            x.owner && "👑 owner only",
            x.admin && "🛡️ group admins",
            x.group && "👥 groups only",
            x.botAdmin && "🤖 bot must be admin",
        ].filter(Boolean);
        await c.reply(
            `┏━━ 📖 *${p}${x.name}* ━━\n` +
                `┃ ${x.desc}\n` +
                `┃ 🧩 Usage: ${p}${x.name} ${x.usage || ""}\n` +
                `┃ 🔁 Alias: ${
                    (x.alias || []).map((a) => p + a).join(" ") || "-"
                }\n` +
                `┃ 🔒 Access: ${perms.join(", ") || "everyone"}\n` +
                `┗━━━━━━━━━━`,
        );
    },
});

cmd({
    name: "ping",
    alias: ["p"],
    cat: "core",
    desc: "Real round-trip speed in ms",
    run: async (c) => {
        const t0 = Date.now();
        const sent = await c.sock.sendMessage(
            c.jid,
            { text: "🏓 Pinging..." },
            { quoted: c.msg },
        );
        const rtt = Date.now() - t0;
        await c.sock.sendMessage(c.jid, {
            text: `🏓 *Pong!*\n⚡ Speed: *${rtt} ms*`,
            edit: sent.key,
        });
    },
});

cmd({
    name: "alive",
    alias: ["a"],
    cat: "core",
    desc: "Check that the bot is online",
    run: async (c) => {
        const { time, day } = wvTime();
        await c.reply(
            `┏━━━━━━━━━━━\n*${CONFIG.botName}* ALIVE ✅\n⏳ Uptime: ${
                fmtUptime(process.uptime())
            }\n🕒 ${time} · ${day}\n🌐 Mode: ${settings.mode}\n┗━━━━━━━━━━━`,
        );
    },
});

cmd({
    name: "runtime",
    alias: ["uptime"],
    cat: "core",
    desc: "How long the bot has been running",
    run: async (c) => c.reply(`⏳ Uptime: *${fmtUptime(process.uptime())}*`),
});

cmd({
    name: "owner",
    cat: "core",
    desc: "Show the bot owner",
    run: async (c) =>
        c.reply(
            `👑 *OWNER*\n${CONFIG.ownerName}\n📞 wa.me/${num(c.botJid)}`,
        ),
});

cmd({
    name: "botinfo",
    alias: ["info"],
    cat: "core",
    desc: "System info of the bot",
    run: async (c) =>
        c.reply(
            `┏━━ 🤖 *BOT INFO* ━━\n┃ Name: ${CONFIG.botName}\n┃ Commands: ${list.length}\n┃ Prefix: ${settings.prefix}\n┃ Mode: ${settings.mode}\n┃ Node: ${process.version}\n┃ OS: ${os.platform()} ${os.arch()}\n┃ CPU cores: ${os.cpus().length}\n┃ RAM: ${
                mb(process.memoryUsage().rss)
            } / ${mb(os.totalmem())}\n┗━━━━━━━━━━`,
        ),
});

// ───────── GROUP ─────────
cmd({
    name: "tagall",
    cat: "group",
    admin: true,
    group: true,
    desc: "Mention every member",
    usage: "[message]",
    run: async (c) => {
        const ids = c.meta.participants.map((p) => p.id);
        const body = `📣 *TAG ALL*\n💬 ${c.text || "Attention everyone!"}\n\n` +
            ids.map((i) => `⌬ @${num(i)}`).join("\n");
        await c.reply(body, ids);
    },
});

cmd({
    name: "hidetag",
    alias: ["ht"],
    cat: "group",
    admin: true,
    group: true,
    desc: "Mention everyone silently (no list shown)",
    usage: "<message>",
    run: async (c) => {
        const ids = c.meta.participants.map((p) => p.id);
        await c.sock.sendMessage(c.jid, {
            text: c.text || "📢",
            mentions: ids,
        });
    },
});

cmd({
    name: "tagadmins",
    cat: "group",
    group: true,
    desc: "Mention all admins",
    usage: "[message]",
    run: async (c) => {
        const ids = c.meta.participants.filter((p) => p.admin).map((p) => p.id);
        await c.reply(
            `🛡️ *ADMINS*\n💬 ${c.text || "Calling admins"}\n\n` +
                ids.map((i) => `⌬ @${num(i)}`).join("\n"),
            ids,
        );
    },
});

for (
    const [name, action, emoji] of [
        ["promote", "promote", "⬆️"],
        ["demote", "demote", "⬇️"],
        ["kick", "remove", "🚪"],
    ]
) {
    cmd({
        name,
        alias: name === "kick" ? ["remove"] : [],
        cat: "group",
        admin: true,
        group: true,
        botAdmin: true,
        desc: `${
            name[0].toUpperCase() + name.slice(1)
        } a member (mention or reply)`,
        usage: "@user",
        run: async (c) => {
            const t = c.target();
            if (!t) return c.reply(`Mention or reply to someone.`);
            if (num(t) === num(c.botJid)) return c.reply("😅 Not me!");
            await c.sock.groupParticipantsUpdate(c.jid, [t], action);
            await c.reply(`${emoji} Done: @${num(t)}`, [t]);
        },
    });
}

cmd({
    name: "add",
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Add a number to the group",
    usage: "<number with country code>",
    run: async (c) => {
        const n = c.args[0]?.replace(/[^0-9]/g, "");
        if (!n || n.length < 7) {
            return c.reply("Give a number, e.g. 2547XXXXXXXX");
        }
        await c.sock.groupParticipantsUpdate(
            c.jid,
            [n + "@s.whatsapp.net"],
            "add",
        );
        await c.reply(`➕ Tried to add *${n}*`);
    },
});

cmd({
    name: "mute",
    alias: ["close"],
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Only admins can send messages",
    run: async (c) => {
        await c.sock.groupSettingUpdate(c.jid, "announcement");
        await c.reply("🔇 Group closed. Only admins can chat.");
    },
});

cmd({
    name: "unmute",
    alias: ["open"],
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Everyone can send messages",
    run: async (c) => {
        await c.sock.groupSettingUpdate(c.jid, "not_announcement");
        await c.reply("🔊 Group opened. Everyone can chat.");
    },
});

cmd({
    name: "groupinfo",
    alias: ["gi"],
    cat: "group",
    group: true,
    desc: "Show info about this group",
    run: async (c) => {
        const m = c.meta;
        const admins = m.participants.filter((p) => p.admin).length;
        const made = m.creation
            ? new Date(m.creation * 1000).toDateString()
            : "unknown";
        await c.reply(
            `┏━━ 👥 *GROUP INFO* ━━\n┃ 📛 ${m.subject}\n┃ 👤 Members: ${m.participants.length}\n┃ 🛡️ Admins: ${admins}\n┃ 📅 Created: ${made}\n┃ 📝 ${
                m.desc || "No description"
            }\n┗━━━━━━━━━━`,
        );
    },
});

cmd({
    name: "invite",
    alias: ["grouplink"],
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Get the group invite link",
    run: async (c) => {
        const code = await c.sock.groupInviteCode(c.jid);
        await c.reply(`🔗 https://chat.whatsapp.com/${code}`);
    },
});

cmd({
    name: "resetlink",
    alias: ["revoke"],
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Reset the group invite link",
    run: async (c) => {
        await c.sock.groupRevokeInvite(c.jid);
        await c.reply("♻️ Invite link has been reset.");
    },
});

cmd({
    name: "setsubject",
    alias: ["setname"],
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Change the group name",
    usage: "<new name>",
    run: async (c) => {
        if (!c.text) return c.reply("Give the new name.");
        await c.sock.groupUpdateSubject(c.jid, c.text);
        await c.reply("✅ Group name updated.");
    },
});

cmd({
    name: "setdesc",
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc: "Change the group description",
    usage: "<text>",
    run: async (c) => {
        if (!c.text) return c.reply("Give the new description.");
        await c.sock.groupUpdateDescription(c.jid, c.text);
        await c.reply("✅ Description updated.");
    },
});

cmd({
    name: "setgpp",
    cat: "group",
    admin: true,
    group: true,
    botAdmin: true,
    desc:
        "Set group picture from any size image (reply to an image or send with caption)",
    usage: "[crop]",
    run: async (c) => {
        const buf = await getImageBuffer(c.sock, c.msg);
        if (!buf) {
            return c.reply(
                "📸 Reply to an image (or send one with the caption).",
            );
        }
        const out = await makeSquare(buf, c.args[0] === "crop");
        await c.sock.updateProfilePicture(c.jid, out);
        await c.reply("✅ Group picture updated.");
    },
});

cmd({
    name: "listadmins",
    cat: "group",
    group: true,
    desc: "List the group admins",
    run: async (c) => {
        const ids = c.meta.participants.filter((p) => p.admin).map((p) => p.id);
        await c.reply(
            `🛡️ *ADMINS (${ids.length})*\n` +
                ids.map((i) => `• @${num(i)}`).join("\n"),
            ids,
        );
    },
});

cmd({
    name: "antilink",
    cat: "group",
    admin: true,
    group: true,
    desc:
        "Delete links + warn (3 warns = kick). on = all links, wa = only WhatsApp invites",
    usage: "<on|wa|off>",
    run: async (c) => {
        const v = c.args[0]?.toLowerCase();
        if (v === "on" || v === "wa") settings.antiLink[c.jid] = v;
        else if (v === "off") delete settings.antiLink[c.jid];
        else {
            return c.reply(
                `🔗 Anti-link: *${
                    settings.antiLink[c.jid] || "off"
                }*\nUse: ${settings.prefix}antilink on | wa | off`,
            );
        }
        save();
        await c.reply(
            `🔗 Anti-link is now *${v}*.\n⚠️ I must be admin to delete messages.`,
        );
    },
});

cmd({
    name: "welcome",
    cat: "group",
    admin: true,
    group: true,
    desc: "Welcome / goodbye messages",
    usage: "<on|off>",
    run: async (c) => {
        const v = onOff(c.args[0]);
        if (v === null) {
            return c.reply(
                `Welcome: ${
                    tick(settings.welcome[c.jid])
                }\nUse: welcome on | off`,
            );
        }
        if (v) settings.welcome[c.jid] = true;
        else delete settings.welcome[c.jid];
        save();
        await c.reply(`👋 Welcome messages: ${tick(v)}`);
    },
});

cmd({
    name: "warn",
    cat: "group",
    admin: true,
    group: true,
    desc: "Warn a member (3 warns = kick if I am admin)",
    usage: "@user",
    run: async (c) => {
        const t = c.target();
        if (!t) return c.reply("Mention or reply to someone.");
        await warnUser(
            c.sock,
            c.jid,
            t,
            c.isBotAdmin,
            "Manual warning by admin",
        );
    },
});

cmd({
    name: "warns",
    cat: "group",
    group: true,
    desc: "Check a member's warnings",
    usage: "[@user]",
    run: async (c) => {
        const t = c.target() || c.sender;
        const n = settings.warns[`${c.jid}|${num(t)}`] || 0;
        await c.reply(`⚠️ @${num(t)} has *${n}/3* warnings.`, [t]);
    },
});

cmd({
    name: "resetwarn",
    cat: "group",
    admin: true,
    group: true,
    desc: "Clear a member's warnings",
    usage: "@user",
    run: async (c) => {
        const t = c.target();
        if (!t) return c.reply("Mention or reply to someone.");
        delete settings.warns[`${c.jid}|${num(t)}`];
        save();
        await c.reply(`✅ Warnings cleared for @${num(t)}`, [t]);
    },
});

cmd({
    name: "leave",
    cat: "group",
    owner: true,
    ownerOnly: true,
    group: true,
    desc: "Make the bot leave this group",
    run: async (c) => {
        await c.reply("👋 Bye everyone!");
        await c.sock.groupLeave(c.jid);
    },
});

// ───────── OWNER ─────────
cmd({
    name: "mode",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc:
        "public = everyone, private = owner + sudo + added users, self = owner + sudo only",
    usage: "<public|private|self>",
    run: async (c) => {
        const v = c.args[0]?.toLowerCase();
        if (!["public", "private", "self"].includes(v)) {
            return c.reply(
                `Mode is *${settings.mode}*. Use: mode public | private | self`,
            );
        }
        settings.mode = v;
        save();
        await c.reply(`🌐 Mode: *${v}*`);
    },
});

cmd({
    name: "setprefix",
    cat: "owner",
    owner: true,
    desc: "Change the command prefix",
    usage: "<symbol>",
    run: async (c) => {
        const v = c.args[0];
        if (!v || v.length > 2) {
            return c.reply("Give a short prefix, e.g. ! or #");
        }
        settings.prefix = v;
        save();
        await c.reply(`🔰 Prefix is now *${v}*`);
    },
});

cmd({
    name: "setpp",
    alias: ["fullpp"],
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc:
        "Set YOUR profile picture from any size image. Keeps the whole photo (blurred background). Add 'crop' for a normal crop",
    usage: "[crop]  (reply to image or send with caption)",
    run: async (c) => {
        const buf = await getImageBuffer(c.sock, c.msg);
        if (!buf) {
            return c.reply(
                "📸 Reply to an image (or send one with the caption).",
            );
        }
        await c.reply("⏳ Processing image with Jimp...");
        const out = await makeSquare(buf, c.args[0] === "crop");
        await c.sock.updateProfilePicture(c.botJid, out);
        await c.reply("✅ Profile picture updated!");
    },
});

for (
    const [key, label, name] of [
        ["autoView", "Auto view status", "autoview"],
        ["autoRead", "Auto read messages", "autoread"],
        ["autoTyping", "Auto typing", "autotyping"],
        ["antiCall", "Anti-call (rejects calls)", "anticall"],
    ]
) {
    cmd({
        name,
        cat: "owner",
        owner: true,
        desc: `${label} on/off`,
        usage: "<on|off>",
        run: async (c) => {
            const v = onOff(c.args[0]);
            if (v === null) {
                return c.reply(
                    `${label}: ${tick(settings[key])}\nUse: ${name} on | off`,
                );
            }
            settings[key] = v;
            save();
            await c.reply(`${label}: ${tick(v)}`);
        },
    });
}

cmd({
    name: "autoreact",
    alias: ["statusreact"],
    cat: "owner",
    owner: true,
    desc: "React to statuses automatically. 'emojis ❤️ 🔥' sets the list",
    usage: "<on|off|emojis ...>",
    run: async (c) => {
        if (c.args[0]?.toLowerCase() === "emojis") {
            const e = c.args.slice(1);
            if (!e.length) return c.reply("Give some emojis.");
            settings.reactEmojis = e;
            save();
            return c.reply(`🎭 Status emojis: ${e.join(" ")}`);
        }
        const v = onOff(c.args[0]);
        if (v === null) {
            return c.reply(
                `Status react: ${tick(settings.autoReact)}\nEmojis: ${
                    settings.reactEmojis.join(" ")
                }`,
            );
        }
        settings.autoReact = v;
        save();
        await c.reply(`Status react: ${tick(v)}`);
    },
});

cmd({
    name: "block",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc: "Block a user (mention, reply, or in their DM)",
    usage: "[@user]",
    run: async (c) => {
        const t = c.target() || (!c.isGroup ? c.jid : null);
        if (!t) return c.reply("Mention or reply to someone.");
        await c.sock.updateBlockStatus(t, "block");
        await c.reply(`🚫 Blocked @${num(t)}`, [t]);
    },
});

cmd({
    name: "unblock",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc: "Unblock a user",
    usage: "[@user]",
    run: async (c) => {
        const t = c.target() || (!c.isGroup ? c.jid : null);
        if (!t) return c.reply("Mention or reply to someone.");
        await c.sock.updateBlockStatus(t, "unblock");
        await c.reply(`✅ Unblocked @${num(t)}`, [t]);
    },
});

cmd({
    name: "setbotname",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc: "Change your WhatsApp profile name",
    usage: "<name>",
    run: async (c) => {
        if (!c.text) return c.reply("Give the new name.");
        await c.sock.updateProfileName(c.text);
        await c.reply("✅ Name updated.");
    },
});

cmd({
    name: "setbio",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc: "Change your WhatsApp About/bio",
    usage: "<text>",
    run: async (c) => {
        if (!c.text) return c.reply("Give the new bio.");
        await c.sock.updateProfileStatus(c.text);
        await c.reply("✅ Bio updated.");
    },
});

cmd({
    name: "menuimage",
    alias: ["mi"],
    cat: "owner",
    owner: true,
    desc: "Set / remove the picture shown with the menu",
    usage: "<set|reset>  (set: reply to an image)",
    run: async (c) => {
        const v = c.args[0]?.toLowerCase();
        if (v === "reset") {
            if (fs.existsSync(menuPath())) fs.unlinkSync(menuPath());
            return c.reply("🖼️ Menu image removed.");
        }
        if (v !== "set") {
            return c.reply("Use: menuimage set (reply to image) | reset");
        }
        const buf = await getImageBuffer(c.sock, c.msg);
        if (!buf) return c.reply("📸 Reply to an image.");
        const img = await Jimp.read(buf);
        if (img.bitmap.width > 900) img.resize({ w: 900 });
        fs.writeFileSync(
            menuPath(),
            await img.getBuffer("image/jpeg", { quality: 85 }),
        );
        await c.reply("🖼️ Menu image saved!");
    },
});

cmd({
    name: "menustyle",
    alias: ["ms"],
    cat: "owner",
    owner: true,
    desc: "Switch menu look: neo (fancy) or minimal",
    usage: "<neo|minimal>",
    run: async (c) => {
        const v = c.args[0]?.toLowerCase();
        if (!["neo", "minimal"].includes(v)) {
            return c.reply(
                `Style is *${settings.menuStyle}*. Use: menustyle neo | minimal`,
            );
        }
        settings.menuStyle = v;
        save();
        await c.reply(`🎨 Menu style: *${v}*`);
    },
});

// ───────── TOOLS ─────────
cmd({
    name: "time",
    cat: "tools",
    desc: "Current time (default West Virginia) or any timezone",
    usage: "[Area/City]  e.g. Africa/Nairobi",
    run: async (c) => {
        const tz = c.args[0] || "America/New_York";
        try {
            const d = new Date();
            const t = d.toLocaleString("en-US", {
                timeZone: tz,
                dateStyle: "full",
                timeStyle: "medium",
            });
            await c.reply(`🕒 *${tz}*\n${t}`);
        } catch {
            await c.reply(
                "❌ Unknown timezone. Try: Africa/Nairobi, Europe/London, Asia/Tokyo",
            );
        }
    },
});

cmd({
    name: "calc",
    alias: ["calculate"],
    cat: "tools",
    desc: "Calculator (+ - * / % ^ and brackets)",
    usage: "<expression>",
    run: async (c) => {
        const e = c.text.replace(/\^/g, "**").replace(/x/gi, "*");
        if (!e || !/^[0-9+\-*/().%\s]+$/.test(e)) {
            return c.reply("🧮 Example: calc (5+3)*2^3");
        }
        try {
            const r = Function(`"use strict"; return (${e})`)();
            if (!Number.isFinite(r)) throw new Error();
            await c.reply(`🧮 ${c.text} = *${r}*`);
        } catch {
            await c.reply("❌ Invalid expression.");
        }
    },
});

cmd({
    name: "password",
    alias: ["genpass"],
    cat: "tools",
    desc: "Generate a strong random password",
    usage: "[length 8-64]",
    run: async (c) => {
        const len = Math.min(64, Math.max(8, parseInt(c.args[0]) || 16));
        const set =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?";
        let pw = "";
        for (let i = 0; i < len; i++) pw += set[crypto.randomInt(set.length)];
        await c.reply(
            `🔐 *Password (${len})*\n\`${pw}\`\n_Generated locally, never stored._`,
        );
    },
});

cmd({
    name: "shorturl",
    cat: "tools",
    desc: "Shorten a link",
    usage: "<url>",
    run: async (c) => {
        if (!/^https?:\/\//i.test(c.args[0] || "")) {
            return c.reply("Give a full link starting with http(s)://");
        }
        const r = await getText(
            `https://is.gd/create.php?format=simple&url=${
                encodeURIComponent(c.args[0])
            }`,
        );
        await c.reply(`🔗 ${r}`);
    },
});

cmd({
    name: "weather",
    cat: "tools",
    desc: "Weather for a city",
    usage: "<city>",
    run: async (c) => {
        if (!c.text) return c.reply("Give a city, e.g. weather Nairobi");
        const r = await getText(
            `https://wttr.in/${encodeURIComponent(c.text)}?format=4`,
        );
        await c.reply(`🌦️ ${r.trim()}`);
    },
});

cmd({
    name: "define",
    alias: ["dictionary"],
    cat: "tools",
    desc: "English dictionary",
    usage: "<word>",
    run: async (c) => {
        if (!c.args[0]) return c.reply("Give a word.");
        try {
            const d = await getJSON(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${
                    encodeURIComponent(c.args[0])
                }`,
            );
            const m = d[0].meanings[0];
            await c.reply(
                `📖 *${d[0].word}* (${m.partOfSpeech})\n${
                    m.definitions[0].definition
                }`,
            );
        } catch {
            await c.reply("❌ No definition found.");
        }
    },
});

cmd({
    name: "github",
    cat: "tools",
    desc: "Look up a GitHub user",
    usage: "<username>",
    run: async (c) => {
        if (!c.args[0]) return c.reply("Give a GitHub username.");
        try {
            const u = await getJSON(
                `https://api.github.com/users/${encodeURIComponent(c.args[0])}`,
            );
            await c.sock.sendMessage(
                c.jid,
                {
                    image: { url: u.avatar_url },
                    caption: `🐙 *${u.login}* ${
                        u.name ? "(" + u.name + ")" : ""
                    }\n📝 ${
                        u.bio || "-"
                    }\n📦 Repos: ${u.public_repos}\n👥 Followers: ${u.followers} · Following: ${u.following}\n📅 Joined: ${
                        u.created_at.slice(0, 10)
                    }\n🔗 ${u.html_url}`,
                },
                { quoted: c.msg },
            );
        } catch {
            await c.reply("❌ User not found.");
        }
    },
});

cmd({
    name: "hash",
    cat: "tools",
    desc: "Hash text with md5 / sha1 / sha256 / sha512",
    usage: "<algo> <text>",
    run: async (c) => {
        const algo = (c.args[0] || "").toLowerCase();
        if (
            !["md5", "sha1", "sha256", "sha512"].includes(algo) ||
            c.args.length < 2
        ) {
            return c.reply("Example: hash sha256 hello");
        }
        const h = crypto.createHash(algo).update(c.args.slice(1).join(" "))
            .digest("hex");
        await c.reply(`#️⃣ *${algo.toUpperCase()}*\n\`${h}\``);
    },
});

cmd({
    name: "b64",
    alias: ["base64"],
    cat: "tools",
    desc: "Base64 encode / decode",
    usage: "<enc|dec> <text>",
    run: async (c) => {
        const mode = (c.args[0] || "").toLowerCase();
        const body = c.args.slice(1).join(" ");
        if (!body || !["enc", "dec"].includes(mode)) {
            return c.reply("Example: b64 enc hello");
        }
        const out = mode === "enc"
            ? Buffer.from(body).toString("base64")
            : Buffer.from(body, "base64").toString("utf8");
        await c.reply(`🔣 \`${out}\``);
    },
});

cmd({
    name: "getpp",
    cat: "tools",
    desc: "Get someone's profile picture",
    usage: "[@user]",
    run: async (c) => {
        const t = c.target() || c.sender;
        try {
            const url = await c.sock.profilePictureUrl(t, "image");
            await c.sock.sendMessage(c.jid, {
                image: { url },
                caption: `🖼️ @${num(t)}`,
                mentions: [t],
            }, { quoted: c.msg });
        } catch {
            await c.reply("❌ No picture (or it is private).");
        }
    },
});

cmd({
    name: "jid",
    cat: "tools",
    desc: "Show chat and sender IDs",
    run: async (c) => c.reply(`🆔 Chat: ${c.jid}\n👤 You: ${c.sender}`),
});

cmd({
    name: "remind",
    cat: "tools",
    desc: "Remind you after X minutes (lost if the bot restarts)",
    usage: "<minutes> <text>",
    run: async (c) => {
        const min = parseInt(c.args[0]);
        const what = c.args.slice(1).join(" ");
        if (!min || min < 1 || min > 720 || !what) {
            return c.reply("Example: remind 10 drink water (1-720 min)");
        }
        await c.reply(`⏰ OK! I will remind you in *${min} min*.`);
        setTimeout(() => {
            c.sock.sendMessage(c.jid, {
                text: `⏰ @${num(c.sender)} Reminder: ${what}`,
                mentions: [c.sender],
            }).catch(() => {});
        }, min * 60000);
    },
});

// ───────── FUN ─────────
const TRUTHS = [
    "What is the last thing you searched on your phone?",
    "What is your most embarrassing school memory?",
    "Which app do you waste the most time on?",
    "What is a skill you wish you had?",
    "What is the funniest lie you ever told?",
    "Who was your first celebrity crush?",
];
const DARES = [
    "Send a voice note singing the first song that comes to mind.",
    "Change your WhatsApp status to 'I love broccoli' for 1 hour.",
    "Text your best friend a compliment right now.",
    "Speak only in emojis for the next 5 messages.",
    "Send the 5th photo in your gallery (if it's safe!).",
    "Do 10 pushups and report back.",
];
const COMPLIMENTS = [
    "You have the energy of a fully charged battery. 🔋",
    "You debug life better than anyone I know. 🐛",
    "Your smile loads faster than fibre internet. ⚡",
    "You're the kind of person who makes a group chat better. 💬",
    "Your ideas are 100% open source awesome. 🌟",
];
const ROASTS = [
    "You're the human version of a loading screen. ⏳",
    "Your WiFi signal has more commitment than you. 📶",
    "You're like a software update: nobody asked for you, but here you are. 😂",
    "Even your autocorrect gave up on you. 🤷",
    "You bring so much joy... when you leave. 😜 (just kidding, love you!)",
];
const QUOTES = [
    "Secure it, automate it, ship it. 🚀",
    "A bug is just a lesson with a stack trace.",
    "Small commits, big progress.",
    "Passwords are like underwear: don't share them, change them often.",
    "First make it work, then make it right, then make it fast.",
    "Learn the fundamentals; frameworks come and go.",
];

cmd({
    name: "joke",
    cat: "fun",
    desc: "A random joke",
    run: async (c) => {
        try {
            const j = await getJSON("https://icanhazdadjoke.com/", {
                Accept: "application/json",
            });
            await c.reply(`😂 ${j.joke}`);
        } catch {
            await c.reply(
                "😂 Why do programmers prefer dark mode? Because light attracts bugs.",
            );
        }
    },
});

cmd({
    name: "8ball",
    cat: "fun",
    desc: "Ask the magic 8-ball",
    usage: "<question>",
    run: async (c) => {
        if (!c.text) return c.reply("Ask a question first 🎱");
        await c.reply(
            `🎱 ${
                pick([
                    "Yes!",
                    "No.",
                    "Definitely.",
                    "Ask again later.",
                    "Very doubtful.",
                    "Without a doubt.",
                    "Maybe...",
                    "Outlook good.",
                    "Don't count on it.",
                ])
            }`,
        );
    },
});

cmd({
    name: "dice",
    cat: "fun",
    desc: "Roll a dice (default 6 sides)",
    usage: "[sides]",
    run: async (c) => {
        const s = Math.min(1000, Math.max(2, parseInt(c.args[0]) || 6));
        await c.reply(`🎲 d${s}: *${crypto.randomInt(1, s + 1)}*`);
    },
});

cmd({
    name: "coin",
    cat: "fun",
    desc: "Flip a coin",
    run: async (c) => c.reply(`🪙 *${pick(["HEADS", "TAILS"])}*`),
});

cmd({
    name: "rps",
    cat: "fun",
    desc: "Rock paper scissors vs the bot",
    usage: "<rock|paper|scissors>",
    run: async (c) => {
        const opts = ["rock", "paper", "scissors"];
        const me = (c.args[0] || "").toLowerCase();
        if (!opts.includes(me)) {
            return c.reply("Use: rps rock | paper | scissors");
        }
        const bot = pick(opts);
        const win = { rock: "scissors", paper: "rock", scissors: "paper" };
        const res = me === bot
            ? "🤝 Draw!"
            : win[me] === bot
            ? "🎉 You win!"
            : "🤖 I win!";
        await c.reply(`You: ${me}\nMe: ${bot}\n${res}`);
    },
});

cmd({
    name: "truth",
    cat: "fun",
    desc: "A random truth question",
    run: async (c) => c.reply(`🫣 *TRUTH*\n${pick(TRUTHS)}`),
});

cmd({
    name: "dare",
    cat: "fun",
    desc: "A random dare",
    run: async (c) => c.reply(`😈 *DARE*\n${pick(DARES)}`),
});

cmd({
    name: "ship",
    cat: "fun",
    desc: "Love compatibility of two people (mention them)",
    usage: "@user1 @user2",
    run: async (c) => {
        const ci = ctxInfo(c.msg.message);
        const m = ci?.mentionedJid || [];
        const a = m.length > 1 ? m[0] : c.sender;
        const b = m.length > 1 ? m[1] : m[0] || c.target();
        if (!b) return c.reply("Mention someone to ship with 💘");
        const p = hashNum([num(a), num(b)].sort().join("+"));
        await c.reply(
            `💘 *SHIP*\n@${num(a)} ❤️ @${num(b)}\n${bar(p)} *${p}%*`,
            [a, b],
        );
    },
});

cmd({
    name: "rate",
    cat: "fun",
    desc: "Rate anything out of 100",
    usage: "<thing>",
    run: async (c) => {
        if (!c.text) return c.reply("Rate what? e.g. rate my Python skills");
        const p = hashNum(c.text.toLowerCase());
        await c.reply(`⭐ *${c.text}*\n${bar(p)} *${p}/100*`);
    },
});

cmd({
    name: "compliment",
    cat: "fun",
    desc: "Send a compliment",
    run: async (c) => c.reply(`💖 ${pick(COMPLIMENTS)}`),
});

cmd({
    name: "roast",
    cat: "fun",
    desc: "A light friendly roast",
    run: async (c) => c.reply(`🔥 ${pick(ROASTS)}`),
});

cmd({
    name: "quote",
    cat: "fun",
    desc: "A dev motivation line",
    run: async (c) => c.reply(`💡 _${pick(QUOTES)}_`),
});

// ───────── PAIRING: let other people link their own number ─────────
cmd({
    name: "pair",
    cat: "core",
    desc:
        "Link YOUR number to the bot so you can use it from your own WhatsApp, in any chat (approved users only)",
    usage: "<your number with country code>",
    run: async (c) => {
        if (!c.sock._main) return;
        if (!c.isUser) {
            return c.reply(
                "🔒 Pairing is only for users approved by the owner.",
            );
        }
        const n = (c.args[0] || "").replace(/\D/g, "");
        if (n.length < 8) {
            return c.reply(
                "Example: pair 2547XXXXXXXX (country code, digits only)",
            );
        }
        if (bots.has(n) || n === num(c.botJid)) {
            return c.reply("That number is already linked.");
        }
        if (bots.size - 1 >= CONFIG.maxSessions) {
            return c.reply(
                `⚠️ Limit reached (${CONFIG.maxSessions} linked users).`,
            );
        }
        const to = c.isGroup ? c.sender : c.jid; // code goes to the requester's DM
        await c.reply("⏳ Requesting a pairing code...");
        try {
            const code = await startSession(n, {
                pair: true,
                onExpire: () =>
                    c.sock
                        .sendMessage(to, {
                            text:
                                `⌛ The pairing code for ${n} expired. Run ${settings.prefix}pair again.`,
                        })
                        .catch(() => {}),
            });
            if (!code) throw new Error("no code received");
            const text = `🔗 *PAIRING CODE for ${n}*\n\n*${code}*\n\n` +
                `1️⃣ Open WhatsApp on that phone\n` +
                `2️⃣ Linked devices → Link a device → *Link with phone number instead*\n` +
                `3️⃣ Enter the code (valid ~2 minutes)\n\n` +
                `⚠️ _Linking lets this bot read and send messages from that account. Only link if you trust the bot owner. ` +
                `Unlink anytime from WhatsApp → Linked devices, or with ${settings.prefix}unpair._`;
            await c.sock.sendMessage(to, { text }).catch(() => c.reply(text));
            if (c.isGroup) await c.reply("📩 Pairing code sent to your DM.");
        } catch (e) {
            await dropSession(n, false);
            await c.reply("❌ Could not get a pairing code: " + e.message);
        }
    },
});

cmd({
    name: "unpair",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc:
        "Main bot: unlink a user by number. On a linked account: unlink yourself",
    usage: "[number]",
    run: async (c) => {
        const id = c.sock._main
            ? (c.args[0] || "").replace(/\D/g, "")
            : c.sock._sid;
        if (!id) return c.reply("Example: unpair 2547XXXXXXXX");
        if (!bots.has(id)) return c.reply("No such linked number.");
        await c.reply("🔌 Unlinking...");
        await dropSession(id, true);
        if (c.sock._main) {
            await c.reply(`✅ ${id} unlinked and its data deleted.`);
        }
    },
});

cmd({
    name: "sessions",
    cat: "owner",
    owner: true,
    ownerOnly: true,
    desc: "List the people who linked their number",
    run: async (c) => {
        if (!c.sock._main) return;
        const rows = [...bots.entries()]
            .filter(([id]) => id !== "main")
            .map(([id, b]) => `${b.st.online ? "🟢" : "🔴"} ${id}`);
        await c.reply(
            `👥 *LINKED USERS (${rows.length}/${CONFIG.maxSessions})*\n${
                rows.join("\n") || "none yet"
            }`,
        );
    },
});

// ───────── SECRET (hidden: not in menu, help or command count) ─────────
// Only the MAIN owner can use it. Replies go to your own chat, and the command
// message is deleted, so nobody in a group sees it.
//   .zkey add user @someone   -> can use the bot in "private" mode
//   .zkey add sudo @someone   -> owner-level commands (not the main-owner-only ones)
//   .zkey del @someone        -> remove from both lists
//   .zkey list
cmd({
    name: CONFIG.secretCommand,
    cat: "owner",
    hidden: true,
    owner: true,
    ownerOnly: true,
    desc: "secret",
    run: async (c) => {
        const sub = (c.args[0] || "").toLowerCase();
        const ci = ctxInfo(c.msg.message);
        const typed = c.args.slice(1).find((a) => /^[@+]?\d{7,}$/.test(a));
        const t = ci?.mentionedJid?.[0] ||
            ci?.participant ||
            (typed ? typed.replace(/\D/g, "") + "@s.whatsapp.net" : null) ||
            (!c.isGroup ? c.jid : null);
        const out = (text) =>
            c.sock.sendMessage(c.botJid, { text }).catch(() => {});
        await c.sock.sendMessage(c.jid, { delete: c.msg.key }).catch(() => {});

        const P = settings.prefix + CONFIG.secretCommand;
        const drop = (n) => {
            settings.sudo = settings.sudo.filter((x) => x !== n);
            settings.users = settings.users.filter((x) => x !== n);
        };

        if (sub === "list") {
            return out(
                `🔐 *Secret list*\n👑 Sudo: ${
                    settings.sudo.join(", ") || "-"
                }\n👤 Users: ${settings.users.join(", ") || "-"}`,
            );
        }
        if (sub === "del" || sub === "remove") {
            if (!t) return out(`Usage: ${P} del @user`);
            drop(num(t));
            save();
            return out(`🗑️ Removed ${num(t)} from the lists.`);
        }
        if (sub === "add") {
            const role = (c.args[1] || "").toLowerCase();
            if (!["user", "sudo"].includes(role) || !t) {
                return out(
                    `Usage:\n${P} add user @someone\n${P} add sudo @someone\n(mention them or reply to their message)`,
                );
            }
            drop(num(t));
            (role === "sudo" ? settings.sudo : settings.users).push(num(t));
            save();
            return out(`✅ ${num(t)} added as *${role}*.`);
        }
        await out(
            `Usage:\n${P} add user|sudo @someone\n${P} del @someone\n${P} list`,
        );
    },
});

/* ════════════════════════════════════════════
   6. WARN SYSTEM (used by .warn and anti-link)
   ════════════════════════════════════════════ */

async function warnUser(sock, jid, user, botIsAdmin, reason) {
    const key = `${jid}|${num(user)}`;
    settings.warns[key] = (settings.warns[key] || 0) + 1;
    const n = settings.warns[key];
    save();
    await sock.sendMessage(jid, {
        text: `⚠️ @${num(user)} warning *${n}/3*\n📌 ${reason}`,
        mentions: [user],
    });
    if (n >= 3) {
        delete settings.warns[key];
        save();
        if (botIsAdmin) {
            await sock.groupParticipantsUpdate(jid, [user], "remove").catch(
                () => {},
            );
            await sock.sendMessage(jid, {
                text: `🚪 @${num(user)} removed after 3 warnings.`,
                mentions: [user],
            });
        }
    }
}

/* ════════════════════════════════════════════
   7. MESSAGE HANDLING
   ════════════════════════════════════════════ */

const LINK_ALL = /(https?:\/\/|www\.)\S+|chat\.whatsapp\.com\/\S+/i;
const LINK_WA = /chat\.whatsapp\.com\/\S+/i;

// auto view / react to statuses
async function onStatus(sock, msg) {
    if (msg.key.fromMe) return;
    if (settings.autoView) await sock.readMessages([msg.key]).catch(() => {});
    if (settings.autoReact && msg.key.participant) {
        await sock
            .sendMessage(
                "status@broadcast",
                { react: { text: pick(settings.reactEmojis), key: msg.key } },
                {
                    statusJidList: [
                        msg.key.participant,
                        jidNormalizedUser(sock.user.id),
                    ],
                },
            )
            .catch(() => {});
    }
}

async function onMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith("@newsletter")) return;
    if (jid === "status@broadcast") return onStatus(sock, msg);

    const m = unwrap(msg.message);
    if (!m) return;

    const text = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ""
    ).trim();

    const isGroup = jid.endsWith("@g.us");
    const fromMe = !!msg.key.fromMe;
    const botJid = jidNormalizedUser(sock.user.id);
    const sender = fromMe ? botJid : msg.key.participant || jid;
    const senderIds = [
        msg.key.participant,
        msg.key.participantAlt,
        msg.key.remoteJidAlt,
        msg.key.senderPn,
        fromMe ? botJid : jid,
    ]
        .filter(Boolean)
        .map(num);
    const owners = new Set([
        num(botJid),
        ...(sock._main ? CONFIG.extraOwners.map(String) : []),
    ]);
    const isOwner = fromMe || senderIds.some((i) => owners.has(i));
    const isSudo = isOwner || senderIds.some((i) => settings.sudo.includes(i));
    const isUser = isSudo || senderIds.some((i) => settings.users.includes(i));

    if (settings.autoRead && !fromMe) {
        await sock.readMessages([msg.key]).catch(() => {});
    }

    // ── ANTI-LINK ──
    if (isGroup && settings.antiLink[jid] && !isSudo && text) {
        const re = settings.antiLink[jid] === "wa" ? LINK_WA : LINK_ALL;
        if (re.test(text)) {
            const meta = await getMeta(sock, jid).catch(() => null);
            const botIds = [num(botJid), sock.user.lid && num(sock.user.lid)]
                .filter(Boolean);
            const botIsAdmin = !!meta?.participants?.find((p) =>
                p.admin && idsOf(p).some((i) => botIds.includes(i))
            );
            if (meta && botIsAdmin && !isAdminIn(meta, sender)) {
                await sock.sendMessage(jid, { delete: msg.key }).catch(
                    () => {},
                );
                await warnUser(
                    sock,
                    jid,
                    sender,
                    true,
                    "Links are not allowed here",
                );
                return;
            }
        }
    }

    if (!text) return;
    if (
        (settings.mode === "self" && !isSudo) ||
        (settings.mode === "private" && !isUser)
    ) {
        if (CONFIG.debug && text.startsWith(settings.prefix)) {
            console.log(
                `🔒 blocked by mode "${settings.mode}" · sender ids: ${
                    senderIds.join(", ")
                }`,
            );
        }
        return;
    }

    // ── .xml trigger (works without prefix, in any chat) ──
    if (text.toLowerCase() === ".xml") {
        // ping = how long the message took to reach the bot (ms)
        const sentAt = Number(msg.messageTimestamp) * 1000;
        const ping = Math.max(0, Date.now() - sentAt);
        const { time, day } = wvTime();
        const reply = `┏━━━━━━━━━━━
*ZINERK-XMD* ACTIVE...
🕒 ${time} (VPS - West Virginia)
📅 ${day}
⚡ Ping: ${ping} ms

*OWNER:* └──▓ 🪾LOGGER VICK🐧 ▓──┘
┗━━━━━━━━━━━`;
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        return;
    }

    // ── COMMANDS ──
    const prefix = settings.prefix;
    if (!text.startsWith(prefix)) return;
    const args = text.slice(prefix.length).trim().split(/\s+/);
    const name = (args.shift() || "").toLowerCase();
    const c = commands.get(name);
    if (!c) return;

    const reply = (t, mentions = []) =>
        sock.sendMessage(jid, { text: t, mentions }, { quoted: msg });

    if (c.hidden && !isOwner) return; // secret command: stay completely silent
    if (c.ownerOnly && !isOwner) return reply("👑 Main owner only.");
    if (c.owner && !isSudo) return reply("👑 Owner / sudo only command.");
    if ((c.group || c.admin || c.botAdmin) && !isGroup) {
        return reply("👥 This command works in groups only.");
    }

    let meta = null;
    let isBotAdmin = false;
    if (isGroup && (c.group || c.admin || c.botAdmin)) {
        try {
            meta = await getMeta(sock, jid);
        } catch {
            return reply("❌ Could not read group info. Try again.");
        }
        const botIds = [num(botJid), sock.user.lid && num(sock.user.lid)]
            .filter(Boolean);
        isBotAdmin = !!meta.participants.find((p) =>
            p.admin && idsOf(p).some((i) => botIds.includes(i))
        );
        if (c.admin && !isSudo && !isAdminIn(meta, sender)) {
            return reply("🛡️ Group admins only.");
        }
        if (c.botAdmin && !isBotAdmin) {
            return reply("🤖 Make me a group admin first.");
        }
    }

    // who the command is aimed at: mention > replied user > number typed
    const target = () => {
        const ci = ctxInfo(msg.message);
        if (ci?.mentionedJid?.length) return ci.mentionedJid[0];
        if (ci?.participant) return ci.participant;
        const n = args[0]?.replace(/[^0-9]/g, "");
        return n && n.length >= 7 ? n + "@s.whatsapp.net" : null;
    };

    if (settings.autoTyping) {
        sock.sendPresenceUpdate("composing", jid).catch(() => {});
    }

    try {
        await c.run({
            sock,
            msg,
            jid,
            isGroup,
            sender,
            args,
            text: args.join(" "),
            isOwner,
            isSudo,
            isUser,
            meta,
            isBotAdmin,
            botJid,
            reply,
            target,
        });
        if (c.admin || c.botAdmin) metaCache.delete(sock._sid + "|" + jid);
    } catch (e) {
        console.log(`[${name}] error:`, e.message);
        await reply("❌ Something went wrong: " + e.message).catch(() => {});
    }
}

/* ════════════════════════════════════════════
   8. SESSIONS: your bot + the bots of people who paired their number
   ════════════════════════════════════════════ */

const bots = new Map(); // id -> { sock, st }   (id = phone number, or "main")
let waVersion;

// log a session out, forget it and delete its files
async function dropSession(id, logout = true) {
    const b = bots.get(id);
    if (!b || id === "main") return false;
    b.st.dropped = true;
    bots.delete(id);
    try {
        if (logout) await b.sock.logout();
        else b.sock.end(undefined);
    } catch {}
    try {
        fs.rmSync(path.join("sessions", id), { recursive: true, force: true });
    } catch {}
    return true;
}

// ---- event handlers (shared by every session) ----
async function handleUpsert(sock, { messages, type }) {
    for (const msg of messages) {
        if (CONFIG.debug) {
            console.log(
                `📩 [${sock._sid}] [${type}] ${msg.key.remoteJid} alt=${
                    msg.key.remoteJidAlt || msg.key.participantAlt || "-"
                } fromMe=${!!msg.key.fromMe}`,
            );
        }
        // "notify" = live message. "append" can be old history, so only accept very fresh ones
        if (type !== "notify") {
            const age = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
            if (type !== "append" || age > 30) continue;
        }
        try {
            await onMessage(sock, msg);
        } catch (e) {
            console.log("handler error:", e.message);
        }
    }
}

async function handleGroupUpdate(sock, { id, participants, action }) {
    if (!settings.welcome[id] || !["add", "remove"].includes(action)) return;
    try {
        const meta = await getMeta(sock, id);
        const jids = participants.map((
            p,
        ) => (typeof p === "string" ? p : p.id || p.phoneNumber));
        const text = action === "add"
            ? `👋 Welcome ${
                jids.map((j) => "@" + num(j)).join(" ")
            } to *${meta.subject}*! 🎉\nRead the group rules and enjoy.`
            : `😢 Goodbye ${
                jids.map((j) => "@" + num(j)).join(" ")
            }. We will miss you.`;
        await sock.sendMessage(id, { text, mentions: jids });
    } catch {}
}

async function handleCalls(sock, calls) {
    if (!settings.antiCall) return;
    for (const call of calls) {
        if (call.status === "offer") {
            await sock.rejectCall(call.id, call.from).catch(() => {});
            await sock
                .sendMessage(call.from, {
                    text:
                        "📵 Calls are not allowed. Please send a message instead.",
                })
                .catch(() => {});
        }
    }
}

// ---- start (or restart) one session ----
// id = "main" for you, or a phone number for a linked user.
// With opts.pair the pairing code is requested and RETURNED.
async function startSession(id, opts = {}) {
    const main = id === "main";
    const dir = main ? "." : path.join("sessions", id);
    const authDir = main ? "session" : path.join(dir, "auth");
    fs.mkdirSync(authDir, { recursive: true });

    const prev = bots.get(id);
    const settingsFile = main
        ? CONFIG.settingsFile
        : path.join(dir, "settings.json");
    const st = main ? mainStore : prev?.st || {
        id,
        main: false,
        dir,
        settingsFile,
        // linked users start private: only THEY can use their bot
        settings: loadSettings(settingsFile, { mode: "self", autoView: false }),
        retry: 0,
        dropped: false,
        justPaired: !!opts.pair,
    };
    const run = (fn) => als.run(st, fn);

    // Saves the login so you only pair once
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    waVersion ||= (await fetchLatestBaileysVersion()).version;

    // leftover folder of a pairing that was never completed
    if (!main && !opts.pair && !state.creds.me) {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
    }

    const sock = makeWASocket({
        version: waVersion,
        auth: state,
        logger,
        printQRInTerminal: false, // no QR code
        browser: ["Ubuntu", "Chrome", "20.0.04"], // needed for pairing code
    });
    sock._sid = id;
    sock._main = main;
    bots.set(id, { sock, st });

    sock.ev.on("creds.update", saveCreds);

    // ---- connection handling / auto reconnect ----
    sock.ev.on("connection.update", (u) =>
        run(async () => {
            const { connection, lastDisconnect } = u;
            if (connection === "open") {
                st.retry = 0;
                st.online = true;
                const me = jidNormalizedUser(sock.user.id);
                console.log(
                    `✅ [${id}] connected as ${
                        num(me)
                    } · ${list.length} commands loaded.`,
                );
                // proof of life, shown in your "Message yourself" chat
                let text = null;
                if (main && !st.greeted) {
                    st.greeted = true;
                    text =
                        `✅ *${CONFIG.botName}* is online.\nType *${settings.prefix}menu* to start.`;
                } else if (!main && st.justPaired) {
                    st.justPaired = false;
                    text =
                        `✅ *${CONFIG.botName}* is linked to your account!\n\n` +
                        `• Only YOU can use it by default (mode: self).\n` +
                        `• Type *${settings.prefix}menu* in any chat, even other people's DMs.\n` +
                        `• Unlink anytime: *${settings.prefix}unpair* or WhatsApp → Linked devices.`;
                }
                if (text) await sock.sendMessage(me, { text }).catch(() => {});
            }
            if (connection === "close") {
                st.online = false;
                if (st.dropped) return;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(
                    `❌ [${id}] Connection closed (code ${code}: ${
                        lastDisconnect?.error?.message || "unknown"
                    })`,
                );
                if (code === DisconnectReason.loggedOut) {
                    if (main) {
                        console.log(
                            'Logged out. Delete the "session" folder and run again.',
                        );
                        process.exit(1);
                    }
                    console.log(
                        `[${id}] was unlinked from the phone. Removing its session.`,
                    );
                    return dropSession(id, false);
                }
                if (code === DisconnectReason.connectionReplaced) {
                    if (main) {
                        console.log(
                            "⚠️ The same session is open somewhere else (another Termux window / tmux / old bot).",
                        );
                        console.log(
                            '   Stop it with:  pkill -f "node index.mjs"  then start again.',
                        );
                        process.exit(1);
                    }
                    return dropSession(id, false);
                }
                // pairing never finished
                if (
                    !main && code !== DisconnectReason.restartRequired &&
                    !state.creds.me
                ) {
                    return dropSession(id, false);
                }
                const wait = code === DisconnectReason.restartRequired
                    ? 500
                    : Math.min(30000, 2000 * ++st.retry);
                console.log(`[${id}] Reconnecting in ${wait / 1000}s...`);
                setTimeout(() => {
                    if (!st.dropped) {
                        startSession(id).catch((e) =>
                            console.log(`[${id}] restart failed:`, e.message)
                        );
                    }
                }, wait);
            }
        }));

    sock.ev.on("messages.upsert", (ev) => run(() => handleUpsert(sock, ev)));
    sock.ev.on(
        "group-participants.update",
        (ev) => run(() => handleGroupUpdate(sock, ev)),
    );
    sock.ev.on("call", (calls) => run(() => handleCalls(sock, calls)));

    // ---- pairing code login ----
    let code = null;
    if (!state.creds.registered && !state.creds.me) {
        const number = main
            ? (await ask(
                "Enter your WhatsApp number with country code (digits only): ",
            )).replace(/[^0-9]/g, "")
            : id;
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const raw = await sock.requestPairingCode(number);
            code = raw?.match(/.{1,4}/g)?.join("-") || raw;
            if (main) {
                console.log("\nYour pairing code:", code);
                console.log(
                    "WhatsApp > Linked devices > Link with phone number instead > enter the code\n",
                );
            }
        } catch (e) {
            console.log(`[${id}] Could not get pairing code:`, e.message);
        }
        // a linked user who never enters the code: clean up after 3 minutes
        if (!main && opts.pair) {
            setTimeout(async () => {
                if (!st.dropped && !state.creds.me) {
                    await dropSession(id, false);
                    opts.onExpire?.();
                }
            }, 180000);
        }
    }
    return code;
}

// keep the bot alive if something unexpected happens
process.on("uncaughtException", (e) => console.log("uncaught:", e.message));
process.on(
    "unhandledRejection",
    (e) => console.log("unhandled:", e?.message || e),
);

async function boot() {
    await startSession("main");
    // bring back everyone who linked their number earlier
    if (fs.existsSync("sessions")) {
        for (const id of fs.readdirSync("sessions")) {
            if (/^\d+$/.test(id)) {
                await startSession(id).catch((e) =>
                    console.log(`[${id}] failed to start:`, e.message)
                );
            }
        }
    }
}

boot();
