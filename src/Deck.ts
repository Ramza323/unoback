import { Card, Color, CardValue } from './types';

const COLORS: Color[] = ['yellow', 'red', 'blue', 'green'];
const NUMBERS: CardValue[] = ['0','1','2','3','4','5','6','7','8','9'];
const ACTIONS: CardValue[] = ['skip','reverse','draw2'];

let idCounter = 0;
const makeCard = (color: Color, value: CardValue): Card => ({
  id: `${color}-${value}-${idCounter++}`,
  color,
  value,
});

export function buildDeck(): Card[] {
  idCounter = 0;
  const deck: Card[] = [];

  for (const color of COLORS) {
    deck.push(makeCard(color, '0'));
    for (const num of NUMBERS.slice(1)) {
      deck.push(makeCard(color, num));
      deck.push(makeCard(color, num));
    }
    for (const action of ACTIONS) {
      deck.push(makeCard(color, action));
      deck.push(makeCard(color, action));
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push(makeCard('wild', 'wild'));
    deck.push(makeCard('wild', 'wild4'));
  }

  return shuffle(deck);
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function drawCards(deck: Card[], discardPile: Card[], count: number): { drawn: Card[]; deck: Card[]; discardPile: Card[] } {
  let d = [...deck];
  const discard = [...discardPile];

  if (d.length < count) {
    const top = discard.pop()!;
    d = [...shuffle(discard), ...d];
    discard.length = 0;
    discard.push(top);
  }

  const drawn = d.splice(0, count);
  return { drawn, deck: d, discardPile: discard };
}
