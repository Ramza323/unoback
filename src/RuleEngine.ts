import { Card, Color, GameState } from './types';

export function canPlay(card: Card, topCard: Card, penalty: GameState['penalty'], declaredColor?: Color | null): boolean {
  if (penalty) return canRespondToPenalty(card, penalty);
  if (card.value === 'wild' || card.value === 'wild4') return true;
  const effectiveColor: Color = (topCard.value === 'wild' || topCard.value === 'wild4')
    ? (declaredColor ?? topCard.color)
    : topCard.color;
  return card.color === effectiveColor || card.value === topCard.value;
}

export function canRespondToPenalty(card: Card, penalty: GameState['penalty']): boolean {
  if (!penalty) return false;
  if (card.value === 'wild4') return true;
  if (card.color !== penalty.color) return false;
  return card.value === 'draw2' || card.value === 'skip' || card.value === 'reverse';
}

export function canSteal(card: Card, lastPlayed: Card, declaredColor: Color | null, penalty: GameState['penalty']): boolean {
  if (penalty) return canRespondToPenalty(card, penalty);
  // Mismo valor y mismo color efectivo
  const effectiveColor: Color = (lastPlayed.value === 'wild' || lastPlayed.value === 'wild4')
    ? (declaredColor ?? lastPlayed.color)
    : lastPlayed.color;
  return card.color === effectiveColor && card.value === lastPlayed.value;
}

export function getPenaltyAddition(card: Card): number {
  if (card.value === 'draw2') return 2;
  if (card.value === 'wild4') return 4;
  return 0;
}

export function isDefenseCard(card: Card): boolean {
  return card.value === 'skip' || card.value === 'reverse';
}

export function nextPlayerIndex(current: number, players: { connected: boolean }[], direction: 1 | -1, skip = false): number {
  const total = players.length;
  let next = (current + direction + total) % total;
  // Saltar jugadores desconectados
  let attempts = 0;
  while (!players[next]?.connected && attempts < total) {
    next = (next + direction + total) % total;
    attempts++;
  }
  if (skip) {
    next = (next + direction + total) % total;
    attempts = 0;
    while (!players[next]?.connected && attempts < total) {
      next = (next + direction + total) % total;
      attempts++;
    }
  }
  return next;
}
