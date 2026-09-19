import { Room, Player } from './types';
import { shuffle } from './Deck';

const rooms = new Map<string, Room>();
const RECONNECT_GRACE_MS = 60_000; // 60s para reconectarse

function generateId(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function createRoom(hostId: string, hostName: string): Room {
  let id = generateId();
  while (rooms.has(id)) id = generateId();

  const host: Player = { id: hostId, name: hostName, hand: [], isReady: false, saidUno: false, connected: true };
  const room: Room = { id, players: [host], hostId, game: null };
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function joinRoom(roomId: string, playerId: string, name: string): Room | 'full' | 'started' | 'not_found' {
  const room = rooms.get(roomId);
  if (!room) return 'not_found';

  // Reconexión: buscar jugador desconectado con el mismo nombre
  const disconnected = room.players.find(p => p.name === name && !p.connected);
  if (disconnected) {
    disconnected.id = playerId;
    disconnected.connected = true;
    disconnected.disconnectedAt = undefined;
    return room;
  }

  // Nuevo jugador durante partida: no permitir
  if (room.game?.started) return 'started';
  if (room.players.length >= 8) return 'full';

  // Ya estaba (misma sesión)
  if (room.players.find(p => p.id === playerId)) return room;

  room.players.push({ id: playerId, name, hand: [], isReady: false, saidUno: false, connected: true });
  return room;
}

export function markDisconnected(playerId: string): { room: Room; playerIdx: number } | null {
  for (const [, room] of rooms) {
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) continue;

    const player = room.players[idx];
    player.connected = false;
    player.disconnectedAt = Date.now();

    // Si el juego no había iniciado, eliminar directamente
    if (!room.game?.started) {
      room.players.splice(idx, 1);
      if (room.players.length === 0) { rooms.delete(room.id); return null; }
      if (room.hostId === playerId) room.hostId = room.players[0].id;
      return { room, playerIdx: -1 };
    }

    // Durante partida: conservar mano para permitir reconexión dentro del grace period

    // Cambiar host si era el host
    if (room.hostId === playerId) {
      const newHost = room.players.find(p => p.connected);
      if (newHost) room.hostId = newHost.id;
    }

    return { room, playerIdx: idx };
  }
  return null;
}

export function advanceIndexAfterDisconnect(room: Room, removedIdx: number): void {
  if (!room.game) return;
  const total = room.players.length;
  if (total === 0) return;

  // Si era el turno del jugador desconectado, o el índice quedó fuera de rango
  if (room.game.currentPlayerIndex === removedIdx) {
    const direction = room.game.direction;
    let next = (removedIdx + direction + total) % total;
    let attempts = 0;
    while (!room.players[next]?.connected && attempts < total) {
      next = (next + direction + total) % total;
      attempts++;
    }
    room.game.currentPlayerIndex = next;
  } else if (room.game.currentPlayerIndex > removedIdx) {
    // El índice se desplazó por el splice virtual (no hacemos splice real, marcamos disconnected)
    // No hay splice real, el jugador sigue en el array como desconectado → no ajustar
  }
}

export function cleanupStaleDisconnects(): void {
  const now = Date.now();
  for (const [, room] of rooms) {
    if (!room.game?.started) continue;
    const stale = room.players.filter(
      p => !p.connected && p.disconnectedAt && (now - p.disconnectedAt) > RECONNECT_GRACE_MS
    );
    for (const p of stale) {
      const idx = room.players.indexOf(p);
      // Devolver cartas al mazo cuando se elimina definitivamente
      if (p.hand.length > 0) {
        room.game.deck = shuffle([...room.game.deck, ...p.hand]);
        p.hand = [];
      }
      room.players.splice(idx, 1);
    }
  }
}

export function getRoomByPlayer(playerId: string): Room | undefined {
  for (const [, room] of rooms) {
    if (room.players.find(p => p.id === playerId)) return room;
  }
}

export function sanitizeRoom(room: Room, forPlayerId: string) {
  return {
    id: room.id,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isReady: p.isReady,
      saidUno: p.saidUno,
      connected: p.connected,
      cardCount: p.hand.length,
    })),
    game: room.game ? {
      deck: room.game.deck.length,
      discardPile: room.game.discardPile,
      currentPlayerIndex: room.game.currentPlayerIndex,
      direction: room.game.direction,
      penalty: room.game.penalty,
      declaredColor: room.game.declaredColor,
      stealWindow: room.game.stealWindow,
      started: room.game.started,
      winner: room.game.winner,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isReady: p.isReady,
        saidUno: p.saidUno,
        connected: p.connected,
        cardCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : [],
      })),
    } : null,
  };
}
