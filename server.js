const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/guest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});

const clouds = new Map();

function generateCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (clouds.has(code));
  return code;
}

function serializeWords(cloud) {
  return Array.from(cloud.words.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

function stats(cloud) {
  return {
    participants: cloud.uniqueParticipants, // Отдаем исторический счетчик
    totalWords: Array.from(cloud.words.values()).reduce((a, b) => a + b, 0),
    locked: cloud.locked,
    uniqueWords: cloud.words.size,
    limitPerGuest: cloud.limitPerGuest,
    maxTotalWords: cloud.limitPerGuest > 0
      ? cloud.uniqueParticipants * cloud.limitPerGuest
      : null,
    theme: cloud.theme
  };
}

function broadcastCloud(code) {
  const cloud = clouds.get(code);
  if (!cloud) return;
  io.emit('cloudUpdate', {
    code,
    words: serializeWords(cloud),
    ...stats(cloud)
  });
}

function addWord(cloud, rawWord) {
  const cleaned = String(rawWord || '').trim();
  if (!cleaned) return null;
  const word = cleaned.split(/\s+/)[0].slice(0, 30);
  if (!word) return null;

  const lower = word.toLowerCase();
  let finalKey = word;
  for (const k of cloud.words.keys()) {
    if (k.toLowerCase() === lower) { finalKey = k; break; }
  }
  cloud.words.set(finalKey, (cloud.words.get(finalKey) || 0) + 1);
  return finalKey;
}

function guestUsed(cloud, socketId) {
  return cloud.guestCounts.get(socketId) || 0;
}

function sendQuota(socket, code) {
  const cloud = clouds.get(code);
  if (!cloud) return;
  socket.emit('quotaUpdate', {
    code,
    used: guestUsed(cloud, socket.id),
    limit: cloud.limitPerGuest,
    theme: cloud.theme,
    logo: cloud.logo
  });
}

io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  socket.on('createCloud', (question) => {
    const q = String(question || '').trim() || 'Без вопроса';
    const code = generateCode();
    clouds.set(code, {
      question: q,
      words: new Map(),
      participants: new Set(),
      guestCounts: new Map(),
      limitPerGuest: 0,
      locked: false,
      theme: 'default',
      logo: null,
      uniqueParticipants: 0 // Новое поле для исторического счетчика
    });
    socket.data.role = 'host';
    socket.data.code = code;
    console.log(`Облако ${code}: "${q}"`);
    socket.emit('cloudCreated', { code, question: q, theme: 'default', logo: null });
  });

  socket.on('submitWord', (payload) => {
    const code = String(payload?.code || '').trim();
    const rawWord = String(payload?.word || '').trim();
    if (!code || !rawWord) return;

    const cloud = clouds.get(code);
    if (!cloud) {
      socket.emit('errorMessage', { message: 'Комната не найдена' });
      return;
    }
    if (cloud.locked) {
      socket.emit('errorMessage', { message: 'Приём слов приостановлен' });
      return;
    }

    const used = guestUsed(cloud, socket.id);
    if (cloud.limitPerGuest > 0 && used >= cloud.limitPerGuest) {
      socket.emit('errorMessage', { message: `Лимит исчерпан: ${used} из ${cloud.limitPerGuest}` });
      sendQuota(socket, code);
      return;
    }

    const finalKey = addWord(cloud, rawWord);
    if (!finalKey) return;

    // Проверяем, новый ли это участник (исторически)
    const wasNewParticipant = !cloud.participants.has(socket.id);

    cloud.participants.add(socket.id);
    cloud.guestCounts.set(socket.id, used + 1);
    
    // Увеличиваем исторический счетчик, если человек пишет впервые
    if (wasNewParticipant) {
      cloud.uniqueParticipants++;
    }

    socket.data.code = code;
    socket.data.role = 'guest';

    socket.emit('wordAccepted', { word: finalKey, used: used + 1, limit: cloud.limitPerGuest });
    broadcastCloud(code);
  });

  socket.on('requestQuota', ({ code }) => {
    const c = String(code || '').trim();
    if (!c) return;
    sendQuota(socket, c);
  });

  socket.on('hostChangeTheme', ({ code, theme }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.theme = theme || 'default';
    io.emit('themeUpdate', { code, theme: cloud.theme });
  });

  socket.on('hostChangeLogo', ({ code, logo }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.logo = logo;
    io.emit('logoUpdate', { code, logo });
  });

  socket.on('hostToggleLock', ({ code, locked }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.locked = !!locked;
    broadcastCloud(code);
    io.emit('hostState', { code, locked: cloud.locked });
  });

  socket.on('hostSetLimit', ({ code, limit }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    let n = parseInt(limit, 10);
    if (isNaN(n) || n < 0) n = 0;
    if (n > 100) n = 100;
    cloud.limitPerGuest = n;
    broadcastCloud(code);
    for (const [id, s] of io.of('/').sockets) {
      if (s.data && s.data.code === code && s.data.role === 'guest') {
        sendQuota(s, code);
      }
    }
  });

  socket.on('hostAddWord', ({ code, word }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    const finalKey = addWord(cloud, word);
    if (!finalKey) return;
    broadcastCloud(code);
  });

  socket.on('hostRemoveWord', ({ code, word }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    const target = String(word || '');
    for (const k of Array.from(cloud.words.keys())) {
      if (k === target) { cloud.words.delete(k); break; }
    }
    broadcastCloud(code);
  });

  socket.on('hostDecrementWord', ({ code, word }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    const target = String(word || '');
    for (const k of Array.from(cloud.words.keys())) {
      if (k === target) {
        const c = cloud.words.get(k) || 0;
        if (c <= 1) cloud.words.delete(k);
        else cloud.words.set(k, c - 1);
        break;
      }
    }
    broadcastCloud(code);
  });

  socket.on('hostClear', ({ code }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.words.clear();
    cloud.participants.clear();
    cloud.guestCounts.clear();
    cloud.uniqueParticipants = 0; // Сбрасываем исторический счетчик
    broadcastCloud(code);
    for (const [id, s] of io.of('/').sockets) {
      if (s.data && s.data.code === code && s.data.role === 'guest') {
        sendQuota(s, code);
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [code, cloud] of clouds.entries()) {
      if (cloud.participants.has(socket.id)) {
        cloud.participants.delete(socket.id);
        // cloud.uniqueParticipants НЕ трогаем, он исторический
        broadcastCloud(code);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
