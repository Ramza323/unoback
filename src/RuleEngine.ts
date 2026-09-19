import { Card, Color, GameState } from './types';

export function canPlay(card: Card, topCard: Card, penalty: GameState['penalty'], declaredColor?: Color): boolean {
  if (penalty) {
    return canRespondToPenalty(card, penalty);
  }
  if (card.value === 'wild' || card.value === 'wild4') return true;
  const effectiveColor = topCard.value === 'wild' || topCard.value === 'wild4'
    ? declaredColor ?? topCard.color
    : topCard.color;
  return card.color === effectiveColor || card.value === topCard.value;
}

export function canRespondToPenalty(card: Card, penalty: GameState['penalty']): boolean {
  if (!penalty) return false;
  if (card.value === 'wild4') return true;
  if (card.color !== penalty.color) return false;
  return card.value === 'draw2' || card.value === 'skip' || card.value === 'reverse';
}

export function canSteal(card: Card, lastPlayed: Card, currentPenalty: GameState['penalty']): boolean {
  if (currentPenalty) {
    return canRespondToPenalty(card, currentPenalty);
  }
  return card.color === lastPlayed.color && card.value === lastPlayed.value;
}

export function getPenaltyAddition(card: Card): number {
  if (card.value === 'draw2') return 2;
  if (card.value === 'wild4') return 4;
  return 0;
}

export function isDefenseCard(card: Card): boolean {
  return card.value === 'skip' || card.value === 'reverse';
}

export function nextPlayerIndex(current: number, total: number, direction: 1 | -1, skip = false): number {
  let next = (current + direction + total) % total;
  if (skip) next = (next + direction + total) % total;
  return next;
}
