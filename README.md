# Discord-Bot-Crypto-Prices-in-Channel
Discord bot that renames channels with live crypto prices. Admins can add/remove mappings, set intervals, and start/stop updates via slash commands. Built with discord.js v14 + CoinGecko.

# Crypto Channel Renamer Bot

A minimal Discord bot that **renames channels with live crypto prices** (e.g., `💲 BTC - $68,420.00`).  
Server admins manage everything with **slash commands**:

- `/crypto-add channel:<channel> coin:<coingecko-id> label:<text>`
- `/crypto-remove channel:<channel>`
- `/crypto-list`
- `/crypto-interval minutes:<number>`
- `/crypto-start`
- `/crypto-stop`

Powered by **discord.js v14** and **CoinGecko**.

---

## ✨ Features

- 🔁 Periodically updates selected channels with the latest **USD price**.
- 🧩 Works with **Text**, **Voice**, **Stage**, and **Announcement** channels.
- 🛡️ Admin-only commands (requires **Manage Server**).
- 🧠 Smart price formatting (2–6 decimals based on magnitude).
- 💾 Per-guild settings persisted to `config.json`.
- 🚦 Start/stop updates and change interval on the fly.

---

## 🛠️ Setup

### 1) Create your bot & token
1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application → Bot.
2. Enable **Server Members Intent** (not strictly required for this bot, but harmless).
3. Copy the **Bot Token**.

### 2) Clone & install
```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm i
