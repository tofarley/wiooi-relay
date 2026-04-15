const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Create HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: Object.keys(rooms).length,
      connections: wss ? wss.clients.size : 0,
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WIOOI Relay Server');
  }
});

const wss = new WebSocket.Server({ server: httpServer });

// Room management
const rooms = {}; // code -> { players: [ws1, ws2], battleConfig: null, state: 'waiting'|'playing' }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]); // Ensure unique
  return code;
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  
  // Notify remaining player
  room.players.forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
  });
  
  delete rooms[code];
  console.log(`Room ${code} cleaned up. Active rooms: ${Object.keys(rooms).length}`);
}

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerIndex = -1;
  
  console.log('New connection');
  
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }
    
    switch (msg.type) {
      case 'create_room': {
        const code = generateRoomCode();
        rooms[code] = {
          players: [ws, null],
          battleIndex: msg.battleIndex || 0,
          state: 'waiting',
          createdAt: Date.now(),
        };
        playerRoom = code;
        playerIndex = 0;
        ws.send(JSON.stringify({
          type: 'room_created',
          code: code,
          playerIndex: 0, // Host is player 0 (player 1 in game terms)
        }));
        console.log(`Room ${code} created. Active rooms: ${Object.keys(rooms).length}`);
        break;
      }
      
      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms[code];
        
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        if (room.state !== 'waiting') {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          return;
        }
        if (room.players[1] !== null) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          return;
        }
        
        room.players[1] = ws;
        room.state = 'playing';
        playerRoom = code;
        playerIndex = 1;
        
        // Tell joiner their index and battle config
        ws.send(JSON.stringify({
          type: 'room_joined',
          code: code,
          playerIndex: 1,
          battleIndex: room.battleIndex,
        }));
        
        // Tell host the game is starting
        if (room.players[0] && room.players[0].readyState === WebSocket.OPEN) {
          room.players[0].send(JSON.stringify({
            type: 'game_start',
            opponentConnected: true,
          }));
        }
        
        console.log(`Room ${code} is now full. Game starting.`);
        break;
      }
      
      case 'action': {
        // Relay game action to the opponent
        if (!playerRoom || !rooms[playerRoom]) return;
        const room = rooms[playerRoom];
        const opponentIndex = playerIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          // Forward the action with the sender's player index
          opponent.send(JSON.stringify({
            type: 'action',
            playerIndex: playerIndex,
            data: msg.data,
          }));
        }
        break;
      }
      
      case 'chat': {
        // Relay chat message to opponent
        if (!playerRoom || !rooms[playerRoom]) return;
        const room = rooms[playerRoom];
        const opponentIndex = playerIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        
        if (opponent && opponent.readyState === WebSocket.OPEN) {
          opponent.send(JSON.stringify({
            type: 'chat',
            playerIndex: playerIndex,
            message: msg.message,
          }));
        }
        break;
      }
      
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
      
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type: ' + msg.type }));
    }
  });
  
  ws.on('close', () => {
    console.log('Connection closed');
    if (playerRoom && rooms[playerRoom]) {
      const room = rooms[playerRoom];
      room.players[playerIndex] = null;
      
      // If both players gone, clean up
      if (!room.players[0] && !room.players[1]) {
        cleanupRoom(playerRoom);
      } else {
        // Notify remaining player
        const otherIndex = playerIndex === 0 ? 1 : 0;
        const other = room.players[otherIndex];
        if (other && other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'opponent_disconnected' }));
        }
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Cleanup stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 60 * 60 * 1000; // 1 hour
  for (const code in rooms) {
    if (now - rooms[code].createdAt > staleThreshold) {
      console.log(`Cleaning stale room ${code}`);
      cleanupRoom(code);
    }
  }
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`WIOOI Relay Server listening on port ${PORT}`);
});
