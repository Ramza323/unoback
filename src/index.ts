import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { buildDeck, drawCards } from './Deck';
import { canPlay, canSteal, canRespondToPenalty, getPenaltyAddition, isDefenseCard, nextPlayerIndex } from './RuleEngine';
import {
  createRoom, getRoom, joinRoom, markDisconnected,
  advanceIndexAfterDisconnect, getRoomByPlayer, sanitizeRoom, cleanupStaleDisconnects
} from './RoomManager';
import { Card, Color, GameState, Room } from './types';

export const VERSION = '1.0.0';

const app = express();
app.use(cors());
app.get('/', (_, res) => res.send('UNO server running'));
app.get('/version', (_, res) => res.json({ version: VERSION }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const STEAL_WINDOW_MS = 1500;
const stealTimers = new Map<string, ReturnType<typeof setTimeout>>();

function broadcast(room: Room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('room-updated', sanitizeRoom(room, p.id));
  }
}

function closeStealWindow(roomId: string) {
  const timer = stealTimers.get(roomId);
  if (timer) { clearTimeout(timer); stealTimers.delete(roomId); }
  const room = getRoom(roomId);
  if (!room?.game) return;
  room.game.stealWindow = null;
  io.to(roomId).emit('steal-window-closed');
}

function openStealWindow(room: Room, card: Card, byPlayerIndex: number) {
  if (!room.game) return;
  closeStealWindow(room.id);
  room.game.stealWindow = { card, byPlayerIndex, expiresAt: Date.now() + STEAL_WINDOW_MS };
  io.to(room.id).emit('steal-window-open', { card, ms: STEAL_WINDOW_MS });
  const timer = setTimeout(() => {
    closeStealWindow(room.id);
    broadcast(room);
  }, STEAL_WINDOW_MS);
  stealTimers.set(room.id, timer);
}

function checkOnlyOneLeft(room: Room): boolean {
  if (!room.game || room.game.winner) return false;
  const connected = room.players.filter(p => p.connected);
  if (connected.length === 1) {
    room.game.winner = connected[0].id;
    room.game.started = false;
    closeStealWindow(room.id);
    return true;
  }
  return false;
}

function applyCardEffect(room: Room, card: Card, playedByIndex: number, declaredColor?: Color) {
  const game = room.game!;
  const players = room.players;

  if (card.value === 'wild' || card.value === 'wild4') {
    if (declaredColor) {
      card.color = declaredColor;
      game.declaredColor = declaredColor;
    }
  } else {
    game.declaredColor = null;
  }

  if (game.penalty) {
    const addition = getPenaltyAddition(card);
    if (addition > 0) {
      game.penalty.amount += addition;
      game.penalty.color = card.value === 'wild4' ? (declaredColor ?? card.color) : card.color;
      game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
      return;
    }
    if (isDefenseCard(card)) {
      game.penalty.color = card.color;
      if (card.value === 'skip') {
        // Bloqueo: penalidad pasa al siguiente jugador (1 salto)
        game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
        io.to(room.id).emit('penalty-deflected', { type: 'block', amount: game.penalty.amount });
        return;
      }
      if (card.value === 'reverse') {
        // Reversa: penalidad vuelve al anterior e invierte dirección
        game.direction = game.direction === 1 ? -1 : 1;
        const target = nextPlayerIndex(playedByIndex, players, game.direction);
        game.currentPlayerIndex = target;
        io.to(room.id).emit('penalty-deflected', { type: 'reverse', amount: game.penalty.amount });
        return;
      }
    }
  }

  if (card.value === 'draw2') {
    game.penalty = { amount: 2, color: card.color };
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
    return;
  }
  if (card.value === 'wild4') {
    game.penalty = { amount: 4, color: declaredColor ?? card.color };
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
    return;
  }
  if (card.value === 'skip') {
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction, true);
    return;
  }
  if (card.value === 'reverse') {
    const connected = players.filter(p => p.connected).length;
    if (connected === 2) {
      game.currentPlayerIndex = playedByIndex;
    } else {
      game.direction = game.direction === 1 ? -1 : 1;
      game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
    }
    return;
  }
  game.currentPlayerIndex = nextPlayerIndex(playedByIndex, players, game.direction);
}

function checkUno(room: Room, playerIndex: number) {
  const player = room.players[playerIndex];
  if (player.hand.length === 1 && !player.saidUno) {
    const { drawn, deck, discardPile } = drawCards(room.game!.deck, room.game!.discardPile, 2);
    player.hand.push(...drawn);
    room.game!.deck = deck;
    room.game!.discardPile = discardPile;
    io.to(room.id).emit('uno-penalty', { playerId: player.id, playerName: player.name });
  }
  player.saidUno = false;
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('create-room', ({ name }: { name: string }) => {
    const room = createRoom(socket.id, name || 'Jugador');
    socket.join(room.id);
    socket.emit('room-joined', sanitizeRoom(room, socket.id));
  });

  socket.on('join-room', ({ roomId, name }: { roomId: string; name: string }) => {
    const result = joinRoom(roomId.toUpperCase(), socket.id, name || 'Jugador');
    if (result === 'not_found') { socket.emit('error', { msg: 'Sala no encontrada' }); return; }
    if (result === 'full') { socket.emit('error', { msg: 'Sala llena (máx 8)' }); return; }
    if (result === 'started') { socket.emit('error', { msg: 'La partida ya empezó' }); return; }
    const room = result;
    socket.join(room.id);
    socket.emit('room-joined', sanitizeRoom(room, socket.id));
    broadcast(room);
  });

  // Reconexión: el cliente envía su nombre y el roomId guardado
  socket.on('rejoin-room', ({ roomId, name }: { roomId: string; name: string }) => {
    const result = joinRoom(roomId.toUpperCase(), socket.id, name || 'Jugador');
    if (typeof result === 'string') {
      socket.emit('rejoin-failed', { msg: result });
      return;
    }
    const room = result;
    socket.join(room.id);
    socket.emit('room-joined', sanitizeRoom(room, socket.id));
    broadcast(room);
    io.to(room.id).emit('player-reconnected', { name });
  });

  socket.on('change-name', ({ name }: { name: string }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && !room.game?.started) player.name = name.trim().slice(0, 20) || player.name;
    broadcast(room);
  });

  socket.on('toggle-ready', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.game?.started) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isReady = !player.isReady;
    broadcast(room);
  });

  socket.on('start-game', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('error', { msg: 'Solo el host puede iniciar' }); return; }
    const connected = room.players.filter(p => p.connected);
    if (connected.length < 2) { socket.emit('error', { msg: 'Se necesitan al menos 2 jugadores' }); return; }

    const deck = buildDeck();
    room.players.forEach(p => { p.hand = p.connected ? deck.splice(0, 7) : []; p.saidUno = false; });

    let startCard = deck.splice(0, 1)[0];
    while (startCard.value === 'wild' || startCard.value === 'wild4') {
      deck.push(startCard);
      startCard = deck.splice(0, 1)[0];
    }

    room.game = {
      deck,
      discardPile: [startCard],
      currentPlayerIndex: 0,
      direction: 1,
      penalty: null,
      declaredColor: null,
      stealWindow: null,
      started: true,
      winner: null,
    };

    // Asegurar que el primer turno sea de un jugador conectado
    if (!room.players[0]?.connected) {
      room.game.currentPlayerIndex = nextPlayerIndex(-1, room.players, 1);
    }

    broadcast(room);
  });

  socket.on('play-card', ({ cardId, declaredColor }: { cardId: string; declaredColor?: Color }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room?.game) return;
    const game = room.game;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== game.currentPlayerIndex) { socket.emit('error', { msg: 'No es tu turno' }); return; }

    const player = room.players[playerIndex];
    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) { socket.emit('error', { msg: 'Carta no encontrada' }); return; }

    const card = player.hand[cardIdx];
    const topCard = game.discardPile[game.discardPile.length - 1];

    if (!canPlay(card, topCard, game.penalty, game.declaredColor)) {
      socket.emit('error', { msg: 'Jugada no válida' }); return;
    }

    player.hand.splice(cardIdx, 1);
    game.discardPile.push(card);

    // Verificar victoria ANTES de checkUno
    if (player.hand.length === 0) {
      game.winner = player.id;
      game.started = false;
      closeStealWindow(room.id);
      broadcast(room);
      return;
    }

    checkUno(room, playerIndex);
    closeStealWindow(room.id);
    applyCardEffect(room, card, playerIndex, declaredColor);
    openStealWindow(room, card, playerIndex);
    broadcast(room);
  });

  socket.on('steal-card', ({ cardId, declaredColor }: { cardId: string; declaredColor?: Color }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room?.game) return;
    const game = room.game;
    const stealerIndex = room.players.findIndex(p => p.id === socket.id);
    if (stealerIndex === -1 || !game.stealWindow) return;
    // No puede robar el jugador que acaba de jugar
    if (stealerIndex === game.stealWindow.byPlayerIndex) return;

    const stealer = room.players[stealerIndex];
    const cardIdx = stealer.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const card = stealer.hand[cardIdx];
    const lastCard = game.stealWindow.card;

    if (!canSteal(card, lastCard, game.declaredColor, game.penalty)) {
      socket.emit('error', { msg: 'No puedes robar turno con esa carta' }); return;
    }

    stealer.hand.splice(cardIdx, 1);
    game.discardPile.push(card);
    closeStealWindow(room.id);

    if (stealer.hand.length === 0) {
      game.winner = stealer.id;
      game.started = false;
      broadcast(room);
      return;
    }

    checkUno(room, stealerIndex);
    applyCardEffect(room, card, stealerIndex, declaredColor);
    io.to(room.id).emit('turn-stolen', { byPlayerId: socket.id, byPlayerName: stealer.name });
    openStealWindow(room, card, stealerIndex);
    broadcast(room);
  });

  socket.on('draw-card', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room?.game) return;
    const game = room.game;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== game.currentPlayerIndex) return;

    closeStealWindow(room.id);

    const count = game.penalty ? game.penalty.amount : 1;
    const { drawn, deck, discardPile } = drawCards(game.deck, game.discardPile, count);
    room.players[playerIndex].hand.push(...drawn);
    game.deck = deck;
    game.discardPile = discardPile;
    game.penalty = null;
    game.currentPlayerIndex = nextPlayerIndex(playerIndex, room.players, game.direction);
    broadcast(room);
  });

  socket.on('say-uno', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.saidUno = true;
  });

  socket.on('force-end-game', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id || !room.game) return;
    closeStealWindow(room.id);
    room.game = null;
    room.players.forEach(p => { p.hand = []; p.isReady = false; p.saidUno = false; });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    console.log('disconnected', socket.id);
    const result = markDisconnected(socket.id);
    if (!result) return;
    const { room, playerIdx } = result;

    if (playerIdx === -1) {
      // Fue removido directo (lobby)
      broadcast(room);
      return;
    }

    // Durante partida
    if (room.game) {
      closeStealWindow(room.id);
      // Limpiar penalty si era el turno del jugador penalizado
      if (playerIdx === room.game.currentPlayerIndex && room.game.penalty) {
        room.game.penalty = null;
      }
      // Ajustar turno
      advanceIndexAfterDisconnect(room, playerIdx);
      // Verificar si solo queda uno conectado
      if (!checkOnlyOneLeft(room)) {
        // Si el nuevo currentPlayerIndex es el jugador desconectado, avanzar
        const curr = room.players[room.game.currentPlayerIndex];
        if (curr && !curr.connected) {
          room.game.currentPlayerIndex = nextPlayerIndex(
            room.game.currentPlayerIndex, room.players, room.game.direction
          );
        }
      }
    }

    io.to(room.id).emit('player-disconnected', {
      name: room.players.find((_, i) => i === playerIdx)?.name ?? 'Jugador',
    });
    broadcast(room);
  });
});

setInterval(cleanupStaleDisconnects, 10_000);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`UNO server on port ${PORT}`));
