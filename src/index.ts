import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { buildDeck, drawCards } from './Deck';
import { canPlay, canSteal, getPenaltyAddition, isDefenseCard, nextPlayerIndex } from './RuleEngine';
import {
  createRoom, getRoom, joinRoom, removePlayer,
  getRoomByPlayer, sanitizeRoom
} from './RoomManager';
import { Card, Color, GameState, Room } from './types';

const app = express();
app.use(cors());
app.get('/', (_, res) => res.send('UNO server running'));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const STEAL_WINDOW_MS = 1500;
const stealTimers = new Map<string, ReturnType<typeof setTimeout>>();

function broadcast(room: Room) {
  for (const p of room.players) {
    const socket = io.sockets.sockets.get(p.id);
    if (socket) socket.emit('room-updated', sanitizeRoom(room, p.id));
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

function applyCardEffect(room: Room, card: Card, playedByIndex: number, declaredColor?: Color) {
  const game = room.game!;
  const total = room.players.length;

  if (card.value === 'wild' || card.value === 'wild4') {
    if (declaredColor) card.color = declaredColor;
  }

  if (game.penalty) {
    const addition = getPenaltyAddition(card);
    if (addition > 0) {
      game.penalty.amount += addition;
      if (card.value === 'wild4' && declaredColor) game.penalty.color = declaredColor;
      game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction);
      return;
    }
    if (isDefenseCard(card)) {
      if (card.value === 'skip') {
        // bloqueo: penalty jumps to the next player
        game.penalty.color = card.color;
        const skipped = nextPlayerIndex(playedByIndex, total, game.direction);
        game.currentPlayerIndex = nextPlayerIndex(skipped, total, game.direction);
        io.to(room.id).emit('penalty-deflected', { type: 'block', amount: game.penalty.amount });
        return;
      }
      if (card.value === 'reverse') {
        // reversa: penalty goes back to previous
        game.direction = game.direction === 1 ? -1 : 1;
        const target = nextPlayerIndex(playedByIndex, total, game.direction);
        game.penalty.color = card.color;
        game.currentPlayerIndex = target;
        io.to(room.id).emit('penalty-deflected', { type: 'reverse', amount: game.penalty.amount });
        return;
      }
    }
  }

  if (card.value === 'draw2') {
    game.penalty = { amount: 2, color: card.color };
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction);
    return;
  }
  if (card.value === 'wild4') {
    game.penalty = { amount: 4, color: declaredColor ?? card.color };
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction);
    return;
  }
  if (card.value === 'skip') {
    game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction, true);
    return;
  }
  if (card.value === 'reverse') {
    if (total === 2) {
      game.currentPlayerIndex = playedByIndex;
    } else {
      game.direction = game.direction === 1 ? -1 : 1;
      game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction);
    }
    return;
  }
  game.currentPlayerIndex = nextPlayerIndex(playedByIndex, total, game.direction);
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
    const room = joinRoom(roomId.toUpperCase(), socket.id, name || 'Jugador');
    if (!room) { socket.emit('error', { msg: 'Sala no encontrada o llena' }); return; }
    socket.join(room.id);
    broadcast(room);
    socket.emit('room-joined', sanitizeRoom(room, socket.id));
  });

  socket.on('change-name', ({ name }: { name: string }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.name = name.trim().slice(0, 20) || player.name;
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
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error', { msg: 'Se necesitan al menos 2 jugadores' }); return; }

    const deck = buildDeck();
    room.players.forEach(p => { p.hand = deck.splice(0, 7); p.saidUno = false; });

    // First face-up card must not be Wild/Wild4
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
      stealWindow: null,
      started: true,
      winner: null,
    };

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

    if (!canPlay(card, topCard, game.penalty, game.discardPile.length > 1 ? undefined : undefined)) {
      socket.emit('error', { msg: 'Jugada no válida' }); return;
    }

    if (game.penalty && getPenaltyAddition(card) === 0 && !isDefenseCard(card)) {
      // Must draw penalty instead
      socket.emit('error', { msg: 'Debes responder al acumulado o robar' }); return;
    }

    player.hand.splice(cardIdx, 1);

    if (game.penalty && getPenaltyAddition(card) === 0 && !isDefenseCard(card)) {
      socket.emit('error', { msg: 'Jugada inválida contra el acumulado' }); return;
    }

    game.discardPile.push(card);
    checkUno(room, playerIndex);

    if (player.hand.length === 0) {
      game.winner = player.id;
      broadcast(room);
      return;
    }

    closeStealWindow(room.id);
    applyCardEffect(room, card, playerIndex, declaredColor);
    openStealWindow(room, card, game.currentPlayerIndex);
    broadcast(room);
  });

  socket.on('steal-card', ({ cardId, declaredColor }: { cardId: string; declaredColor?: Color }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room?.game) return;
    const game = room.game;
    const stealerIndex = room.players.findIndex(p => p.id === socket.id);
    if (stealerIndex === -1 || !game.stealWindow) return;

    const stealer = room.players[stealerIndex];
    const cardIdx = stealer.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const card = stealer.hand[cardIdx];
    const lastCard = game.stealWindow.card;

    if (!canSteal(card, lastCard, game.penalty)) {
      socket.emit('error', { msg: 'No puedes robar turno con esa carta' }); return;
    }

    stealer.hand.splice(cardIdx, 1);
    game.discardPile.push(card);
    closeStealWindow(room.id);
    checkUno(room, stealerIndex);

    if (stealer.hand.length === 0) {
      game.winner = stealer.id;
      broadcast(room);
      return;
    }

    applyCardEffect(room, card, stealerIndex, declaredColor);
    io.to(room.id).emit('turn-stolen', { byPlayerId: socket.id, byPlayerName: stealer.name });
    openStealWindow(room, card, game.currentPlayerIndex);
    broadcast(room);
  });

  socket.on('draw-card', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room?.game) return;
    const game = room.game;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== game.currentPlayerIndex) return;

    closeStealWindow(room.id);

    if (game.penalty) {
      const { drawn, deck, discardPile } = drawCards(game.deck, game.discardPile, game.penalty.amount);
      room.players[playerIndex].hand.push(...drawn);
      game.deck = deck;
      game.discardPile = discardPile;
      game.penalty = null;
    } else {
      const { drawn, deck, discardPile } = drawCards(game.deck, game.discardPile, 1);
      room.players[playerIndex].hand.push(...drawn);
      game.deck = deck;
      game.discardPile = discardPile;
    }

    game.currentPlayerIndex = nextPlayerIndex(playerIndex, room.players.length, game.direction);
    broadcast(room);
  });

  socket.on('say-uno', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.saidUno = true;
  });

  socket.on('disconnect', () => {
    const room = removePlayer(socket.id);
    if (room) broadcast(room);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`UNO server on port ${PORT}`));
