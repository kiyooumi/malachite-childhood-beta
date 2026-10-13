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

// code -> { question, words: Map(word -> count), participants: Set(socketId), locked: bool }
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

function broadcastCloud(code) {
  const cloud = clouds.get(code);
  if (!cloud) return;
  io.emit('cloudUpdate', {
    code,
    words: serializeWords(cloud),
    participants: cloud.participants.size,
    totalWords: Array.from(cloud.words.values()).reduce((a, b) => a + b, 0),
    locked: cloud.locked
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

io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  // Ведущий создаёт облако
  socket.on('createCloud', (question) => {
    const q = String(question || '').trim() || 'Без вопроса';
    const code = generateCode();
    clouds.set(code, {
      question: q,
      words: new Map(),
      participants: new Set(),
      locked: false
    });
    socket.data.role = 'host';
    socket.data.code = code;
    console.log(`Облако ${code}: "${q}"`);
    socket.emit('cloudCreated', { code, question: q });
  });

  // Гость отправляет слово
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

    const finalKey = addWord(cloud, rawWord);
    if (!finalKey) return;

    cloud.participants.add(socket.id);
    socket.data.code = code;
    socket.data.role = 'guest';

    socket.emit('wordAccepted', { word: finalKey });
    broadcastCloud(code);
  });

  // Пульт ведущего
  socket.on('hostToggleLock', ({ code, locked }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.locked = !!locked;
    broadcastCloud(code);
    io.emit('hostState', { code, locked: cloud.locked });
  });

  socket.on('hostAddWord', ({ code, word }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    const finalKey = addWord(cloud, word);
    if (!finalKey) return;
    broadcastCloud(code);
  });

  socket.on('hostClear', ({ code }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    cloud.words.clear();
    cloud.participants.clear();
    broadcastCloud(code);
  });

  // НОВОЕ: Ведущий удаляет одно слово из облака (гость об этом не уведомляется)
  socket.on('hostRemoveWord', ({ code, word }) => {
    const cloud = clouds.get(code);
    if (!cloud) return;
    const target = String(word || '').trim();
    if (!target) return;

    let foundKey = null;
    for (const k of cloud.words.keys()) {
      if (k.toLowerCase() === target.toLowerCase()) { foundKey = k; break; }
    }
    if (!foundKey) return;

    cloud.words.delete(foundKey);
    broadcastCloud(code);
  });

  socket.on('disconnect', () => {
    for (const [code, cloud] of clouds.entries()) {
      if (cloud.participants.has(socket.id)) {
        cloud.participants.delete(socket.id);
        broadcastCloud(code);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
