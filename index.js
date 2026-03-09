require('dotenv').config();
const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes, ChannelType
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PREFIX = '!';
const DB_FILE = path.join(__dirname, 'autoclear.json');

// ── DATABASE ──────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}');
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Format: { channelId: { minutes: X, enabled: true } }

// ── ACTIVE TIMERS (in-memory) ─────────────────────────────
const activeTimers = new Map(); // channelId → intervalId

// ── IS ADMIN/MOD ─────────────────────────────────────────
function isModOrAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.ManageMessages) ||
         member.permissions.has(PermissionFlagsBits.Administrator);
}

// ── CLEAR CHANNEL ─────────────────────────────────────────
async function clearChannel(channel) {
  try {
    // Text channel — bulk delete (maks 100 pesan, max 14 hari)
    if (channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement) {
      let deleted = 1;
      while (deleted > 0) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;
        const bulk = await channel.bulkDelete(messages, true).catch(() => null);
        deleted = bulk ? bulk.size : 0;
        if (deleted === 0) break;
        await new Promise(r => setTimeout(r, 1000)); // rate limit
      }
    }
  } catch (e) {
    console.error(`❌ Gagal clear #${channel.name}:`, e.message);
  }
}

// ── START TIMER ───────────────────────────────────────────
function startTimer(client, channelId, minutes) {
  // Stop timer lama kalau ada
  stopTimer(channelId);

  const ms = minutes * 60 * 1000;
  const interval = setInterval(async () => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) { stopTimer(channelId); return; }
    console.log(`🧹 Auto clear #${channel.name} (setiap ${minutes} menit)`);
    await clearChannel(channel);
  }, ms);

  activeTimers.set(channelId, interval);
  console.log(`⏰ Timer set: channel ${channelId} setiap ${minutes} menit`);
}

function stopTimer(channelId) {
  if (activeTimers.has(channelId)) {
    clearInterval(activeTimers.get(channelId));
    activeTimers.delete(channelId);
  }
}

// ── RESTORE TIMERS ON STARTUP ─────────────────────────────
function restoreTimers(client) {
  const db = loadDB();
  for (const [channelId, cfg] of Object.entries(db)) {
    if (cfg.enabled) {
      startTimer(client, channelId, cfg.minutes);
      console.log(`🔄 Restored timer: ${channelId} (${cfg.minutes} menit)`);
    }
  }
}

// ── SLASH COMMANDS ────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('autoclear')
    .setDescription('Set auto clear pesan di channel')
    .addIntegerOption(o =>
      o.setName('menit')
        .setDescription('Hapus pesan setiap X menit (0 = matikan)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(10080))
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel yang mau di-set (default: channel ini)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('clearstatus')
    .setDescription('Lihat status auto clear di channel ini')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('clearlist')
    .setDescription('Lihat semua channel yang aktif auto clear')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('clearnow')
    .setDescription('Hapus semua pesan di channel ini sekarang')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('✅ Slash commands registered!');
  } catch (e) {
    console.error('❌ Register error:', e.message);
  }
}

// ── CLIENT ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`✅ Cleaner Bot online: ${client.user.tag}`);
  await registerCommands();
  restoreTimers(client);
});

// ── HANDLE SET AUTOCLEAR ──────────────────────────────────
async function handleSetAutoClear(channel, minutes, replyFn) {
  const db = loadDB();

  if (minutes === 0) {
    // Matikan
    stopTimer(channel.id);
    delete db[channel.id];
    saveDB(db);
    return replyFn(`✅ Auto clear di <#${channel.id}> **dimatikan**.`);
  }

  db[channel.id] = { minutes, enabled: true };
  saveDB(db);
  startTimer(client, channel.id, minutes);

  const label = minutes >= 60
    ? `${Math.floor(minutes / 60)} jam${minutes % 60 ? ` ${minutes % 60} menit` : ''}`
    : `${minutes} menit`;

  return replyFn(`✅ Auto clear aktif di <#${channel.id}> — pesan dihapus setiap **${label}**.\n⚠️ Pastikan bot punya permission \`Manage Messages\` di channel ini.`);
}

// ── SLASH HANDLER ─────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return interaction.reply({ content: '❌ Hanya bisa digunakan di server.', ephemeral: true });

  const member = interaction.member;
  if (!isModOrAdmin(member)) {
    return interaction.reply({ content: '❌ Kamu tidak punya permission untuk ini.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const cmd = interaction.commandName;
  const channel = interaction.channel;

  if (cmd === 'autoclear') {
    const minutes = interaction.options.getInteger('menit');
    const target = interaction.options.getChannel('channel') || interaction.channel;
    return handleSetAutoClear(target, minutes, (msg) => interaction.editReply(msg));
  }

  if (cmd === 'clearstatus') {
    const db = loadDB();
    const cfg = db[channel.id];
    if (!cfg || !cfg.enabled) {
      return interaction.editReply(`ℹ️ Auto clear di <#${channel.id}> **tidak aktif**.`);
    }
    const label = cfg.minutes >= 60
      ? `${Math.floor(cfg.minutes / 60)} jam${cfg.minutes % 60 ? ` ${cfg.minutes % 60} menit` : ''}`
      : `${cfg.minutes} menit`;
    return interaction.editReply(`⏰ Auto clear <#${channel.id}>: setiap **${label}**. Status: **Aktif** ✅`);
  }

  if (cmd === 'clearlist') {
    const db = loadDB();
    const aktif = Object.entries(db).filter(([, v]) => v.enabled);
    if (aktif.length === 0) return interaction.editReply('ℹ️ Tidak ada channel yang aktif auto clear.');
    const list = aktif.map(([id, v]) => {
      const label = v.minutes >= 60
        ? `${Math.floor(v.minutes / 60)} jam${v.minutes % 60 ? ` ${v.minutes % 60} menit` : ''}`
        : `${v.minutes} menit`;
      return `• <#${id}> — setiap **${label}**`;
    }).join('\n');
    return interaction.editReply(`⏰ **Channel dengan Auto Clear:**\n${list}`);
  }

  if (cmd === 'clearnow') {
    await interaction.editReply(`🧹 Menghapus semua pesan di <#${channel.id}>...`);
    await clearChannel(channel);
    return interaction.editReply(`✅ Selesai! Semua pesan di <#${channel.id}> telah dihapus.`);
  }
});

// ── PREFIX HANDLER ────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // Cek permission
  if (!isModOrAdmin(message.member)) return;

  // !autoclear <menit>
  if (cmd === 'autoclear') {
    const minutes = parseInt(args[1]);
    if (isNaN(minutes) || minutes < 0) {
      return message.reply('❌ Format: `!autoclear <menit>` — contoh: `!autoclear 30` atau `!autoclear 0` untuk matikan.');
    }
    const reply = await message.reply('⏳ Memproses...');
    return handleSetAutoClear(message.channel, minutes, (msg) => reply.edit(msg));
  }

  // !clearstatus
  if (cmd === 'clearstatus') {
    const db = loadDB();
    const cfg = db[message.channel.id];
    if (!cfg || !cfg.enabled) {
      return message.reply(`ℹ️ Auto clear di channel ini **tidak aktif**.`);
    }
    const label = cfg.minutes >= 60
      ? `${Math.floor(cfg.minutes / 60)} jam${cfg.minutes % 60 ? ` ${cfg.minutes % 60} menit` : ''}`
      : `${cfg.minutes} menit`;
    return message.reply(`⏰ Auto clear aktif: setiap **${label}**.`);
  }

  // !clearlist
  if (cmd === 'clearlist') {
    const db = loadDB();
    const aktif = Object.entries(db).filter(([, v]) => v.enabled);
    if (aktif.length === 0) return message.reply('ℹ️ Tidak ada channel yang aktif auto clear.');
    const list = aktif.map(([id, v]) => {
      const label = v.minutes >= 60
        ? `${Math.floor(v.minutes / 60)} jam${v.minutes % 60 ? ` ${v.minutes % 60} menit` : ''}`
        : `${v.minutes} menit`;
      return `• <#${id}> — setiap **${label}**`;
    }).join('\n');
    return message.reply(`⏰ **Channel dengan Auto Clear:**\n${list}`);
  }

  // !clearnow
  if (cmd === 'clearnow') {
    const msg = await message.reply('🧹 Menghapus semua pesan...');
    await clearChannel(message.channel);
    // msg mungkin ikut kehapus, jadi kirim baru
    message.channel.send('✅ Semua pesan telah dihapus!').then(m => {
      setTimeout(() => m.delete().catch(() => {}), 5000);
    });
    return;
  }

  // !clearhelp
  if (cmd === 'clearhelp') {
    return message.reply(
      `🧹 **Cleaner Bot Commands**\n\n` +
      `\`!autoclear <menit>\` — Set auto clear (0 = matikan)\n` +
      `\`!clearstatus\` — Status auto clear channel ini\n` +
      `\`!clearlist\` — Semua channel yang aktif\n` +
      `\`!clearnow\` — Hapus semua pesan sekarang\n\n` +
      `_Contoh: \`!autoclear 30\` → hapus pesan setiap 30 menit_`
    );
  }
});

client.login(TOKEN);
