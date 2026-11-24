export type PlayerId = 1 | 2;

export interface Player {
  id: PlayerId;
  name: string;
  isAi: boolean;
  aiDifficulty?: 'easy' | 'medium' | 'hard';
  colorVar: string;
  avatar: string;
}

export type MoveType = 'horizontal' | 'vertical';

export interface Line {
  id: string; // e.g. "h-0-1" or "v-1-0"
  type: MoveType;
  row: number; // For H: row 0..N, col 0..N-1. For V: row 0..N-1, col 0..N
  col: number;
  owner: PlayerId | null;
  isLastMove?: boolean;
  isHint?: boolean;
}

export interface Box {
  id: string; // e.g. "box-0-0"
  row: number; // 0..N-1
  col: number; // 0..N-1
  owner: PlayerId | null;
  topLineId: string;
  bottomLineId: string;
  leftLineId: string;
  rightLineId: string;
  isJustCompleted?: boolean;
}

export interface Move {
  lineId: string;
  player: PlayerId;
  boxesClaimed: string[];
  timestamp: number;
}

export type GameMode = 'pvp' | 'pve' | 'eve' | 'sandbox' | 'online';
export type ThemeId = 'default' | 'cyberpunk' | 'geist' | 'arcade' | 'emerald';

export interface GameConfig {
  gridSize: number; // Grid size in dots (e.g. 4 means 4x4 dots = 3x3 boxes)
  mode: GameMode;
  aiDifficulty: 'easy' | 'medium' | 'hard';
  player1Name: string;
  player2Name: string;
  theme: ThemeId;
  soundEnabled: boolean;
  timerEnabled: boolean;
  timerDuration: number; // seconds per turn
}

export interface GameStats {
  gamesPlayed: number;
  p1Wins: number;
  p2Wins: number;
  ties: number;
  easyAiWins: number;
  mediumAiWins: number;
  hardAiWins: number;
  totalBoxesCompleted: number;
  longestStreak: number;
}

export interface GameState {
  config: GameConfig;
  currentPlayer: PlayerId;
  horizontalLines: Line[][];
  verticalLines: Line[][];
  boxes: Box[][];
  scores: Record<PlayerId, number>;
  history: Move[];
  redoStack: Move[];
  isGameOver: boolean;
  winner: PlayerId | 'tie' | null;
  turnTimer: number;
  streakCount: number;
}
