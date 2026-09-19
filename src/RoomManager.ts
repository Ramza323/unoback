import { Room, Player, Card } from './types';

const rooms = new Map<string, Room>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function createRoom(hostId: string, hostName: string): Room {
  let id = generateId();
  while (rooms.has(id)) id = generateId();

  const host: Player = { id: hostId, name: hostName, hand: [], isReady: false, saidUno: false };
  const room: Room = { id, players: [host], hostId, game: null };
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function joinRoom(roomId: string, playerId: string, name: string): Room | null {
  const room = rooms.get(roomId);
  if (!room || room.players.length >= 8 || room.game?.started) return null;
  if (room.players.find(p => p.id === playerId)) return room;
  room.players.push({ id: playerId, name, hand: [], isReady: false, saidUno: false });
  return room;
}

export function removePlayer(playerId: string): Room | null {
  for (const [, room] of rooms) {
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) continue;
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      rooms.delete(room.id);
      return null;
    }
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    return room;
  }
  return null;
}

export function getRoomByPlayer(playerId: string): Room | undefined {
  for (const [, room] of rooms) {
    if (room.players.find(p => p.id === playerId)) return room;
  }
}

export function sanitizeRoom(room: Room, forPlayerId: string) {
  return {
    ...room,
    game: room.game ? {
      ...room.game,
      deck: room.game.deck.length,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isReady: p.isReady,
        saidUno: p.saidUno,
        cardCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : [],
      })),
    } : null,
  };
}
