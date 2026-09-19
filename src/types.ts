export type Color = 'yellow' | 'red' | 'blue' | 'green' | 'wild';
export type CardValue = '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'skip'|'reverse'|'draw2'|'wild'|'wild4';

export interface Card {
  id: string;
  color: Color;
  value: CardValue;
}

export interface Player {
  id: string;       // socket id
  name: string;
  hand: Card[];
  isReady: boolean;
  saidUno: boolean;
}

export interface PenaltyStack {
  amount: number;
  color: Color;     // color that must be matched to respond
}

export interface GameState {
  deck: Card[];
  discardPile: Card[];
  currentPlayerIndex: number;
  direction: 1 | -1;
  penalty: PenaltyStack | null;
  stealWindow: {
    card: Card;
    byPlayerIndex: number;
    expiresAt: number;
  } | null;
  started: boolean;
  winner: string | null;
}

export interface Room {
  id: string;
  players: Player[];
  hostId: string;
  game: GameState | null;
}
