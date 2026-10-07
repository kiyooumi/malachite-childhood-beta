const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// облака хранятся в памяти: код -> { question, words: Map }
const clouds = new Map();

function generateCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (clouds.has(code));
  return code;
}

io.on('connection', (socket) => {
  // Ведущий создаёт облако
  socket.on('createCloud', (data) => {
    const question = String((data && data.question) || '').trim().slice(0, 300);
    if (!question) return;

    const code = generateCode();
    clouds.set(code, { question, words: new Map() });

    socket.emit('cloudCreated', { code, question });
  });

  // Гость отправляет слово
  socket.on('submitWord', (data) => {
    const code = String((data && data.code) || '').trim();
    const word = String((data && data.word) || '').trim().slice(0, 40);
    const cloud = clouds.get(code);

    if (!cloud || !word) return;

    const key = word.toLowerCase();
    cloud.words.set(key, (cloud.words.get(key) || 0) + 1);

    const words = Array.from(cloud.words.entries())
      .map(([w, count]) => ({ word: w, count }))
      .sort((a, b) => b.count - a.count);

    io.emit('cloudUpdate', { code, words });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
