import { WebSocketServer } from 'ws';

const server = new WebSocketServer({ host: '127.0.0.1', port: 55263, maxPayload: 1024 });
server.on('listening', () => console.log('Диагностика слушает 127.0.0.1:55263. Остановка: Ctrl+C.'));
server.on('connection', (socket) => {
  console.log('Соединение открыто');
  let sequence = 0;
  const timer = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'probe', sequence: ++sequence }));
  }, 2000);
  socket.on('message', (data) => {
    try {
      const result = JSON.parse(data.toString());
      if (result.type === 'probe-result' && Number.isInteger(result.sequence) &&
          typeof result.session === 'string' && typeof result.fileKeyAvailable === 'boolean') {
        console.log(`Ответ ${result.sequence}: сессия ${result.session}, fileKey доступен: ${result.fileKeyAvailable}`);
      }
    } catch { console.error('Некорректный диагностический ответ'); }
  });
  socket.on('close', () => { clearInterval(timer); console.log('Соединение закрыто'); });
  socket.on('error', () => { clearInterval(timer); console.error('Ошибка соединения'); });
});


