import { createInitialState, makeMove, undoMove, getAllAvailableLines } from './gameEngine';
import { getAiMove } from './aiEngine';
import { audioEngine } from './audioEngine';
import { loadStats, recordGameResult, resetStats } from './statsEngine';
import { launchConfetti } from './confetti';
import { onlineManager, type OnlineStatus, type OnlineMoveData } from './onlineEngine';
import type { GameConfig, GameState, Line, PlayerId } from './types';

let state: GameState;
let timerInterval: number | null = null;
let aiTimeoutId: number | null = null;

// Whether the current match is actually playable yet. Only relevant for
// 2-Player mode, where the board stays locked until both names are
// confirmed via the Start button. vs Computer / Self Practice are always
// considered "started" since they need no name entry.
let matchStarted = true;
let myOnlinePlayerId: 1 | 2 = 1;

const PVP_P1_STORAGE_KEY = 'boxbattle_pvp_player1_name';
const PVP_P2_STORAGE_KEY = 'boxbattle_pvp_player2_name';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInitialGridSize(): number {
  try {
    const params = new URLSearchParams(window.location.search);
    const gridParam = params.get('grid');
    if (gridParam) {
      const clean = gridParam.trim().toLowerCase();
      // Handles '3x3', '4x4', '5x5', '6x6', '7x7' or '3', '4', '5', '6', '7'
      const match = clean.match(/^([3-7])(?:x\1)?$/);
      if (match) {
        return parseInt(match[1], 10);
      }
      const num = parseInt(clean, 10);
      if (num >= 3 && num <= 7) {
        return num;
      }
    }
  } catch {
    // Ignore URL parse error
  }
  return 4; // default 4x4 Dots (3x3 Boxes)
}

function syncGridDropdownUI(size: number) {
  const dropdown = document.getElementById('grid-size-dropdown');
  const trigger = document.getElementById('grid-size-trigger');
  const selectedText = trigger?.querySelector('.dropdown-selected-text') || dropdown?.querySelector('.dropdown-selected-text');
  const hiddenInput = document.getElementById('grid-size-select') as HTMLInputElement | null;

  // Options might be inside #grid-size-dropdown or portaled into document.body
  const options = document.querySelectorAll<HTMLLIElement>('#grid-size-dropdown .dropdown-option, .dropdown-menu[aria-labelledby*="grid-size"] .dropdown-option');

  let matchedLabel = `${size}x${size} Dots (${size - 1}x${size - 1} Boxes)`;

  options.forEach(opt => {
    const val = parseInt(opt.getAttribute('data-value') || '0', 10);
    const isSelected = val === size;
    opt.classList.toggle('selected', isSelected);
    opt.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    if (isSelected && opt.textContent) {
      matchedLabel = opt.textContent.trim();
    }
  });

  if (selectedText) {
    selectedText.textContent = matchedLabel;
  }
  if (hiddenInput) {
    hiddenInput.value = `${size}`;
  }
}

function abbr(name: string, fallback: string): string {
  const t = (name || '').trim();
  return t.length > 0 ? t.substring(0, 3).toUpperCase() : fallback;
}

function getStoredName(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredName(key: string, name: string): void {
  try {
    localStorage.setItem(key, name);
  } catch {
    // Ignore storage errors
  }
}

// ─── Online Multiplayer Handlers ─────────────────────────────────────────────

function setupOnlineCallbacks() {
  onlineManager.setCallbacks({
    onStatusChange: (status: OnlineStatus, message?: string) => {
      const statusDesc = document.getElementById('online-status-desc');
      const statusBanner = document.getElementById('online-status-banner');
      if (statusDesc && message) statusDesc.textContent = message;

      if (statusBanner) {
        statusBanner.className = `status-banner ${status}`;
      }

      if (status === 'connected') {
        if (myOnlinePlayerId === 1) {
          state.config.player2Name = 'Friend';
        }
        matchStarted = true;
        renderScoreboard();
        setTimeout(() => {
          document.getElementById('online-modal')?.classList.remove('active');
        }, 1200);
        showShareToast('Friend connected! Match started 🚀');
      } else if (status === 'disconnected') {
        showShareToast('Friend disconnected 🔌');
        renderScoreboard();
      }
    },
    onInitReceived: (data) => {
      state.config.gridSize = data.gridSize;
      state.config.player1Name = data.hostName || 'Friend (Host)';
      state.config.player2Name = 'You (Guest)';
      myOnlinePlayerId = 2;
      matchStarted = true;
      syncGridDropdownUI(data.gridSize);
      state = createInitialState(state.config);
      renderAll();
      document.getElementById('online-modal')?.classList.remove('active');
      showShareToast('Connected to Host! Game started 🚀');
    },
    onMoveReceived: (move: OnlineMoveData) => {
      const lineId = move.lineId || (move.orientation === 'horizontal' ? `h-${move.row}-${move.col}` : `v-${move.row}-${move.col}`);
      executeMove(lineId);
    },
    onRestartReceived: () => {
      state = createInitialState(state.config);
      renderAll();
      showShareToast('Game restarted by friend 🔄');
    },
    onGridChangeReceived: (gridSize) => {
      state.config.gridSize = gridSize;
      syncGridDropdownUI(gridSize);
      state = createInitialState(state.config);
      renderAll();
      showShareToast(`Grid updated to ${gridSize}x${gridSize}`);
    },
  });
}

async function startOnlineHost() {
  const modal = document.getElementById('online-modal');
  modal?.classList.add('active');

  const statusDesc = document.getElementById('online-status-desc');
  const statusBanner = document.getElementById('online-status-banner');
  if (statusDesc) statusDesc.textContent = 'Generating room code...';
  if (statusBanner) statusBanner.className = 'status-banner waiting';

  myOnlinePlayerId = 1;
  matchStarted = false; // Starts when guest joins
  state.config.mode = 'online';
  state.config.player1Name = 'You (Host)';
  state.config.player2Name = 'Waiting for Friend...';
  state.config.timerEnabled = false;

  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;
  if (modeSelect) modeSelect.value = 'online';
  const aiContainer = document.getElementById('ai-level-container');
  if (aiContainer) aiContainer.style.display = 'none';

  try {
    const { roomCode, inviteUrl } = await onlineManager.startHosting(undefined, state.config.gridSize, state.config.player1Name);

    const codeEl = document.getElementById('online-room-code-val');
    const linkInput = document.getElementById('online-room-link-input') as HTMLInputElement | null;
    const whatsappBtn = document.getElementById('whatsapp-share-btn') as HTMLAnchorElement | null;

    if (codeEl) codeEl.textContent = roomCode;
    if (linkInput) linkInput.value = inviteUrl;
    if (whatsappBtn) {
      whatsappBtn.href = `https://api.whatsapp.com/send?text=${encodeURIComponent("Let's play Dots and Boxes together! Click to join my game: " + inviteUrl)}`;
    }
    if (statusDesc) statusDesc.textContent = 'Waiting for friend to join...';

    // Update URL with ?room=CODE
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomCode);
      window.history.replaceState({}, '', url.toString());
    } catch {}

    state = createInitialState(state.config);
    renderAll();
  } catch (err) {
    console.error('Failed to host online room:', err);
    if (statusDesc) statusDesc.textContent = 'Error creating room. Please try again.';
    if (statusBanner) statusBanner.className = 'status-banner error';
  }
}

async function joinOnlineRoom(roomCode: string) {
  const modal = document.getElementById('online-modal');
  modal?.classList.add('active');

  const code = roomCode.trim().toUpperCase();
  const codeEl = document.getElementById('online-room-code-val');
  const linkInput = document.getElementById('online-room-link-input') as HTMLInputElement | null;
  const statusDesc = document.getElementById('online-status-desc');
  const statusBanner = document.getElementById('online-status-banner');

  if (codeEl) codeEl.textContent = code;
  if (linkInput) linkInput.value = onlineManager.getInviteUrl(code);
  if (statusDesc) statusDesc.textContent = `Connecting to room ${code}...`;
  if (statusBanner) statusBanner.className = 'status-banner waiting';

  myOnlinePlayerId = 2;
  matchStarted = false; // Becomes true on handshake
  state.config.mode = 'online';
  state.config.player1Name = 'Host';
  state.config.player2Name = 'You (Guest)';
  state.config.timerEnabled = false;

  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;
  if (modeSelect) modeSelect.value = 'online';
  const aiContainer = document.getElementById('ai-level-container');
  if (aiContainer) aiContainer.style.display = 'none';

  try {
    await onlineManager.joinRoom(code);
    if (statusDesc) statusDesc.textContent = 'Connected! Handshaking with host...';
    if (statusBanner) statusBanner.className = 'status-banner connected';
  } catch (err: any) {
    console.error('Failed to join room:', err);
    if (statusDesc) statusDesc.textContent = 'Room not found or host disconnected.';
    if (statusBanner) statusBanner.className = 'status-banner error';
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initApp() {
  const initialGridSize = getInitialGridSize();
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  // vs Computer is the default mode; if ?room=XXXXX is present, start in online mode as Guest
  const defaultConfig: GameConfig = {
    gridSize: initialGridSize,
    mode: roomParam ? 'online' : 'pve',
    aiDifficulty: 'medium',
    player1Name: roomParam ? 'Host' : 'You',
    player2Name: roomParam ? 'You (Guest)' : 'Computer',
    theme: 'default',
    soundEnabled: true,
    timerEnabled: !roomParam,
    timerDuration: 15,
  };

  state = createInitialState(defaultConfig);
  matchStarted = !roomParam;

  setupEventListeners();
  setupOnlineCallbacks();
  syncGridDropdownUI(initialGridSize);
  applyTheme(defaultConfig.theme);
  renderAll();

  if (roomParam) {
    joinOnlineRoom(roomParam);
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderBoard();
  renderScoreboard();
  renderControls();
  checkTurnTimer();

  const boardWrapper = document.querySelector('.board-wrapper');
  boardWrapper?.classList.toggle('pending-start', !matchStarted);

  if (!state.isGameOver && matchStarted) {
    if (state.config.mode === 'pve' && state.currentPlayer === 2) {
      scheduleAiMove();
    }
  }
}

function renderBoard() {
  const boxesGroup = document.getElementById('boxes-group');
  const linesGroup = document.getElementById('lines-group');
  const dotsGroup = document.getElementById('dots-group');

  if (!boxesGroup || !linesGroup || !dotsGroup) return;

  boxesGroup.innerHTML = '';
  linesGroup.innerHTML = '';
  dotsGroup.innerHTML = '';

  const N = state.config.gridSize;
  const boxCount = N - 1;
  const padding = 50;
  const boardWidth = 600 - padding * 2;
  const spacing = boardWidth / (N - 1);

  // Boxes
  for (let r = 0; r < boxCount; r++) {
    for (let c = 0; c < boxCount; c++) {
      const box = state.boxes[r][c];
      const x = padding + c * spacing;
      const y = padding + r * spacing;

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', `${x + 6}`);
      rect.setAttribute('y', `${y + 6}`);
      rect.setAttribute('width', `${spacing - 12}`);
      rect.setAttribute('height', `${spacing - 12}`);
      rect.setAttribute('rx', '8');
      rect.setAttribute('class', `board-box ${box.owner === 1 ? 'p1-box' : box.owner === 2 ? 'p2-box' : ''}`);
      boxesGroup.appendChild(rect);

      if (box.owner) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', `${x + spacing / 2}`);
        text.setAttribute('y', `${y + spacing / 2}`);
        text.setAttribute('class', `box-label ${box.owner === 1 ? 'p1-text' : 'p2-text'}`);

        if (box.owner === 1) {
          text.textContent = abbr(state.config.player1Name, 'P1');
        } else {
          text.textContent = state.config.mode === 'pve'
            ? 'CMP'
            : abbr(state.config.player2Name, 'P2');
        }
        boxesGroup.appendChild(text);
      }
    }
  }

  // Horizontal lines
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < boxCount; c++) {
      const line = state.horizontalLines[r][c];
      const x1 = padding + c * spacing;
      const y1 = padding + r * spacing;
      createSvgLine(linesGroup, line, x1, y1, x1 + spacing, y1);
    }
  }

  // Vertical lines
  for (let r = 0; r < boxCount; r++) {
    for (let c = 0; c < N; c++) {
      const line = state.verticalLines[r][c];
      const x1 = padding + c * spacing;
      const y1 = padding + r * spacing;
      createSvgLine(linesGroup, line, x1, y1, x1, y1 + spacing);
    }
  }

  // Dots
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', `${padding + c * spacing}`);
      circle.setAttribute('cy', `${padding + r * spacing}`);
      circle.setAttribute('r', N > 5 ? '7' : '9');
      circle.setAttribute('class', 'board-dot active');
      dotsGroup.appendChild(circle);
    }
  }
}

function createSvgLine(group: HTMLElement, line: Line, x1: number, y1: number, x2: number, y2: number) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  const visLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  visLine.setAttribute('x1', `${x1}`);
  visLine.setAttribute('y1', `${y1}`);
  visLine.setAttribute('x2', `${x2}`);
  visLine.setAttribute('y2', `${y2}`);

  let classes = 'board-line';
  if (!line.owner)       classes += ' empty';
  else if (line.owner === 1) classes += ' claimed-p1';
  else                   classes += ' claimed-p2';
  if (line.isLastMove)   classes += ' last-move';
  visLine.setAttribute('class', classes);

  const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  hitLine.setAttribute('x1', `${x1}`);
  hitLine.setAttribute('y1', `${y1}`);
  hitLine.setAttribute('x2', `${x2}`);
  hitLine.setAttribute('y2', `${y2}`);
  hitLine.setAttribute('stroke-width', '30'); // generous invisible tap target, especially for mobile
  hitLine.setAttribute('stroke', 'transparent');
  hitLine.setAttribute('cursor', line.owner ? 'default' : 'pointer');

  if (!line.owner && !state.isGameOver) {
    hitLine.addEventListener('mouseenter', () => visLine.classList.add('hovered'), { passive: true });
    hitLine.addEventListener('mouseleave', () => visLine.classList.remove('hovered'), { passive: true });
    hitLine.addEventListener('click', () => handleUserMove(line.id));
  }

  g.appendChild(visLine);
  g.appendChild(hitLine);
  group.appendChild(g);
}

function handleUserMove(lineId: string) {
  if (state.isGameOver) return;
  if (!matchStarted) return; // 2-Player match hasn't been confirmed yet
  if (state.config.mode === 'pve' && state.currentPlayer === 2) return;

  if (state.config.mode === 'online') {
    if (!onlineManager.isConnected()) {
      showShareToast('Waiting for friend to connect... ⏳');
      return;
    }
    if (state.currentPlayer !== myOnlinePlayerId) {
      showShareToast("It's your friend's turn! ⏳");
      return;
    }
    // Parse coordinates { row, col, orientation } from lineId (e.g. "h-1-2" or "v-0-3")
    const parts = lineId.split('-');
    const orientation = parts[0] === 'h' ? 'horizontal' : 'vertical';
    const row = parseInt(parts[1], 10);
    const col = parseInt(parts[2], 10);

    // Send move to peer via WebRTC
    onlineManager.sendMove(row, col, orientation, lineId);
  }

  executeMove(lineId);
}

function executeMove(lineId: string) {
  const { state: newState, boxesScored } = makeMove(state, lineId);
  state = newState;

  if (boxesScored > 0) {
    audioEngine.playBoxPop(state.streakCount);
  } else {
    audioEngine.playClick();
  }

  renderAll();

  if (state.isGameOver) {
    handleGameOver();
  }
}

function scheduleAiMove() {
  if (aiTimeoutId) clearTimeout(aiTimeoutId);
  aiTimeoutId = window.setTimeout(() => {
    if (state.isGameOver) return;
    try {
      let aiMoveLine = getAiMove(state, state.config.aiDifficulty);
      if (!aiMoveLine) {
        const avail = getAllAvailableLines(state);
        if (avail.length > 0) {
          aiMoveLine = avail[Math.floor(Math.random() * avail.length)];
        }
      }
      if (aiMoveLine) {
        executeMove(aiMoveLine.id);
      }
    } catch (err) {
      console.error('Error during AI turn execution:', err);
      const avail = getAllAvailableLines(state);
      if (avail.length > 0) {
        executeMove(avail[0].id);
      }
    }
  }, 650);
}

// ─── Scoreboard ──────────────────────────────────────────────────────────────

function renderScoreboard() {
  const p1Card = document.getElementById('player1-card');
  const p2Card = document.getElementById('player2-card');
  const p1Score = document.getElementById('p1-score');
  const p2Score = document.getElementById('p2-score');
  const p1Name = document.getElementById('p1-name');
  const p2Name = document.getElementById('p2-name');
  const p1Avatar = document.getElementById('p1-avatar');
  const p2Avatar = document.getElementById('p2-avatar');
  const statusMsg = document.getElementById('status-message');
  const streakBanner = document.getElementById('streak-banner');
  const streakCount = document.getElementById('streak-count');

  if (p1Card && p2Card) {
    p1Card.classList.toggle('active-turn', state.currentPlayer === 1);
    p2Card.classList.toggle('active-turn', state.currentPlayer === 2);
  }

  if (p1Score) p1Score.textContent = `${state.scores[1]}`;
  if (p2Score) p2Score.textContent = `${state.scores[2]}`;

  const isOnline = state.config.mode === 'online';
  const isHuman2 = state.config.mode === 'pvp' || state.config.mode === 'sandbox' || isOnline;

  if (p1Name && document.activeElement !== p1Name) {
    if (isOnline) {
      p1Name.textContent = myOnlinePlayerId === 1 ? 'You (Host)' : (state.config.player1Name || 'Host');
    } else {
      p1Name.textContent = state.config.player1Name;
    }
  }

  if (p2Name) {
    if (isOnline) {
      if (myOnlinePlayerId === 2) {
        p2Name.textContent = 'You (Guest)';
      } else {
        p2Name.textContent = onlineManager.isConnected() ? (state.config.player2Name || 'Friend') : 'Waiting for Friend...';
      }
    } else {
      p2Name.textContent = isHuman2 ? state.config.player2Name : 'Computer';
    }
  }

  if (p1Avatar) {
    p1Avatar.textContent = isOnline
      ? (myOnlinePlayerId === 1 ? 'YOU' : 'HST')
      : abbr(state.config.player1Name, 'P1');
  }

  if (p2Avatar) {
    if (isOnline) {
      p2Avatar.textContent = myOnlinePlayerId === 2 ? 'YOU' : 'FRD';
    } else {
      p2Avatar.textContent = state.config.mode === 'pve'
        ? 'CMP'
        : abbr(state.config.player2Name, 'P2');
    }
  }

  if (statusMsg) {
    if (isOnline) {
      if (!onlineManager.isConnected()) {
        statusMsg.textContent = myOnlinePlayerId === 1
          ? 'Waiting for friend to join... ⏳'
          : 'Connecting to host... ⏳';
      } else if (state.isGameOver) {
        if (state.winner === myOnlinePlayerId) {
          statusMsg.textContent = 'You Won! 🎉🏆';
        } else if (!state.winner) {
          statusMsg.textContent = "It's a Tie! 🤝";
        } else {
          statusMsg.textContent = 'Friend Won! 🏆';
        }
      } else {
        if (state.currentPlayer === myOnlinePlayerId) {
          statusMsg.textContent = 'Your Turn! ⚡';
        } else {
          statusMsg.textContent = "Friend's Turn... ⏳";
        }
      }
    } else if (!matchStarted) {
      statusMsg.textContent = 'Enter names to start the match ⬆️';
    } else if (state.isGameOver) {
      if (state.winner === 1) statusMsg.textContent = `${state.config.player1Name} Wins! 🎉`;
      else if (state.winner === 2) {
        const p2Label = isHuman2 ? state.config.player2Name : 'Computer';
        statusMsg.textContent = `${p2Label} Wins! 🎉`;
      } else {
        statusMsg.textContent = "It's a Tie! 🤝";
      }
    } else {
      if (state.config.mode === 'pve' && state.currentPlayer === 2) {
        statusMsg.textContent = 'Computer is thinking... 🧠';
      } else {
        const currName = state.currentPlayer === 1
          ? state.config.player1Name
          : (isHuman2 ? state.config.player2Name : 'Computer');
        statusMsg.textContent = `${currName}'s Turn`;
      }
    }
  }

  if (streakBanner && streakCount) {
    if (state.streakCount > 1) {
      streakBanner.classList.remove('hidden');
      streakCount.textContent = `${state.streakCount}`;
    } else {
      streakBanner.classList.add('hidden');
    }
  }
}

function renderControls() {
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  const isOnline = state.config.mode === 'online';
  if (undoBtn) undoBtn.disabled = isOnline || state.history.length === 0 || state.isGameOver;
  if (redoBtn) redoBtn.disabled = isOnline || state.redoStack.length === 0 || state.isGameOver;
}

// ─── Timer ───────────────────────────────────────────────────────────────────

function checkTurnTimer() {
  const timerBadge = document.getElementById('turn-timer');
  const timerText = document.getElementById('timer-text');

  if (timerInterval) clearInterval(timerInterval);

  if (!state.config.timerEnabled || state.config.timerDuration === 0 || state.isGameOver) {
    if (timerBadge) timerBadge.style.display = 'none';
    return;
  }

  if (timerBadge) timerBadge.style.display = 'inline-flex';
  if (timerText) timerText.textContent = `${state.turnTimer}s`;

  timerInterval = window.setInterval(() => {
    state.turnTimer--;
    if (timerText) timerText.textContent = `${state.turnTimer}s`;
    if (state.turnTimer <= 0) {
      clearInterval(timerInterval!);
      const avail = getAllAvailableLines(state);
      if (avail.length > 0) {
        executeMove(avail[Math.floor(Math.random() * avail.length)].id);
      }
    }
  }, 1000);
}

// ─── Game Over ───────────────────────────────────────────────────────────────

function handleGameOver() {
  if (timerInterval) clearInterval(timerInterval);

  recordGameResult(
    state.winner as PlayerId | 'tie',
    state.scores[1],
    state.scores[2],
    state.config.mode === 'pve',
    state.config.aiDifficulty,
    state.streakCount
  );

  if (state.winner === 1) {
    audioEngine.playWinFanfare();
    launchConfetti();
  }

  showVictoryModal();
}

function showVictoryModal() {
  const modal = document.getElementById('victory-modal');
  const title = document.getElementById('winner-title');
  const subtitle = document.getElementById('winner-subtitle');
  const p1NameEl = document.getElementById('modal-p1-name');
  const p2NameEl = document.getElementById('modal-p2-name');
  const p1ScoreEl = document.getElementById('modal-p1-score');
  const p2ScoreEl = document.getElementById('modal-p2-score');

  if (!modal) return;

  const isOnline = state.config.mode === 'online';
  let p1Label = state.config.player1Name;
  let p2Label = state.config.mode === 'pve' ? 'Computer' : state.config.player2Name;

  if (isOnline) {
    p1Label = myOnlinePlayerId === 1 ? 'You (Host)' : (state.config.player1Name || 'Host');
    p2Label = myOnlinePlayerId === 2 ? 'You (Guest)' : (state.config.player2Name || 'Friend');
  }

  if (p1NameEl) p1NameEl.textContent = p1Label;
  if (p2NameEl) p2NameEl.textContent = p2Label;
  if (p1ScoreEl) p1ScoreEl.textContent = `${state.scores[1]}`;
  if (p2ScoreEl) p2ScoreEl.textContent = `${state.scores[2]}`;

  if (title) {
    if (isOnline) {
      if (state.winner === myOnlinePlayerId) title.textContent = 'YOU WON! 🎉🏆';
      else if (state.winner) title.textContent = 'FRIEND WON! 🏆';
      else title.textContent = 'DRAW MATCH! 🤝';
    } else {
      if (state.winner === 1) title.textContent = `${state.config.player1Name.toUpperCase()} VICTORY! 🎉`;
      else if (state.winner === 2) title.textContent = `${p2Label.toUpperCase()} VICTORY! 🎉`;
      else title.textContent = 'DRAW MATCH! 🤝';
    }
  }
  if (subtitle) subtitle.textContent = `Final Score: ${state.scores[1]} vs ${state.scores[2]}`;

  modal.classList.add('active');
}

// ─── Player Names Panel (2-Player mode only) ──────────────────────────────────
// This is a small anchored dropdown, portaled to document.body and positioned
// next to the mode selector — never a full-screen blocking modal. It only
// ever appears for 2-Player mode, and only before that match has started.

function positionNamesPanel() {
  const panel = document.getElementById('player-names-modal');
  const modeSelect = document.getElementById('mode-select');
  if (!panel || !modeSelect) return;

  const rect = modeSelect.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 300;
  let left = rect.left;
  if (left + panelWidth > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - panelWidth - 12);
  }
  panel.style.top = `${rect.bottom + 8}px`;
  panel.style.left = `${left}px`;
}

function openPlayerNamesPanel() {
  const namesModal = document.getElementById('player-names-modal');
  const p1Input = document.getElementById('p1-name-input') as HTMLInputElement;
  const p2Input = document.getElementById('p2-name-input') as HTMLInputElement;

  if (timerInterval) clearInterval(timerInterval);

  if (p1Input) p1Input.value = getStoredName(PVP_P1_STORAGE_KEY) || 'Player 1';
  if (p2Input) p2Input.value = getStoredName(PVP_P2_STORAGE_KEY) || 'Player 2';

  // Portal to body so it's never clipped by any ancestor container
  if (namesModal && namesModal.parentElement !== document.body) {
    document.body.appendChild(namesModal);
  }

  positionNamesPanel();
  namesModal?.classList.add('open');

  setTimeout(() => p1Input?.focus(), 100);
}

function closePlayerNamesPanel() {
  document.getElementById('player-names-modal')?.classList.remove('open');
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
  // New Game Button
  document.getElementById('new-game-btn')?.addEventListener('click', () => {
    audioEngine.playButtonClick();
    if (state.config.mode === 'online') {
      if (onlineManager.isConnected()) {
        onlineManager.sendRestart();
      }
      state = createInitialState(state.config);
      renderAll();
      showShareToast('Match restarted 🔄');
    } else if (state.config.mode === 'pvp') {
      // Reset back to the pre-match state and ask for names again
      matchStarted = false;
      state = createInitialState(state.config);
      renderAll();
      openPlayerNamesPanel();
    } else {
      state = createInitialState(state.config);
      renderAll();
    }
  });

  // Undo Button
  document.getElementById('undo-btn')?.addEventListener('click', () => {
    audioEngine.playButtonClick();
    const updated = undoMove(state);
    if (updated) {
      state = updated;
      if (state.config.mode === 'pve' && state.currentPlayer === 2 && state.history.length > 0) {
        const undoAgain = undoMove(state);
        if (undoAgain) state = undoAgain;
      }
      renderAll();
    }
  });

  // Redo Button
  document.getElementById('redo-btn')?.addEventListener('click', () => {
    audioEngine.playButtonClick();
    if (state.redoStack.length > 0) {
      executeMove(state.redoStack[state.redoStack.length - 1].lineId);
    }
  });

  // Mode Selector
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  modeSelect?.addEventListener('change', (e) => {
    const newMode = (e.target as HTMLSelectElement).value as any;

    if (state.config.mode === 'online' && newMode !== 'online') {
      onlineManager.cleanup();
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
      } catch {}
    }

    state.config.mode = newMode;

    const aiContainer = document.getElementById('ai-level-container');
    if (aiContainer) aiContainer.style.display = newMode === 'pve' ? 'flex' : 'none';

    if (newMode === 'online') {
      closePlayerNamesPanel();
      startOnlineHost();
    } else if (newMode === 'pvp') {
      // Lock the board and ask for both names before the match begins
      matchStarted = false;
      closePlayerNamesPanel();
      state = createInitialState(state.config);
      renderAll();
      openPlayerNamesPanel();
    } else {
      closePlayerNamesPanel();
      matchStarted = true;
      if (newMode === 'pve') {
        state.config.player1Name = 'You';
        state.config.player2Name = 'Computer';
      } else {
        // Self Practice
        state.config.player1Name = 'Player 1';
        state.config.player2Name = 'Player 2';
      }
      state = createInitialState(state.config);
      renderAll();
    }
  });

  // Custom Dropdowns in Game Settings
  setupCustomDropdowns();

  // Sound Toggle
  const soundBtn = document.getElementById('sound-toggle-btn');
  soundBtn?.addEventListener('click', () => {
    const isMuted = !audioEngine.getMuted();
    audioEngine.setMuted(isMuted);
    document.getElementById('sound-icon-on')?.classList.toggle('hidden', isMuted);
    document.getElementById('sound-icon-off')?.classList.toggle('hidden', !isMuted);
  });

  setupModalListeners();
}

function setupCustomDropdowns() {
  const dropdowns = document.querySelectorAll<HTMLElement>('.custom-dropdown');

  dropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector<HTMLButtonElement>('.dropdown-trigger');
    const menu = dropdown.querySelector<HTMLUListElement>('.dropdown-menu');
    const options = dropdown.querySelectorAll<HTMLLIElement>('.dropdown-option');
    const selectedText = dropdown.querySelector<HTMLElement>('.dropdown-selected-text');
    const hiddenInput = dropdown.querySelector<HTMLInputElement>('input[type="hidden"]');
    const dropdownType = dropdown.getAttribute('data-dropdown');

    if (!trigger || !menu) return;

    // Portal Pattern: Move menu directly into document.body to avoid any parent clipping
    if (menu.parentElement !== document.body) {
      document.body.appendChild(menu);
    }

    const updatePosition = () => {
      const rect = trigger.getBoundingClientRect();
      const menuWidth = Math.max(rect.width, 160);
      let left = rect.left;
      if (left + menuWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - menuWidth - 12);
      }
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.left = `${left}px`;
      menu.style.minWidth = `${rect.width}px`;
    };

    const closeDropdown = () => {
      dropdown.classList.remove('open');
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    };

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');

      // Close all other custom dropdowns and menus
      dropdowns.forEach(d => {
        if (d !== dropdown) {
          d.classList.remove('open');
          d.querySelector<HTMLButtonElement>('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
        }
      });
      document.querySelectorAll<HTMLUListElement>('.dropdown-menu').forEach(m => {
        if (m !== menu) m.classList.remove('open');
      });

      if (!isOpen) {
        updatePosition();
        dropdown.classList.add('open');
        menu.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        menu.focus();
      } else {
        closeDropdown();
      }
    });

    // Option click
    options.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = option.getAttribute('data-value') || '';
        const label = option.textContent?.trim() || '';

        // Update selected state
        options.forEach(opt => {
          opt.classList.remove('selected');
          opt.setAttribute('aria-selected', 'false');
        });
        option.classList.add('selected');
        option.setAttribute('aria-selected', 'true');

        if (selectedText) {
          selectedText.textContent = label;
        }

        if (hiddenInput) {
          hiddenInput.value = value;
        }

        closeDropdown();
        trigger.focus();

        // Handle specific settings
        if (dropdownType === 'grid-size') {
          const newSize = parseInt(value, 10);
          if (state.config.gridSize !== newSize) {
            state.config.gridSize = newSize;
            if (state.config.mode === 'online' && onlineManager.isHost()) {
              onlineManager.sendGridChange(newSize);
            }
            state = createInitialState(state.config);
            renderAll();

            // Update URL ?grid= parameter for bookmarking and shareability
            try {
              const url = new URL(window.location.href);
              url.searchParams.set('grid', `${newSize}x${newSize}`);
              window.history.replaceState({}, '', url.toString());
            } catch {
              // Ignore history error
            }
          }
        } else if (dropdownType === 'ai-level') {
          state.config.aiDifficulty = value as any;
        } else if (dropdownType === 'timer') {
          const duration = parseInt(value, 10);
          state.config.timerEnabled = duration > 0;
          state.config.timerDuration = duration;
          state.turnTimer = duration;
          checkTurnTimer();
        }
      });
    });

    // Keyboard navigation within dropdown
    dropdown.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
        trigger.focus();
      }
    });

    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
        trigger.focus();
      }
    });
  });

  // Reposition open menus on scroll or resize
  window.addEventListener('scroll', () => {
    dropdowns.forEach(d => {
      if (d.classList.contains('open')) {
        const trigger = d.querySelector<HTMLButtonElement>('.dropdown-trigger');
        const dropdownType = d.getAttribute('data-dropdown');
        const menu = document.querySelector<HTMLUListElement>(`ul[aria-labelledby="${dropdownType}-label"]`) ||
                     document.querySelector<HTMLUListElement>('.dropdown-menu.open');
        if (trigger && menu) {
          const rect = trigger.getBoundingClientRect();
          menu.style.top = `${rect.bottom + 6}px`;
          menu.style.left = `${rect.left}px`;
        }
      }
    });
  }, { passive: true });

  window.addEventListener('resize', () => {
    dropdowns.forEach(d => {
      if (d.classList.contains('open')) {
        const trigger = d.querySelector<HTMLButtonElement>('.dropdown-trigger');
        const dropdownType = d.getAttribute('data-dropdown');
        const menu = document.querySelector<HTMLUListElement>(`ul[aria-labelledby="${dropdownType}-label"]`) ||
                     document.querySelector<HTMLUListElement>('.dropdown-menu.open');
        if (trigger && menu) {
          const rect = trigger.getBoundingClientRect();
          menu.style.top = `${rect.bottom + 6}px`;
          menu.style.left = `${rect.left}px`;
        }
      }
    });
  }, { passive: true });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    dropdowns.forEach(d => {
      const trigger = d.querySelector<HTMLButtonElement>('.dropdown-trigger');
      if (trigger && !trigger.contains(target)) {
        d.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    document.querySelectorAll<HTMLUListElement>('.dropdown-menu').forEach(menu => {
      if (!menu.contains(target)) {
        menu.classList.remove('open');
      }
    });
  });
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
}

function setupModalListeners() {
  const p1Input = document.getElementById('p1-name-input') as HTMLInputElement;
  const p2Input = document.getElementById('p2-name-input') as HTMLInputElement;

  // "Start Battle" button — locks in both names and starts the 2-Player match
  document.getElementById('start-2p-btn')?.addEventListener('click', () => {
    const name1 = p1Input?.value.trim() || 'Player 1';
    const name2 = p2Input?.value.trim() || 'Player 2';
    state.config.player1Name = name1;
    state.config.player2Name = name2;
    setStoredName(PVP_P1_STORAGE_KEY, name1);
    setStoredName(PVP_P2_STORAGE_KEY, name2);

    closePlayerNamesPanel();
    matchStarted = true;
    state = createInitialState(state.config);
    renderAll();
  });

  // Allow pressing Enter to submit
  [p1Input, p2Input].forEach(inp => {
    inp?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        document.getElementById('start-2p-btn')?.click();
      }
    });
  });

  // Reposition the names panel on resize/scroll while it's open
  window.addEventListener('resize', () => {
    if (document.getElementById('player-names-modal')?.classList.contains('open')) {
      positionNamesPanel();
    }
  }, { passive: true });

  // Share Result button (Victory Modal)
  document.getElementById('share-result-btn')?.addEventListener('click', async () => {
    const p2Label = state.config.mode === 'pve' ? 'Computer' : state.config.player2Name;
    const winnerName = state.winner === 1
      ? state.config.player1Name
      : (state.winner === 2 ? p2Label : 'Nobody');

    const winnerLine = state.winner
      ? `🏆 ${winnerName} Won! (${state.scores[1]} - ${state.scores[2]})`
      : `🤝 Draw Match! (${state.scores[1]} - ${state.scores[2]})`;

    const gridSizeText = `${state.config.gridSize}x${state.config.gridSize} (${state.config.gridSize - 1}x${state.config.gridSize - 1} Boxes)`;

    const shareText = `🟦🟥 Dots and Boxes (BoxBattle)
${winnerLine}
📏 Grid: ${gridSizeText}
⚔️ Can you beat my score? Play free: https://playdotsandboxes.com/`;

    const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 0 && window.innerWidth < 768);

    if (isMobile && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Dots and Boxes (BoxBattle)',
          text: shareText,
        });
      } catch (err: any) {
        if (err && err.name !== 'AbortError') {
          await copyToClipboard(shareText);
        }
      }
    } else {
      await copyToClipboard(shareText);
    }
  });

  // Tutorial Modal
  const tutModal = document.getElementById('tutorial-modal');
  document.getElementById('open-tutorial-btn')?.addEventListener('click', () => tutModal?.classList.add('active'));
  document.getElementById('close-tutorial-btn')?.addEventListener('click', () => tutModal?.classList.remove('active'));
  document.getElementById('got-it-btn')?.addEventListener('click', () => tutModal?.classList.remove('active'));

  // Stats Modal
  const statsModal = document.getElementById('stats-modal');
  document.getElementById('open-stats-btn')?.addEventListener('click', () => {
    updateStatsDisplay();
    statsModal?.classList.add('active');
  });
  document.getElementById('close-stats-btn')?.addEventListener('click', () => statsModal?.classList.remove('active'));
  document.getElementById('reset-stats-btn')?.addEventListener('click', () => {
    resetStats();
    updateStatsDisplay();
  });

  // Online Multiplayer Modal
  const onlineModal = document.getElementById('online-modal');
  document.getElementById('online-match-btn')?.addEventListener('click', () => {
    audioEngine.playButtonClick();
    startOnlineHost();
  });

  document.getElementById('close-online-btn')?.addEventListener('click', () => {
    onlineModal?.classList.remove('active');
  });

  onlineModal?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'online-modal') {
      onlineModal?.classList.remove('active');
    }
  });

  document.getElementById('copy-online-link-btn')?.addEventListener('click', async () => {
    const linkInput = document.getElementById('online-room-link-input') as HTMLInputElement | null;
    if (linkInput && linkInput.value) {
      await copyToClipboard(linkInput.value);
      const textSpan = document.getElementById('copy-link-text');
      if (textSpan) {
        const orig = textSpan.textContent;
        textSpan.textContent = 'Copied! ✅';
        setTimeout(() => {
          textSpan.textContent = orig || 'Copy Invite Link';
        }, 2000);
      }
    }
  });

  const manualJoinInput = document.getElementById('manual-room-input') as HTMLInputElement | null;
  const triggerManualJoin = () => {
    const code = manualJoinInput?.value.trim();
    if (code) {
      joinOnlineRoom(code);
    } else {
      showShareToast('Please enter a room code');
    }
  };
  document.getElementById('manual-join-btn')?.addEventListener('click', triggerManualJoin);
  manualJoinInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerManualJoin();
  });

  // Victory Modal
  const vicModal = document.getElementById('victory-modal');
  document.getElementById('close-victory-btn')?.addEventListener('click', () => vicModal?.classList.remove('active'));
  document.getElementById('rematch-btn')?.addEventListener('click', () => {
    vicModal?.classList.remove('active');
    if (state.config.mode === 'online' && onlineManager.isConnected()) {
      onlineManager.sendRestart();
    }
    state = createInitialState(state.config);
    renderAll();
  });
}

async function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    showShareToast('Copied to clipboard! 📋');

    const btn = document.getElementById('share-result-btn');
    if (btn) {
      const originalHtml = btn.innerHTML;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Copied!</span>
      `;
      setTimeout(() => {
        btn.innerHTML = originalHtml;
      }, 2000);
    }
  } catch {
    showShareToast('Unable to copy automatically');
  }
}

function showShareToast(message: string = 'Copied to clipboard! 📋') {
  const toast = document.getElementById('share-toast');
  if (!toast) return;
  const span = toast.querySelector('span');
  if (span) span.textContent = message;
  toast.classList.remove('hidden');
  void toast.offsetWidth; // trigger reflow
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2200);
}

// ─── Stats Display ───────────────────────────────────────────────────────────

function updateStatsDisplay() {
  const stats = loadStats();

  // Matchup banner
  const p1NameDisplay = document.getElementById('stat-p1-name-display');
  const p2NameDisplay = document.getElementById('stat-p2-name-display');
  const p1WinCount = document.getElementById('stat-p1-win-count');
  const p2WinCount = document.getElementById('stat-p2-win-count');
  if (p1NameDisplay) p1NameDisplay.textContent = state.config.player1Name;
  if (p2NameDisplay) p2NameDisplay.textContent = state.config.mode === 'pve' ? 'Computer' : state.config.player2Name;
  if (p1WinCount) p1WinCount.textContent = `${stats.p1Wins} Wins`;
  if (p2WinCount) p2WinCount.textContent = `${stats.p2Wins} Wins`;

  // Grid stats
  const total = document.getElementById('stat-total-games');
  const winRate = document.getElementById('stat-win-rate');
  const boxes = document.getElementById('stat-total-boxes');
  const streak = document.getElementById('stat-streak');
  if (total) total.textContent = `${stats.gamesPlayed}`;
  if (boxes) boxes.textContent = `${stats.totalBoxesCompleted}`;
  if (streak) streak.textContent = `${stats.longestStreak}`;
  const pct = stats.gamesPlayed > 0 ? Math.round((stats.p1Wins / stats.gamesPlayed) * 100) : 0;
  if (winRate) winRate.textContent = `${pct}%`;

  // AI level conquests
  const easy = document.getElementById('stat-easy-wins');
  const medium = document.getElementById('stat-medium-wins');
  const hard = document.getElementById('stat-hard-wins');
  if (easy) easy.textContent = `${stats.easyAiWins}`;
  if (medium) medium.textContent = `${stats.mediumAiWins}`;
  if (hard) hard.textContent = `${stats.hardAiWins}`;
}
