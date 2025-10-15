// index.js
// Make this bot ONLY update crypto prices in channel names, with slash commands to manage which channels & coins.

// --------- Dependencies ----------
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, ChannelType, EmbedBuilder, REST, Routes } from 'discord.js';
import fetch from 'node-fetch';
import fs from 'fs';

// --------- Load ENV --------------
const BOT_TOKEN = process.env.BOT_TOKEN; // put in .env as BOT_TOKEN=xxxxx
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment. Create a .env file with BOT_TOKEN=your_token');
  process.exit(1);
}

// --------- Simple persistence -----
const CONFIG_PATH = './config.json';
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ guilds: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to load config.json:', e);
    return { guilds: {} };
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Failed to save config.json:', e);
  }
}
let config = loadConfig();

/*
Config shape:
{
  "guilds": {
    "<guildId>": {
      "intervalMinutes": 10,
      "running": true,
      "entries": [
        { "channelId": "123", "coin": "bitcoin", "label": "💲 BTC" }
      ]
    }
  }
}
*/

// --------- CoinGecko helpers -----
let coinListCache = { list: [], fetchedAt: 0 };
async function getCoinList() {
  const now = Date.now();
  if (coinListCache.list.length && now - coinListCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return coinListCache.list;
  }
  const res = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=false');
  if (!res.ok) throw new Error(`CoinGecko coins/list HTTP ${res.status}`);
  const json = await res.json();
  coinListCache = { list: json, fetchedAt: now };
  return json;
}
async function validateCoinId(coinId) {
  const list = await getCoinList();
  return list.some(c => c.id.toLowerCase() === coinId.toLowerCase());
}
async function fetchUsdPrice(coinId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
  try {
    const r = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const v = data?.[coinId]?.usd;
    return typeof v === 'number' ? v : null;
  } catch (e) {
    console.error(`Price fetch failed for ${coinId}:`, e.message);
    return null;
  }
}

// --------- Discord client ----------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.GuildMember]
});

// --------- Slash Commands ----------
const slashCommands = [
  {
    name: 'crypto-add',
    description: 'Map a channel to a coin price (updates channel name).',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`,
    options: [
      {
        name: 'channel',
        description: 'The channel to rename periodically (voice or text).',
        type: 7, // CHANNEL
        required: true
      },
      {
        name: 'coin',
        description: 'CoinGecko coin id (e.g. bitcoin, ethereum).',
        type: 3, // STRING
        required: true
      },
      {
        name: 'label',
        description: 'Custom label prefix for the channel name (e.g. 💲 BTC).',
        type: 3, // STRING
        required: true
      }
    ]
  },
  {
    name: 'crypto-remove',
    description: 'Unmap a channel from crypto updates.',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`,
    options: [
      {
        name: 'channel',
        description: 'The channel to stop updating.',
        type: 7,
        required: true
      }
    ]
  },
  {
    name: 'crypto-list',
    description: 'Show current crypto channel mappings.',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`
  },
  {
    name: 'crypto-interval',
    description: 'Set update interval in minutes (min 1, default 10).',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`,
    options: [
      {
        name: 'minutes',
        description: 'Number of minutes between updates.',
        type: 4, // INTEGER
        required: true
      }
    ]
  },
  {
    name: 'crypto-start',
    description: 'Start periodic crypto updates.',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`
  },
  {
    name: 'crypto-stop',
    description: 'Stop periodic crypto updates.',
    default_member_permissions: `${PermissionsBitField.Flags.ManageGuild}`
  }
];

// Register commands on ready (global)
async function registerCommands(appId) {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
  console.log('✅ Slash commands registered globally.');
}

// --------- Update loop management -----
const timers = new Map(); // guildId -> NodeJS.Timer

function getGuildCfg(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = { intervalMinutes: 10, running: true, entries: [] };
    saveConfig(config);
  }
  return config.guilds[guildId];
}

function startGuildTimer(guildId) {
  stopGuildTimer(guildId);
  const gcfg = getGuildCfg(guildId);
  if (!gcfg.running) return;

  const periodMs = Math.max(1, Number(gcfg.intervalMinutes || 10)) * 60 * 1000;
  const tick = async () => {
    try {
      await updateGuildMappings(guildId);
    } catch (e) {
      console.error(`Update tick failed for guild ${guildId}:`, e);
    }
  };
  // Run immediately, then on interval
  tick();
  const t = setInterval(tick, periodMs);
  timers.set(guildId, t);
  console.log(`⏱️ Started update timer for guild ${guildId} every ${gcfg.intervalMinutes} min`);
}

function stopGuildTimer(guildId) {
  const t = timers.get(guildId);
  if (t) {
    clearInterval(t);
    timers.delete(guildId);
    console.log(`⏹️ Stopped update timer for guild ${guildId}`);
  }
}

// --------- Core: perform updates -----
async function updateGuildMappings(guildId) {
  const guild = bot.guilds.cache.get(guildId);
  if (!guild) return;

  const gcfg = getGuildCfg(guildId);
  if (!gcfg.entries.length) return;

  // Fetch all prices needed in bulk (dedupe)
  const idSet = new Set(gcfg.entries.map(e => e.coin.toLowerCase()));
  const idsCsv = [...idSet].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(idsCsv)}&vs_currencies=usd`;
  let prices = {};
  try {
    const res = await fetch(url);
    if (res.ok) prices = await res.json();
    else console.error('Bulk price fetch failed HTTP', res.status);
  } catch (e) {
    console.error('Bulk price fetch exception:', e.message);
  }

  for (const entry of gcfg.entries) {
    const { channelId, coin, label } = entry;
    const price = prices?.[coin]?.usd;
    if (typeof price !== 'number') {
      console.warn(`No price for ${coin}; skipping channel ${channelId}`);
      continue;
    }

    // Format price: commas, 2–6 decimals based on magnitude
    const formatted = formatUsd(price);
    const newName = `${label} - $${formatted}`;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      console.warn(`Channel ${channelId} not found; will keep config but cannot update.`);
      continue;
    }
    // Ensure we can rename it
    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      console.warn(`Missing Manage Channels permission in guild ${guildId}`);
      break;
    }
    // Discord channel name length cap (~100)
    const safeName = newName.slice(0, 95);
    try {
      await channel.setName(safeName);
      console.log(`✅ Updated ${channelId} -> ${safeName}`);
    } catch (e) {
      console.error(`Failed to rename channel ${channelId}:`, e.message);
    }
  }
}

function formatUsd(n) {
  if (n >= 1) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

// --------- Bot events --------------
bot.once('ready', async () => {
  console.log(`🤖 Logged in as ${bot.user.tag}`);
  try {
    await registerCommands(bot.user.id);
  } catch (e) {
    console.error('Slash command registration failed:', e);
  }

  // Start timers for all guilds the bot is in
  for (const [guildId] of bot.guilds.cache) {
    const gcfg = getGuildCfg(guildId);
    if (gcfg.running) startGuildTimer(guildId);
  }
});

bot.on('guildCreate', guild => {
  console.log(`➕ Added to guild ${guild.id}`);
  getGuildCfg(guild.id);
  startGuildTimer(guild.id);
});

bot.on('guildDelete', guild => {
  console.log(`➖ Removed from guild ${guild.id}`);
  stopGuildTimer(guild.id);
});

// --------- Interactions (slash cmds) -----------
bot.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { guild, commandName } = interaction;
  if (!guild) return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });

  // Permission check (manage guild)
  const member = await guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** permission to use this.', ephemeral: true });
  }

  const gcfg = getGuildCfg(guild.id);

  try {
    if (commandName === 'crypto-add') {
      const channel = interaction.options.getChannel('channel', true);
      const coin = interaction.options.getString('coin', true).toLowerCase().trim();
      const label = interaction.options.getString('label', true).trim();

      if (![ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice].includes(channel.type)) {
        return interaction.reply({ content: 'Choose a **voice or text** channel.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const ok = await validateCoinId(coin);
      if (!ok) {
        return interaction.editReply(`❌ Coin id \`${coin}\` not found on CoinGecko.\nTip: try lowercase ids like \`bitcoin\`, \`ethereum\`, \`binancecoin\`.`);
      }

      // Upsert mapping
      const existingIdx = gcfg.entries.findIndex(e => e.channelId === channel.id);
      const newEntry = { channelId: channel.id, coin, label };
      if (existingIdx >= 0) gcfg.entries[existingIdx] = newEntry;
      else gcfg.entries.push(newEntry);
      saveConfig(config);

      // Immediately update this channel
      const price = await fetchUsdPrice(coin);
      if (price !== null) {
        const preview = `${label} - $${formatUsd(price)}`.slice(0, 95);
        try {
          await channel.setName(preview);
        } catch (e) {
          // ignore rename error here; timer will retry
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('Crypto Channel Added')
        .setDescription(`This channel will be renamed periodically with **${coin}** price.`)
        .addFields(
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Coin', value: `\`${coin}\``, inline: true },
          { name: 'Label', value: `\`${label}\``, inline: true },
          { name: 'Interval', value: `${gcfg.intervalMinutes} min`, inline: true },
          { name: 'Status', value: gcfg.running ? 'Running ✅' : 'Stopped ⏹️', inline: true }
        )
        .setColor(0x00AAFF);
      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'crypto-remove') {
      const channel = interaction.options.getChannel('channel', true);
      const before = gcfg.entries.length;
      gcfg.entries = gcfg.entries.filter(e => e.channelId !== channel.id);
      saveConfig(config);
      const removed = before !== gcfg.entries.length;
      return interaction.reply({ content: removed ? `🗑️ Removed mapping for <#${channel.id}>.` : `No mapping found for <#${channel.id}>.`, ephemeral: true });
    }

    if (commandName === 'crypto-list') {
      if (!gcfg.entries.length) {
        return interaction.reply({ content: 'No crypto mappings yet. Use **/crypto-add** to create one.', ephemeral: true });
      }
      const lines = gcfg.entries.map((e, i) => `${i + 1}. <#${e.channelId}> → \`${e.coin}\` • label: \`${e.label}\``);
      const embed = new EmbedBuilder()
        .setTitle('Crypto Mappings')
        .setDescription(lines.join('\n'))
        .addFields(
          { name: 'Interval', value: `${gcfg.intervalMinutes} min`, inline: true },
          { name: 'Status', value: gcfg.running ? 'Running ✅' : 'Stopped ⏹️', inline: true }
        )
        .setColor(0x3A2CD6);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'crypto-interval') {
      const minutes = interaction.options.getInteger('minutes', true);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        return interaction.reply({ content: 'Interval must be between **1** and **1440** minutes.', ephemeral: true });
      }
      gcfg.intervalMinutes = minutes;
      saveConfig(config);
      if (gcfg.running) startGuildTimer(guild.id); // restart with new interval
      return interaction.reply({ content: `⏱️ Interval set to **${minutes}** minutes.`, ephemeral: true });
    }

    if (commandName === 'crypto-start') {
      if (gcfg.running) return interaction.reply({ content: 'Already running ✅', ephemeral: true });
      gcfg.running = true;
      saveConfig(config);
      startGuildTimer(guild.id);
      return interaction.reply({ content: 'Started crypto updates ✅', ephemeral: true });
    }

    if (commandName === 'crypto-stop') {
      if (!gcfg.running) return interaction.reply({ content: 'Already stopped ⏹️', ephemeral: true });
      gcfg.running = false;
      saveConfig(config);
      stopGuildTimer(guild.id);
      return interaction.reply({ content: 'Stopped crypto updates ⏹️', ephemeral: true });
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: 'Something went wrong while processing that command.' });
    } else {
      return interaction.reply({ content: 'Something went wrong while processing that command.', ephemeral: true });
    }
  }
});

// --------- Login -----------
bot.login(BOT_TOKEN);
