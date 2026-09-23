const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const mcProtocol = require('minecraft-protocol');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));


// Store all active bots: botId -> { id, config, bot, status, logs: [] }
const botSessions = new Map();

function sendLog(botId, type, text, rawJson = null) {
  const timestamp = new Date().toLocaleTimeString();
  const logItem = {
    botId,
    type,
    text,
    rawJson,
    time: timestamp
  };

  const session = botSessions.get(botId);
  if (session) {
    session.logs.push(logItem);
    if (session.logs.length > 500) session.logs.shift(); // keep last 500 lines per bot
  }

  io.emit('console-log', logItem);
}

function updateTabList(botId, bot) {
  if (!bot || !bot.players) return;
  const list = Object.keys(bot.players).map(name => {
    const p = bot.players[name];
    return {
      username: p.username,
      displayName: p.displayName ? p.displayName.toString() : p.username,
      ping: p.ping || 0
    };
  });

  const session = botSessions.get(botId);
  if (session) {
    session.status.players = list;
    io.emit('tab-list', { botId, players: list });
  }
}

function setupBotListeners(botId, bot) {
  const session = botSessions.get(botId);
  if (!session) return;

  bot.on('login', () => {
    session.status.connected = true;
    session.status.connecting = false;
    io.emit('bot-status', { botId, status: session.status });
    sendLog(botId, 'system', `[${session.config.username}] Connected to ${session.config.host}:${session.config.port}!`);
  });

  bot.on('spawn', () => {
    session.status.spawned = true;
    io.emit('bot-status', { botId, status: session.status });
    sendLog(botId, 'system', `[${session.config.username}] Successfully spawned in world!`);
    updateTabList(botId, bot);
  });

  bot.on('message', (jsonMsg, position) => {
    try {
      const cleanText = jsonMsg.toString();
      if (!cleanText.trim()) return;

      let htmlFormatted = null;
      if (typeof jsonMsg.toHTML === 'function') {
        htmlFormatted = jsonMsg.toHTML();
      }

      sendLog(botId, 'chat', cleanText, {
        html: htmlFormatted,
        json: jsonMsg.json
      });
    } catch (e) {
      sendLog(botId, 'chat', jsonMsg.toString());
    }
  });

  bot.on('health', () => {
    session.status.health = Math.round(bot.health);
    session.status.food = Math.round(bot.food);
    io.emit('bot-stats', {
      botId,
      health: session.status.health,
      food: session.status.food
    });
  });

  bot.on('move', () => {
    if (bot.entity && bot.entity.position) {
      session.status.position = {
        x: bot.entity.position.x.toFixed(1),
        y: bot.entity.position.y.toFixed(1),
        z: bot.entity.position.z.toFixed(1)
      };
      io.emit('bot-pos', {
        botId,
        position: session.status.position
      });
    }
  });

  bot.on('playerJoined', () => updateTabList(botId, bot));
  bot.on('playerLeft', () => updateTabList(botId, bot));

  bot.once('login', () => {
    try {
      if (bot._client) {
        // MCC Protocol18: Send vanilla client settings
        bot._client.write('settings', {
          locale: 'en_US',
          viewDistance: 10,
          chatFlags: 0,
          chatColors: true,
          skinParts: 127
        });

        // MCC Protocol18: Send vanilla client brand
        bot._client.write('custom_payload', {
          channel: 'MC|Brand',
          data: Buffer.from('\x07vanilla')
        });

        // MCC Protocol18: Auto-respond to server/proxy transaction confirmation packets (anti-cheat verification)
        bot._client.on('transaction', (packet) => {
          try {
            bot._client.write('transaction', {
              windowId: packet.windowId,
              action: packet.action,
              accepted: true
            });
          } catch (e) {}
        });
      }
    } catch (e) {}
  });

  bot.on('kicked', (reason) => {
    let reasonText = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    sendLog(botId, 'error', `[${session.config.username}] Kicked: ${reasonText}`);
    cleanupBot(botId);

    // MCC Auto-reconnect: if proxy issues anti-bot verification challenge ("try again in a few seconds")
    const lower = reasonText.toLowerCase();
    if (lower.includes('try again in a few seconds') || lower.includes('failed to connect to the server')) {
      if (!session._challengeRetrying) {
        session._challengeRetrying = true;
        sendLog(botId, 'system', `Proxy verification challenge detected. Automatically reconnecting in 3.5 seconds to pass anti-bot check...`);
        setTimeout(() => {
          session._challengeRetrying = false;
          if (!session.status.connected) {
            startBotSession(session.config, botId);
          }
        }, 3500);
      }
    }
  });

  bot.on('error', (err) => {
    sendLog(botId, 'error', `[${session.config.username}] Error: ${err.message || err}`);
  });

  bot.on('end', (reason) => {
    sendLog(botId, 'system', `[${session.config.username}] Disconnected: ${reason || 'Connection closed'}`);
    cleanupBot(botId);
  });
}

function cleanupBot(botId) {
  const session = botSessions.get(botId);
  if (!session) return;

  session.status.connected = false;
  session.status.connecting = false;
  session.status.spawned = false;
  session.status.players = [];

  io.emit('bot-status', { botId, status: session.status });

  if (session.bot) {
    try {
      session.bot.removeAllListeners();
    } catch (e) {}
    session.bot = null;
  }
}

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'iberian123';

io.use((socket, next) => {
  const pwd = socket.handshake.auth && socket.handshake.auth.password;
  if (!pwd || pwd !== ACCESS_PASSWORD) {
    return next(new Error('Unauthorized: Incorrect password'));
  }
  next();
});

function startBotSession(config, targetId = null) {
  const host = config.host ? config.host.trim() : 'localhost';
  const port = parseInt(config.port) || 25565;
  const username = config.username ? config.username.trim() : `Cracked_${Math.floor(1000 + Math.random() * 9000)}`;
  const auth = config.auth === 'microsoft' ? 'microsoft' : 'offline';
  const version = config.version && config.version.trim() !== '' ? config.version.trim() : '1.8.9';
  const botId = targetId || config.id || crypto.randomUUID();

  let session = botSessions.get(botId);
  if (session && session.bot && session.status.connected) {
    return;
  }

  const sessionData = {
    id: botId,
    config: { host, port, username, auth, version },
    bot: null,
    status: {
      connected: false,
      connecting: true,
      spawned: false,
      server: `${host}:${port}`,
      username: username,
      auth: auth,
      version: version,
      health: 20,
      food: 20,
      position: { x: 0, y: 0, z: 0 },
      players: []
    },
    logs: session ? session.logs : []
  };

  botSessions.set(botId, sessionData);
  io.emit('session-created', {
    id: botId,
    config: sessionData.config,
    status: sessionData.status
  });

  sendLog(botId, 'system', `Connecting to ${host}:${port} as "${username}" (Minecraft ${version}, Auth: ${auth})...`);

  const botOptions = {
    host,
    port,
    username,
    auth,
    version: (version && version !== 'auto') ? version : false,
    hideErrors: false,
    checkTimeoutInterval: 60 * 1000,
    brand: 'vanilla'
  };

  if (auth === 'microsoft') {
    botOptions.onMsaCode = (data) => {
      io.emit('msa-code', {
        botId,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        message: data.message
      });
      sendLog(botId, 'system', `[AUTH] Microsoft Login: visit ${data.verification_uri} and enter: ${data.user_code}`);
    };
  }

  function launchBot() {
    try {
      const bot = mineflayer.createBot(botOptions);
      sessionData.bot = bot;
      setupBotListeners(botId, bot);
    } catch (err) {
      sessionData.status.connecting = false;
      io.emit('bot-status', { botId, status: sessionData.status });
      sendLog(botId, 'error', `Failed to initialize bot: ${err.message}`);
    }
  }

  mcProtocol.ping({ host, port }, () => {
    launchBot();
  });
}

io.on('connection', (socket) => {
  // Send list of all existing sessions to newly connected client
  const sessionsSummary = [];
  for (const [id, s] of botSessions.entries()) {
    sessionsSummary.push({
      id,
      config: s.config,
      status: s.status,
      logs: s.logs.slice(-100)
    });
  }
  socket.emit('init-sessions', sessionsSummary);

  // Add / Connect Bot
  socket.on('start-bot', (config) => {
    startBotSession(config);
  });

  // Send message / command to a bot or all bots
  socket.on('send-chat', (data) => {
    const { botId, message } = data;
    if (!message || !message.trim()) return;

    if (botId === 'all') {
      // Broadcast to all connected bots
      let count = 0;
      for (const [id, session] of botSessions.entries()) {
        if (session.bot && session.status.connected) {
          try {
            session.bot.chat(message.trim());
            sendLog(id, 'sent', `[ALL -> ${session.config.username}] ${message.trim()}`);
            count++;
          } catch (e) {}
        }
      }
      if (count === 0) {
        socket.emit('console-log', {
          botId: 'all',
          type: 'error',
          text: 'No bots are currently connected to send messages to.',
          time: new Date().toLocaleTimeString()
        });
      }
      return;
    }

    const session = botSessions.get(botId);
    if (!session || !session.bot || !session.status.connected) {
      socket.emit('console-log', {
        botId,
        type: 'error',
        text: 'Selected bot is not connected to a server.',
        time: new Date().toLocaleTimeString()
      });
      return;
    }

    try {
      session.bot.chat(message.trim());
      sendLog(botId, 'sent', `[YOU] ${message.trim()}`);
    } catch (err) {
      sendLog(botId, 'error', `Failed to send command: ${err.message}`);
    }
  });

  // Disconnect bot
  socket.on('disconnect-bot', ({ botId }) => {
    const session = botSessions.get(botId);
    if (!session || !session.bot) return;

    sendLog(botId, 'system', `Disconnecting ${session.config.username}...`);
    try {
      session.bot.quit('User disconnected');
    } catch (e) {}
    cleanupBot(botId);
  });

  // Remove bot session
  socket.on('remove-bot', ({ botId }) => {
    const session = botSessions.get(botId);
    if (session) {
      if (session.bot) {
        try { session.bot.quit('Bot removed'); } catch (e) {}
        cleanupBot(botId);
      }
      botSessions.delete(botId);
      io.emit('session-removed', { botId });
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Minecraft Multi-Account Web Console Client running at http://${HOST}:${PORT}`);
});

