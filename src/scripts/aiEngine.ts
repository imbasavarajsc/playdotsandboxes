import type { GameState, Line, PlayerId } from './types';
import { getAllAvailableLines } from './gameEngine';

// ─── Fast Board Representation ──────────────────────────────────────────────
// A zero-allocation flat representation of the Dots and Boxes board for
// high-speed minimax search and endgame solving (500,000+ evals/sec).

class FastBoard {
  public readonly N: number; // Grid size in dots (e.g. 4 for 4x4 dots = 3x3 boxes)
  public readonly B: number; // Box count per row/col (N - 1)
  public readonly L: number; // Total number of lines: 2 * N * B
  public readonly M: number; // Total number of boxes: B * B

  // State arrays
  public lineOwners: Int8Array; // 0 = open, 1 = Player 1, 2 = Player 2
  public boxSides: Int8Array;   // 0..4 (number of drawn sides)
  public boxOwners: Int8Array;  // 0 = unclaimed, 1 = Player 1, 2 = Player 2

  // Precomputed topology
  public lineAdjBoxes: Int32Array; // 2 ints per line: [box0, box1] (-1 if border)
  public boxLines: Int32Array;     // 4 ints per box: [top, bottom, left, right]

  public currentPlayer: 1 | 2;
  public p1Score: number;
  public p2Score: number;
  public remainingLines: number;

  public idxToLineMap: (Line | null)[];
  public lineIdToIdxMap: Map<string, number>;

  // Zobrist hash values for fast transposition table keys
  public zobristHashLow: number;
  public zobristHashHigh: number;
  private static zobristInit = false;
  private static zLinesLow: Uint32Array;
  private static zLinesHigh: Uint32Array;
  private static zPlayerLow: Uint32Array;
  private static zPlayerHigh: Uint32Array;

  constructor(state: GameState) {
    this.N = state.config.gridSize;
    this.B = this.N - 1;
    this.L = 2 * this.N * this.B;
    this.M = this.B * this.B;

    FastBoard.initZobrist(this.L);

    this.lineOwners = new Int8Array(this.L);
    this.boxSides = new Int8Array(this.M);
    this.boxOwners = new Int8Array(this.M);
    this.lineAdjBoxes = new Int32Array(this.L * 2);
    this.boxLines = new Int32Array(this.M * 4);
    this.idxToLineMap = new Array(this.L).fill(null);
    this.lineIdToIdxMap = new Map();

    this.currentPlayer = state.currentPlayer;
    this.p1Score = state.scores[1];
    this.p2Score = state.scores[2];
    this.remainingLines = 0;

    this.zobristHashLow = 0;
    this.zobristHashHigh = 0;

    this.buildTopologyAndPopulate(state);
  }

  private static initZobrist(maxLines: number) {
    if (FastBoard.zobristInit && FastBoard.zLinesLow.length >= maxLines * 3) return;
    const len = Math.max(maxLines * 3, 512);
    FastBoard.zLinesLow = new Uint32Array(len);
    FastBoard.zLinesHigh = new Uint32Array(len);
    FastBoard.zPlayerLow = new Uint32Array(4);
    FastBoard.zPlayerHigh = new Uint32Array(4);

    // Deterministic pseudo-random number generator for reproducibility
    let seed = 0x853c49e6;
    function rand32(): number {
      seed = (Math.imul(1664525, seed) + 1013904223) | 0;
      return seed >>> 0;
    }

    for (let i = 0; i < len; i++) {
      FastBoard.zLinesLow[i] = rand32();
      FastBoard.zLinesHigh[i] = rand32();
    }
    for (let i = 0; i < 4; i++) {
      FastBoard.zPlayerLow[i] = rand32();
      FastBoard.zPlayerHigh[i] = rand32();
    }
    FastBoard.zobristInit = true;
  }

  public getLineIdx(type: 'h' | 'v', r: number, c: number): number {
    if (type === 'h') {
      return r * this.B + c;
    } else {
      return this.N * this.B + r * this.N + c;
    }
  }

  public getBoxIdx(r: number, c: number): number {
    return r * this.B + c;
  }

  private buildTopologyAndPopulate(state: GameState) {
    const N = this.N;
    const B = this.B;

    // 1. Build line adjacency
    // Horizontal lines: r: 0..N-1, c: 0..B-1
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < B; c++) {
        const lIdx = this.getLineIdx('h', r, c);
        const id = `h-${r}-${c}`;
        this.lineIdToIdxMap.set(id, lIdx);
        this.idxToLineMap[lIdx] = state.horizontalLines[r]?.[c] || null;

        const topBox = r > 0 ? this.getBoxIdx(r - 1, c) : -1;
        const bottomBox = r < B ? this.getBoxIdx(r, c) : -1;

        this.lineAdjBoxes[lIdx * 2] = topBox;
        this.lineAdjBoxes[lIdx * 2 + 1] = bottomBox;

        const owner = state.horizontalLines[r]?.[c]?.owner;
        if (owner) {
          this.lineOwners[lIdx] = owner;
          this.zobristHashLow ^= FastBoard.zLinesLow[lIdx * 3 + owner];
          this.zobristHashHigh ^= FastBoard.zLinesHigh[lIdx * 3 + owner];
        } else {
          this.remainingLines++;
        }
      }
    }

    // Vertical lines: r: 0..B-1, c: 0..N-1
    for (let r = 0; r < B; r++) {
      for (let c = 0; c < N; c++) {
        const lIdx = this.getLineIdx('v', r, c);
        const id = `v-${r}-${c}`;
        this.lineIdToIdxMap.set(id, lIdx);
        this.idxToLineMap[lIdx] = state.verticalLines[r]?.[c] || null;

        const leftBox = c > 0 ? this.getBoxIdx(r, c - 1) : -1;
        const rightBox = c < B ? this.getBoxIdx(r, c) : -1;

        this.lineAdjBoxes[lIdx * 2] = leftBox;
        this.lineAdjBoxes[lIdx * 2 + 1] = rightBox;

        const owner = state.verticalLines[r]?.[c]?.owner;
        if (owner) {
          this.lineOwners[lIdx] = owner;
          this.zobristHashLow ^= FastBoard.zLinesLow[lIdx * 3 + owner];
          this.zobristHashHigh ^= FastBoard.zLinesHigh[lIdx * 3 + owner];
        } else {
          this.remainingLines++;
        }
      }
    }

    // 2. Build box lines & count sides
    for (let r = 0; r < B; r++) {
      for (let c = 0; c < B; c++) {
        const bIdx = this.getBoxIdx(r, c);
        const top = this.getLineIdx('h', r, c);
        const bottom = this.getLineIdx('h', r + 1, c);
        const left = this.getLineIdx('v', r, c);
        const right = this.getLineIdx('v', r, c + 1);

        this.boxLines[bIdx * 4] = top;
        this.boxLines[bIdx * 4 + 1] = bottom;
        this.boxLines[bIdx * 4 + 2] = left;
        this.boxLines[bIdx * 4 + 3] = right;

        let sides = 0;
        if (this.lineOwners[top] !== 0) sides++;
        if (this.lineOwners[bottom] !== 0) sides++;
        if (this.lineOwners[left] !== 0) sides++;
        if (this.lineOwners[right] !== 0) sides++;

        this.boxSides[bIdx] = sides;
        const boxOwner = state.boxes[r]?.[c]?.owner;
        if (boxOwner) {
          this.boxOwners[bIdx] = boxOwner;
        }
      }
    }

    this.zobristHashLow ^= FastBoard.zPlayerLow[this.currentPlayer];
    this.zobristHashHigh ^= FastBoard.zPlayerHigh[this.currentPlayer];
  }

  public makeMove(lineIdx: number): number {
    const player = this.currentPlayer;
    this.lineOwners[lineIdx] = player;
    this.remainingLines--;

    this.zobristHashLow ^= FastBoard.zLinesLow[lineIdx * 3 + player];
    this.zobristHashHigh ^= FastBoard.zLinesHigh[lineIdx * 3 + player];

    let scored = 0;
    const b0 = this.lineAdjBoxes[lineIdx * 2];
    const b1 = this.lineAdjBoxes[lineIdx * 2 + 1];

    if (b0 !== -1) {
      this.boxSides[b0]++;
      if (this.boxSides[b0] === 4) {
        this.boxOwners[b0] = player;
        scored++;
      }
    }
    if (b1 !== -1) {
      this.boxSides[b1]++;
      if (this.boxSides[b1] === 4) {
        this.boxOwners[b1] = player;
        scored++;
      }
    }

    if (scored > 0) {
      if (player === 1) this.p1Score += scored;
      else this.p2Score += scored;
      // Streak: player retains turn
    } else {
      // Switch player
      this.zobristHashLow ^= FastBoard.zPlayerLow[this.currentPlayer];
      this.zobristHashHigh ^= FastBoard.zPlayerHigh[this.currentPlayer];
      this.currentPlayer = player === 1 ? 2 : 1;
      this.zobristHashLow ^= FastBoard.zPlayerLow[this.currentPlayer];
      this.zobristHashHigh ^= FastBoard.zPlayerHigh[this.currentPlayer];
    }

    return scored;
  }

  public undoMove(lineIdx: number, scored: number, prevPlayer: 1 | 2) {
    const player = prevPlayer;
    this.lineOwners[lineIdx] = 0;
    this.remainingLines++;

    this.zobristHashLow ^= FastBoard.zLinesLow[lineIdx * 3 + player];
    this.zobristHashHigh ^= FastBoard.zLinesHigh[lineIdx * 3 + player];

    const b0 = this.lineAdjBoxes[lineIdx * 2];
    const b1 = this.lineAdjBoxes[lineIdx * 2 + 1];

    if (scored > 0) {
      if (player === 1) this.p1Score -= scored;
      else this.p2Score -= scored;

      if (b0 !== -1) {
        if (this.boxSides[b0] === 4) this.boxOwners[b0] = 0;
        this.boxSides[b0]--;
      }
      if (b1 !== -1) {
        if (this.boxSides[b1] === 4) this.boxOwners[b1] = 0;
        this.boxSides[b1]--;
      }
    } else {
      if (b0 !== -1) this.boxSides[b0]--;
      if (b1 !== -1) this.boxSides[b1]--;
    }

    if (this.currentPlayer !== prevPlayer) {
      this.zobristHashLow ^= FastBoard.zPlayerLow[this.currentPlayer];
      this.zobristHashHigh ^= FastBoard.zPlayerHigh[this.currentPlayer];
      this.currentPlayer = prevPlayer;
      this.zobristHashLow ^= FastBoard.zPlayerLow[this.currentPlayer];
      this.zobristHashHigh ^= FastBoard.zPlayerHigh[this.currentPlayer];
    }
  }

  public isSafe(lineIdx: number): boolean {
    const b0 = this.lineAdjBoxes[lineIdx * 2];
    const b1 = this.lineAdjBoxes[lineIdx * 2 + 1];
    if (b0 !== -1 && this.boxSides[b0] >= 2) return false;
    if (b1 !== -1 && this.boxSides[b1] >= 2) return false;
    return true;
  }

  public isCompleting(lineIdx: number): boolean {
    const b0 = this.lineAdjBoxes[lineIdx * 2];
    const b1 = this.lineAdjBoxes[lineIdx * 2 + 1];
    return (b0 !== -1 && this.boxSides[b0] === 3) || (b1 !== -1 && this.boxSides[b1] === 3);
  }

  public getAvailableLines(): number[] {
    const lines: number[] = [];
    for (let i = 0; i < this.L; i++) {
      if (this.lineOwners[i] === 0) lines.push(i);
    }
    return lines;
  }
}

// ─── Chain & Loop Graph Analysis ─────────────────────────────────────────────

interface Chain {
  type: 'chain' | 'loop';
  length: number; // Number of boxes in this chain/loop
  isLong: boolean; // >= 3 for chain, >= 4 for loop
  boxes: number[];
  openLines: number[];
  capturableBoxIdx: number | null; // Box with 3 sides currently
  capturableLineIdx: number | null; // The line that captures the 3-sided box
  doubleCrossLineIdx: number | null; // The sacrifice line if double-crossing
}

interface BoardComponents {
  chains: Chain[];
  totalCapturableBoxes: number;
  longChainsCount: number;
  loopsCount: number;
  shortChainsCount: number;
  hasOtherComponents: boolean;
}

function analyzeComponents(board: FastBoard): BoardComponents {
  const visitedBoxes = new Uint8Array(board.M);
  const chains: Chain[] = [];
  let totalCapturableBoxes = 0;
  let longChainsCount = 0;
  let loopsCount = 0;
  let shortChainsCount = 0;

  // 1. First, find all active chains starting from 3-sided boxes
  for (let b = 0; b < board.M; b++) {
    if (visitedBoxes[b] || board.boxOwners[b] !== 0 || board.boxSides[b] !== 3) continue;

    // Trace chain from this 3-sided box
    const chainBoxes: number[] = [b];
    visitedBoxes[b] = 1;

    // Find the open line of box b
    const openLine0 = getBoxOpenLines(board, b)[0];
    const chainLines: number[] = [openLine0];

    let currBox = b;
    let prevLine = openLine0;

    let safety1 = 0;
    // Walk through connected 2-sided boxes
    while (safety1++ < board.M) {
      // Find the neighbor box across prevLine
      const b0 = board.lineAdjBoxes[prevLine * 2];
      const b1 = board.lineAdjBoxes[prevLine * 2 + 1];
      const nextBox = (b0 === currBox) ? b1 : b0;

      if (nextBox === -1 || board.boxOwners[nextBox] !== 0 || visitedBoxes[nextBox]) {
        break;
      }

      if (board.boxSides[nextBox] === 2) {
        visitedBoxes[nextBox] = 1;
        chainBoxes.push(nextBox);
        currBox = nextBox;

        // Find the other open line of nextBox
        const opens = getBoxOpenLines(board, nextBox);
        const forwardLine = (opens[0] === prevLine) ? opens[1] : opens[0];
        if (forwardLine === undefined) break;

        chainLines.push(forwardLine);
        prevLine = forwardLine;
      } else if (board.boxSides[nextBox] === 3) {
        // Connected to another 3-sided box at the end
        visitedBoxes[nextBox] = 1;
        chainBoxes.push(nextBox);
        break;
      } else {
        break;
      }
    }

    const len = chainBoxes.length;
    const isLong = len >= 3;
    if (isLong) longChainsCount++;
    else shortChainsCount++;

    totalCapturableBoxes += len;

    // Identify double-cross line for long chains
    // In a chain of >= 3 boxes, taking len - 2 boxes leaves the last 2 boxes.
    // The line that divides the last two boxes (or the end line) creates a doubleton.
    let doubleCrossLine: number | null = null;
    if (isLong && chainLines.length >= 2) {
      // The double-cross line is the line between the last two boxes, or closing the chain
      // When 2 boxes remain: playing the end line or shared line cedes the turn to opponent
      doubleCrossLine = chainLines[chainLines.length - 1] ?? null;
    }

    chains.push({
      type: 'chain',
      length: len,
      isLong,
      boxes: chainBoxes,
      openLines: chainLines,
      capturableBoxIdx: b,
      capturableLineIdx: openLine0,
      doubleCrossLineIdx: doubleCrossLine,
    });
  }

  // 2. Find unopened 2-sided loops and corridors
  for (let b = 0; b < board.M; b++) {
    if (visitedBoxes[b] || board.boxOwners[b] !== 0 || board.boxSides[b] !== 2) continue;

    const compBoxes: number[] = [b];
    visitedBoxes[b] = 1;

    const opens = getBoxOpenLines(board, b);
    if (opens.length < 2) continue;

    let isLoop = false;
    let currBox = b;
    let prevLine = opens[0];
    const compLines: number[] = [opens[0]];

    let safety2 = 0;
    while (safety2++ < board.M) {
      const b0 = board.lineAdjBoxes[prevLine * 2];
      const b1 = board.lineAdjBoxes[prevLine * 2 + 1];
      const nextBox = (b0 === currBox) ? b1 : b0;

      if (nextBox === -1 || board.boxOwners[nextBox] !== 0) {
        break;
      }

      if (nextBox === b) {
        isLoop = true;
        break;
      }

      if (visitedBoxes[nextBox]) {
        break;
      }

      if (board.boxSides[nextBox] === 2) {
        visitedBoxes[nextBox] = 1;
        compBoxes.push(nextBox);
        currBox = nextBox;
        const boxOpens = getBoxOpenLines(board, nextBox);
        const forward = (boxOpens[0] === prevLine) ? boxOpens[1] : boxOpens[0];
        if (forward === undefined) break;
        compLines.push(forward);
        prevLine = forward;
      } else {
        break;
      }
    }

    const len = compBoxes.length;
    if (isLoop && len >= 4) {
      loopsCount++;
      chains.push({
        type: 'loop',
        length: len,
        isLong: true,
        boxes: compBoxes,
        openLines: compLines,
        capturableBoxIdx: null,
        capturableLineIdx: null,
        doubleCrossLineIdx: compLines[0] ?? null,
      });
    } else {
      const isLong = len >= 3;
      if (isLong) longChainsCount++;
      else shortChainsCount++;
      chains.push({
        type: 'chain',
        length: len,
        isLong,
        boxes: compBoxes,
        openLines: compLines,
        capturableBoxIdx: null,
        capturableLineIdx: null,
        doubleCrossLineIdx: compLines[compLines.length - 1] ?? null,
      });
    }
  }

  // Check if there are other uncaptured components/boxes remaining
  const claimedBoxes = board.p1Score + board.p2Score;
  const uncapturedOutside = board.M - claimedBoxes - totalCapturableBoxes;
  const hasOtherComponents = uncapturedOutside > 0 || (chains.length > 1);

  return {
    chains,
    totalCapturableBoxes,
    longChainsCount,
    loopsCount,
    shortChainsCount,
    hasOtherComponents,
  };
}

function getBoxOpenLines(board: FastBoard, boxIdx: number): number[] {
  const open: number[] = [];
  for (let i = 0; i < 4; i++) {
    const l = board.boxLines[boxIdx * 4 + i];
    if (board.lineOwners[l] === 0) {
      open.push(l);
    }
  }
  return open;
}

// ─── Transposition Table ─────────────────────────────────────────────────────

const TT_SIZE = 131072; // 2^17 entries
const TT_MASK = TT_SIZE - 1;

const TTFlag = {
  EXACT: 0,
  LOWERBOUND: 1,
  UPPERBOUND: 2,
} as const;

type TTFlag = typeof TTFlag[keyof typeof TTFlag];

interface TTEntry {
  hashLow: number;
  hashHigh: number;
  depth: number;
  score: number;
  flag: TTFlag;
  bestLine: number;
}

const transpositionTable: (TTEntry | null)[] = new Array(TT_SIZE).fill(null);

function ttLookup(hashLow: number, hashHigh: number, depth: number, alpha: number, beta: number): { hit: boolean; score: number; bestLine: number } {
  const idx = (hashLow ^ hashHigh) & TT_MASK;
  const entry = transpositionTable[idx];
  if (!entry || entry.hashLow !== hashLow || entry.hashHigh !== hashHigh) {
    return { hit: false, score: 0, bestLine: -1 };
  }

  if (entry.depth >= depth) {
    if (entry.flag === TTFlag.EXACT) {
      return { hit: true, score: entry.score, bestLine: entry.bestLine };
    }
    if (entry.flag === TTFlag.LOWERBOUND && entry.score >= beta) {
      return { hit: true, score: entry.score, bestLine: entry.bestLine };
    }
    if (entry.flag === TTFlag.UPPERBOUND && entry.score <= alpha) {
      return { hit: true, score: entry.score, bestLine: entry.bestLine };
    }
  }

  return { hit: false, score: entry.score, bestLine: entry.bestLine };
}

function ttStore(hashLow: number, hashHigh: number, depth: number, score: number, flag: TTFlag, bestLine: number) {
  const idx = (hashLow ^ hashHigh) & TT_MASK;
  const existing = transpositionTable[idx];
  if (!existing || depth >= existing.depth) {
    transpositionTable[idx] = { hashLow, hashHigh, depth, score, flag, bestLine };
  }
}

// ─── Move Ordering & Chain Parity Evaluation ─────────────────────────────────

function estimateSacrificeDamage(board: FastBoard, lineIdx: number): number {
  // If we place this line, count how many boxes in the chain become capturable
  const b0 = board.lineAdjBoxes[lineIdx * 2];
  const b1 = board.lineAdjBoxes[lineIdx * 2 + 1];

  let damage = 0;
  if (b0 !== -1 && board.boxSides[b0] === 2) {
    damage += traceChainLengthFromBox(board, b0, lineIdx);
  }
  if (b1 !== -1 && board.boxSides[b1] === 2) {
    damage += traceChainLengthFromBox(board, b1, lineIdx);
  }
  return Math.max(1, damage);
}

function traceChainLengthFromBox(board: FastBoard, startBox: number, excludeLine: number): number {
  let len = 1;
  let currBox = startBox;
  let prevLine = excludeLine;

  const visited = new Set<number>([startBox]);
  let safety = 0;

  while (safety++ < board.M) {
    const opens = getBoxOpenLines(board, currBox).filter(l => l !== prevLine && l !== excludeLine);
    if (opens.length !== 1) break;

    const nextLine = opens[0];
    const b0 = board.lineAdjBoxes[nextLine * 2];
    const b1 = board.lineAdjBoxes[nextLine * 2 + 1];
    const nextBox = (b0 === currBox) ? b1 : b0;

    if (nextBox === -1 || board.boxOwners[nextBox] !== 0 || visited.has(nextBox)) break;
    if (board.boxSides[nextBox] !== 2) break;

    visited.add(nextBox);
    len++;
    currBox = nextBox;
    prevLine = nextLine;
  }

  return len;
}

function orderMoves(board: FastBoard, lines: number[], ttBestMove: number, allowDoubleCross: boolean = true): number[] {
  const completing: number[] = [];
  const safe: number[] = [];
  const sacrifice: { line: number; damage: number }[] = [];
  const doubleCrossMoves: number[] = [];

  const components = analyzeComponents(board);

  // Check for double-cross opportunities
  if (allowDoubleCross && components.hasOtherComponents) {
    for (const chain of components.chains) {
      if (chain.isLong && chain.capturableBoxIdx !== null && chain.doubleCrossLineIdx !== null) {
        // If we are down to 2 boxes in this long chain, the double-cross line is high priority
        if (chain.length === 2 || chain.boxes.length <= 3) {
          doubleCrossMoves.push(chain.doubleCrossLineIdx);
        }
      }
    }
  }

  for (const line of lines) {
    if (board.isCompleting(line)) {
      completing.push(line);
    } else if (board.isSafe(line)) {
      safe.push(line);
    } else {
      const damage = estimateSacrificeDamage(board, line);
      sacrifice.push({ line, damage });
    }
  }

  // Pure Game-Theoretic Pruning: If safe moves exist and no box can be captured or double-crossed,
  // there is strictly no mathematical reason to open a box for the opponent.
  if (completing.length === 0 && doubleCrossMoves.length === 0 && safe.length > 0) {
    safe.sort((a, b) => a - b);
    if (ttBestMove !== -1 && safe.includes(ttBestMove)) {
      return [ttBestMove, ...safe.filter(l => l !== ttBestMove)];
    }
    return safe;
  }

  // Sort sacrifice moves: smallest giveaway first
  sacrifice.sort((a, b) => a.damage - b.damage || a.line - b.line);

  // Safe moves sort: prefer moves that don't split large regions
  safe.sort((a, b) => a - b);

  const ordered: number[] = [];
  if (ttBestMove !== -1 && lines.includes(ttBestMove)) {
    ordered.push(ttBestMove);
  }

  // Add double-cross candidates
  for (const dcm of doubleCrossMoves) {
    if (lines.includes(dcm) && !ordered.includes(dcm)) {
      ordered.push(dcm);
    }
  }

  // Add completing moves
  for (const cm of completing) {
    if (!ordered.includes(cm)) ordered.push(cm);
  }

  // Add safe moves
  for (const sm of safe) {
    if (!ordered.includes(sm)) ordered.push(sm);
  }

  // Add sacrifice moves
  for (const sc of sacrifice) {
    if (!ordered.includes(sc.line)) ordered.push(sc.line);
  }

  return ordered;
}

// ─── Heuristic Leaf Evaluation ───────────────────────────────────────────────

function evaluateBoard(board: FastBoard, aiPlayer: PlayerId): number {
  const oppPlayer: PlayerId = aiPlayer === 1 ? 2 : 1;
  const aiScore = aiPlayer === 1 ? board.p1Score : board.p2Score;
  const oppScore = oppPlayer === 1 ? board.p1Score : board.p2Score;

  // Base score differential (heavily weighted)
  let score = (aiScore - oppScore) * 1000;

  // Terminal state
  if (board.remainingLines === 0 || aiScore + oppScore === board.M) {
    if (aiScore > oppScore) return 100000 + (aiScore - oppScore) * 1000;
    if (aiScore < oppScore) return -100000 + (aiScore - oppScore) * 1000;
    return 0;
  }

  const components = analyzeComponents(board);

  // Long chain parity & control theorem (Berlekamp):
  // Controlling the long chains and loops allows capturing all remaining boxes minus 2 per long chain
  const totalLongComponents = components.longChainsCount + components.loopsCount;
  const isAiTurn = board.currentPlayer === aiPlayer;

  // Safe move count
  let safeCount = 0;
  const lines = board.getAvailableLines();
  for (const l of lines) {
    if (board.isSafe(l)) safeCount++;
  }

  // Initiative: Having safe moves when opponent has none is a massive advantage
  if (isAiTurn) {
    score += safeCount * 15;
    if (components.totalCapturableBoxes > 0) {
      score += components.totalCapturableBoxes * 50;
    }
  } else {
    score -= safeCount * 15;
    if (components.totalCapturableBoxes > 0) {
      score -= components.totalCapturableBoxes * 50;
    }
  }

  // Long Chain Rule:
  // In an endgame with C long chains/loops, the player who double-crosses controls (Total - 2*C) boxes
  if (totalLongComponents > 0) {
    const potentialSacrifice = components.longChainsCount * 2 + components.loopsCount * 4;
    const potentialGain = board.M - (aiScore + oppScore) - potentialSacrifice;
    if (isAiTurn) {
      score += Math.max(0, potentialGain) * 20;
    } else {
      score -= Math.max(0, potentialGain) * 20;
    }
  }

  return score;
}

// ─── Minimax Search with Alpha-Beta Pruning & Timeout Safety ─────────────────

let searchDeadline = 0;
let searchNodeCount = 0;
let searchTimedOut = false;

function minimax(
  board: FastBoard,
  depth: number,
  alpha: number,
  beta: number,
  aiPlayer: PlayerId,
  allowDoubleCross: boolean = true
): number {
  searchNodeCount++;
  if ((searchNodeCount & 255) === 0) {
    if (Date.now() > searchDeadline) {
      searchTimedOut = true;
      return evaluateBoard(board, aiPlayer);
    }
  }

  if (board.remainingLines === 0 || board.p1Score + board.p2Score === board.M) {
    return evaluateBoard(board, aiPlayer);
  }

  if (depth <= 0 || searchTimedOut) {
    return evaluateBoard(board, aiPlayer);
  }

  const origAlpha = alpha;
  const tt = ttLookup(board.zobristHashLow, board.zobristHashHigh, depth, alpha, beta);
  if (tt.hit) {
    return tt.score;
  }

  const availableLines = board.getAvailableLines();
  if (availableLines.length === 0) {
    return evaluateBoard(board, aiPlayer);
  }

  const orderedLines = orderMoves(board, availableLines, tt.bestLine, allowDoubleCross);
  const isMaximizing = board.currentPlayer === aiPlayer;

  let bestMove = orderedLines[0];

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const line of orderedLines) {
      if (searchTimedOut) break;
      const prevPlayer = board.currentPlayer;
      const scored = board.makeMove(line);

      // In Dots & Boxes, scoring gives another turn; decrement depth after 1st chain ply to avoid runaway recursion
      const nextDepth = scored > 0 ? (depth > 2 ? depth - 1 : depth) : depth - 1;
      const evalScore = minimax(board, nextDepth, alpha, beta, aiPlayer, allowDoubleCross);

      board.undoMove(line, scored, prevPlayer);

      if (evalScore > maxEval) {
        maxEval = evalScore;
        bestMove = line;
      }
      alpha = Math.max(alpha, evalScore);
      if (beta <= alpha) {
        break; // Beta cutoff
      }
    }

    let flag: TTFlag = TTFlag.EXACT;
    if (maxEval <= origAlpha) flag = TTFlag.UPPERBOUND;
    else if (maxEval >= beta) flag = TTFlag.LOWERBOUND;
    ttStore(board.zobristHashLow, board.zobristHashHigh, depth, maxEval, flag, bestMove);

    return maxEval;
  } else {
    let minEval = Infinity;
    for (const line of orderedLines) {
      if (searchTimedOut) break;
      const prevPlayer = board.currentPlayer;
      const scored = board.makeMove(line);

      const nextDepth = scored > 0 ? (depth > 2 ? depth - 1 : depth) : depth - 1;
      const evalScore = minimax(board, nextDepth, alpha, beta, aiPlayer, allowDoubleCross);

      board.undoMove(line, scored, prevPlayer);

      if (evalScore < minEval) {
        minEval = evalScore;
        bestMove = line;
      }
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) {
        break; // Alpha cutoff
      }
    }

    let flag: TTFlag = TTFlag.EXACT;
    if (minEval <= origAlpha) flag = TTFlag.UPPERBOUND;
    else if (minEval >= beta) flag = TTFlag.LOWERBOUND;
    ttStore(board.zobristHashLow, board.zobristHashHigh, depth, minEval, flag, bestMove);

    return minEval;
  }
}

// ─── Hard AI: Master Game-Theoretic Solver ───────────────────────────────────

function getAdaptiveSearchDepth(board: FastBoard): number {
  const rem = board.remainingLines;
  const N = board.N;

  // Exact Endgame Solver:
  // For small boards (3x3 dots) or when few lines remain
  if (N <= 3) return Math.min(rem, 12);
  if (N === 4) {
    if (rem <= 10) return rem;
    if (rem <= 14) return 6;
    return 4;
  }
  if (N === 5) {
    if (rem <= 8) return rem;
    if (rem <= 14) return 5;
    return 3;
  }
  // 6x6 dots and 7x7 dots (larger grids)
  if (rem <= 6) return rem;
  if (rem <= 12) return 4;
  return 3;
}

function hardAiMove(state: GameState): Line {
  const board = new FastBoard(state);
  const availableLines = board.getAvailableLines();
  if (availableLines.length === 0) {
    return getAllAvailableLines(state)[0];
  }
  if (availableLines.length === 1) {
    const single = board.idxToLineMap[availableLines[0]];
    if (single && !single.owner) return single;
    return getAllAvailableLines(state)[0];
  }

  const aiPlayer = state.currentPlayer;
  const components = analyzeComponents(board);

  // 1. Double-cross & Chain Capture Strategy:
  if (components.chains.length > 0) {
    for (const chain of components.chains) {
      if (chain.capturableBoxIdx !== null && chain.isLong && components.hasOtherComponents) {
        if (chain.length === 2 && chain.doubleCrossLineIdx !== null) {
          const dcLine = board.idxToLineMap[chain.doubleCrossLineIdx];
          if (dcLine && !dcLine.owner) {
            return dcLine;
          }
        }
      }
    }
  }

  // Set safety deadline: 2500ms max calculation time
  searchDeadline = Date.now() + 2500;
  searchNodeCount = 0;
  searchTimedOut = false;

  const targetDepth = getAdaptiveSearchDepth(board);
  const orderedLines = orderMoves(board, availableLines, -1, true);

  let overallBestLineIdx = orderedLines[0];

  // Iterative deepening search: start at depth 1 up to targetDepth
  for (let d = 1; d <= targetDepth; d++) {
    if (searchTimedOut || Date.now() > searchDeadline - 100) break;

    let bestScoreForDepth = -Infinity;
    let bestLineForDepth = orderedLines[0];
    let depthCompleted = true;

    for (const line of orderedLines) {
      if (Date.now() > searchDeadline) {
        searchTimedOut = true;
        depthCompleted = false;
        break;
      }

      const prevPlayer = board.currentPlayer;
      const scored = board.makeMove(line);

      const nextDepth = scored > 0 ? (d > 2 ? d - 1 : d) : d - 1;
      const score = minimax(board, nextDepth, -Infinity, Infinity, aiPlayer, true);

      board.undoMove(line, scored, prevPlayer);

      if (score > bestScoreForDepth || (score === bestScoreForDepth && line < bestLineForDepth)) {
        bestScoreForDepth = score;
        bestLineForDepth = line;
      }
    }

    if (depthCompleted && !searchTimedOut) {
      overallBestLineIdx = bestLineForDepth;
    } else if (bestScoreForDepth > -Infinity) {
      // Retain best line found from partial search
      overallBestLineIdx = bestLineForDepth;
    }
  }

  const chosen = board.idxToLineMap[overallBestLineIdx];
  if (chosen && !chosen.owner) {
    return chosen;
  }

  return board.idxToLineMap[availableLines[0]] ?? getAllAvailableLines(state)[0];
}

// ─── Medium AI: Limited Search with Suboptimal Chance ────────────────────────

function mediumAiMove(state: GameState, availableLines: Line[]): Line {
  // 15–20% chance of a random/suboptimal legal move to keep Medium beatable
  if (Math.random() < 0.18) {
    return availableLines[Math.floor(Math.random() * availableLines.length)];
  }

  const board = new FastBoard(state);
  const availIdxs = board.getAvailableLines();
  if (availIdxs.length === 0) return availableLines[0];

  // 1. Immediate capture: Greedily complete any 3-sided boxes without double-cross
  const completingIdxs = availIdxs.filter(i => board.isCompleting(i));
  if (completingIdxs.length > 0) {
    // Pick completing line that leaves the fewest 3-sided boxes
    let bestCompleting = completingIdxs[0];
    let minOppGives = Infinity;

    for (const line of completingIdxs) {
      const prevPlayer = board.currentPlayer;
      const scored = board.makeMove(line);
      let oppGives = 0;
      for (const nextL of board.getAvailableLines()) {
        if (board.isCompleting(nextL)) oppGives++;
      }
      board.undoMove(line, scored, prevPlayer);

      if (oppGives < minOppGives) {
        minOppGives = oppGives;
        bestCompleting = line;
      }
    }
    const res = board.idxToLineMap[bestCompleting];
    if (res && !res.owner) return res;
  }

  // 2. Prefer safe moves that don't create 3-sided boxes for the opponent
  const safeIdxs = availIdxs.filter(i => board.isSafe(i));
  if (safeIdxs.length > 0) {
    // Run shallow minimax (depth 2-3, no double-cross) to pick the best safe move
    searchDeadline = Date.now() + 1500;
    searchNodeCount = 0;
    searchTimedOut = false;
    const depth = 2;
    let bestSafe = safeIdxs[0];
    let bestSafeScore = -Infinity;

    for (const line of safeIdxs) {
      if (Date.now() > searchDeadline) break;
      const prevPlayer = board.currentPlayer;
      const scored = board.makeMove(line);
      const score = minimax(board, depth - 1, -Infinity, Infinity, state.currentPlayer, false);
      board.undoMove(line, scored, prevPlayer);

      if (score > bestSafeScore) {
        bestSafeScore = score;
        bestSafe = line;
      }
    }
    const res = board.idxToLineMap[bestSafe];
    if (res && !res.owner) return res;
  }

  // 3. Forced sacrifice: Pick the least damaging unsafe move (shortest chain)
  let minChainDamage = Infinity;
  let bestSacrifice = availIdxs[0];

  for (const line of availIdxs) {
    const damage = estimateSacrificeDamage(board, line);
    if (damage < minChainDamage) {
      minChainDamage = damage;
      bestSacrifice = line;
    }
  }

  const res = board.idxToLineMap[bestSacrifice];
  if (res && !res.owner) return res;

  return availableLines[0];
}

// ─── Easy AI: Casual / Beginner ──────────────────────────────────────────────

function easyAiMove(state: GameState, availableLines: Line[]): Line {
  const board = new FastBoard(state);
  const completing = availableLines.filter(l => {
    const idx = board.lineIdToIdxMap.get(l.id);
    return idx !== undefined && board.isCompleting(idx);
  });

  // 60% chance to complete a box if available
  if (completing.length > 0 && Math.random() < 0.6) {
    return completing[Math.floor(Math.random() * completing.length)];
  }

  return availableLines[Math.floor(Math.random() * availableLines.length)];
}

// ─── Safe Fallback Generator ─────────────────────────────────────────────────

function fallbackMove(state: GameState, availableLines: Line[]): Line {
  if (availableLines.length === 0) {
    return getAllAvailableLines(state)[0];
  }
  try {
    const board = new FastBoard(state);
    // 1. Try to find completing line
    for (const line of availableLines) {
      const idx = board.lineIdToIdxMap.get(line.id);
      if (idx !== undefined && board.isCompleting(idx)) return line;
    }
    // 2. Try to find safe line
    for (const line of availableLines) {
      const idx = board.lineIdToIdxMap.get(line.id);
      if (idx !== undefined && board.isSafe(idx)) return line;
    }
  } catch (err) {
    console.error('Error in fallbackMove heuristic:', err);
  }
  return availableLines[0];
}

// ─── Public Entry Point ──────────────────────────────────────────────────────

export function getAiMove(state: GameState, difficulty: 'easy' | 'medium' | 'hard'): Line | null {
  const availableLines = getAllAvailableLines(state);
  if (!availableLines || availableLines.length === 0) return null;

  try {
    let chosen: Line | null = null;
    switch (difficulty) {
      case 'easy':
        chosen = easyAiMove(state, availableLines);
        break;
      case 'medium':
        chosen = mediumAiMove(state, availableLines);
        break;
      case 'hard':
      default:
        chosen = hardAiMove(state);
        break;
    }

    // Verify move is valid and not already owned
    if (chosen && !chosen.owner && availableLines.some(l => l.id === chosen!.id)) {
      return chosen;
    }
    return fallbackMove(state, availableLines);
  } catch (err) {
    console.error('Critical AI error encountered during getAiMove:', err);
    return fallbackMove(state, availableLines);
  }
}
