const WebSocket = require('ws');

// Параметры запуска
const args = process.argv.slice(2);
const host = args[0] || 'localhost';
const port = parseInt(args[1]) || 8080;

// Максимальное количество игроков в одной комнате
const MAX_PLAYERS_PER_ROOM = 30;

// Создание сервера
const wss = new WebSocket.Server({ host, port });

// Хранилище комнат: roomName → массив клиентов
const rooms = {};
let clientIdCounter = 0;

// Вспомогательная функция отправки JSON
function sendJSON(ws, type, payload = {}) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

// Логирование только в консоль
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

// ======================== Основная логика ========================

wss.on('connection', (ws) => {
    const clientId = ++clientIdCounter;
    ws.clientData = { id: clientId, room: null };

    log(`Клиент ${clientId} подключился`);

    sendJSON(ws, 'id', { id: clientId });

    // Таймер лобби
    const lobbyInterval = setInterval(() => {
        if (!ws.clientData.room && ws.readyState === WebSocket.OPEN) {
            sendJSON(ws, 'lobby');
        }
    }, 1000);

    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            log(`Клиент ${clientId}: ошибка парсинга JSON`);
            sendJSON(ws, 'error', { message: 'Invalid JSON format' });
            return;
        }

        const { type, room, content, targetId } = message;

        switch (type) {
            case 'roomlist':
                const roomList = Object.entries(rooms).map(([name, clients]) => ({
                    name,
                    users: clients.length
                }));
                sendJSON(ws, 'roomlist', { rooms: roomList });
                break;

            case 'join':
                if (ws.clientData.room) {
                    sendJSON(ws, 'error', { message: 'You are already in a room' });
                    return;
                }
                if (!room || typeof room !== 'string' || room.trim() === '') {
                    sendJSON(ws, 'error', { message: 'Room name is required and cannot be empty' });
                    return;
                }

                const roomName = room.trim();

                // Проверка на максимальное количество игроков
                if (rooms[roomName] && rooms[roomName].length >= MAX_PLAYERS_PER_ROOM) {
                    sendJSON(ws, 'error', { 
                        message: `Room "${roomName}" is full. Maximum ${MAX_PLAYERS_PER_ROOM} players allowed.` 
                    });
                    return;
                }

                if (!rooms[roomName]) {
                    rooms[roomName] = [];
                }

                rooms[roomName].push(ws);
                ws.clientData.room = roomName;

                log(`Клиент ${clientId} присоединился к комнате: ${roomName} (${rooms[roomName].length}/${MAX_PLAYERS_PER_ROOM})`);

                // Уведомляем всех в комнате о новом игроке
                broadcastToRoom(roomName, 'joined', { id: clientId });
                break;

            case 'leave':
                if (!ws.clientData.room) {
                    sendJSON(ws, 'error', { message: 'You are not in any room' });
                    return;
                }

                const currentRoom = ws.clientData.room;
                removeFromRoom(ws, currentRoom);
                ws.clientData.room = null;
                sendJSON(ws, 'left');
                break;

            case 'toall':
                if (!ws.clientData.room) {
                    sendJSON(ws, 'error', { message: 'You must be in a room to send message' });
                    return;
                }
                if (typeof content !== 'string' || content.trim() === '') {
                    sendJSON(ws, 'error', { message: 'Message content cannot be empty' });
                    return;
                }

                broadcastToRoom(ws.clientData.room, 'event', {
                    from: clientId,
                    content: content
                });
                break;

            case 'toclient':
                if (typeof targetId !== 'number' || typeof content !== 'string' || content.trim() === '') {
                    sendJSON(ws, 'error', { message: 'Invalid targetId or empty content' });
                    return;
                }

                sendToClient(targetId, 'event', {
                    from: clientId,
                    content: content
                });
                break;

            case 'toother':
                if (!ws.clientData.room) {
                    sendJSON(ws, 'error', { message: 'You must be in a room' });
                    return;
                }
                if (typeof content !== 'string' || content.trim() === '') {
                    sendJSON(ws, 'error', { message: 'Message content cannot be empty' });
                    return;
                }

                broadcastToRoomExcept(ws.clientData.room, clientId, 'event', {
                    from: clientId,
                    content: content
                });
                break;

            case 'ping':
                sendJSON(ws, 'pong');
                break;

            default:
                sendJSON(ws, 'error', { message: `Unknown command: ${type}` });
        }
    });

    ws.on('close', () => {
        log(`Клиент ${clientId} отключился`);
        clearInterval(lobbyInterval);

        if (ws.clientData.room) {
            removeFromRoom(ws, ws.clientData.room);
        }
    });

    ws.on('error', (err) => {
        log(`Ошибка у клиента ${clientId}: ${err.message}`);
    });
});

// ======================== Вспомогательные функции ========================

function removeFromRoom(ws, roomName) {
    if (!rooms[roomName]) return;

    const wasInRoom = rooms[roomName].includes(ws);
    rooms[roomName] = rooms[roomName].filter(client => client !== ws);

    if (wasInRoom) {
        broadcastToRoom(roomName, 'leaved', { id: ws.clientData.id });
        log(`Клиент ${ws.clientData.id} покинул комнату "${roomName}"`);
    }

    if (rooms[roomName].length === 0) {
        delete rooms[roomName];
        log(`Комната "${roomName}" удалена (стала пустой)`);
    }
}

function broadcastToRoom(roomName, type, payload = {}) {
    if (!rooms[roomName]) return;
    rooms[roomName].forEach(client => {
        sendJSON(client, type, payload);
    });
}

function broadcastToRoomExcept(roomName, excludeId, type, payload = {}) {
    if (!rooms[roomName]) return;
    rooms[roomName].forEach(client => {
        if (client.clientData.id !== excludeId) {
            sendJSON(client, type, payload);
        }
    });
}

function sendToClient(targetId, type, payload = {}) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN &&
            client.clientData &&
            client.clientData.id === targetId) {
            sendJSON(client, type, payload);
        }
    });
}

// Запуск сервера
wss.on('listening', () => {
    log(`WebSocket сервер запущен на ws://${host}:${port}`);
    log(`Ограничение: максимум ${MAX_PLAYERS_PER_ROOM} игроков в одной комнате`);
});

console.log(`Сервер запускается на ws://${host}:${port}...`);