import { createInitialState, makeMove, undoMove, getAllAvailableLines } from './gameEngine';
import { getAiMove } from './aiEngine';
import { audioEngine } from './audioEngine';
import { loadStats, recordGameResult, resetStats } from './statsEngine';
import { launchConfetti } from './confetti';
import type { GameConfig, GameState, Line, PlayerId } from './types';

let state: GameState;
let timerInterval: number | null = null;
let aiTimeoutId: number | null = null;

const STORAGE_KEY = 'boxbattle_player_name';

// ─── Helper ─────────────────────────────────────────────────────────────────

function abbr(name: string, fallback: string): string {
  const t = (name || '').trim();
  return t.length > 0 ? t.substring(0, 3).toUpperCase() : fallback;
}

function getStoredPlayerName(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredPlayerName(name: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Ignore storage errors
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initApp() {
  const defaultConfig: GameConfig = {
    gridSize: 4,
    mode: 'pve',
    aiDifficulty: 'medium',
    player1Name: 'Player 1',
    player2Name: 'Computer',
    theme: 'default',
    soundEnabled: true,
    timerEnabled: true,
    timerDuration: 15,
  };

  const storedName = getStoredPlayerName();
  if (storedName) {
    defaultConfig.player1Name = storedName;
  }

  state = createInitialState(defaultConfig);

  setupEventListeners();
  applyTheme(defaultConfig.theme);

  // Show name-entry modal only if no stored name exists
  if (!storedName) {
    openPlayerNamesModal('pve');
  } else {
    renderAll();
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderBoard();
  renderScoreboard();
  renderControls();
  checkTurnTimer();

  if (!state.isGameOver) {
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
  hitLine.setAttribute('stroke-width', '24');
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
  if (state.config.mode === 'pve' && state.currentPlayer === 2) return;
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

  if (p1Name && document.activeElement !== p1Name) {
    p1Name.textContent = state.config.player1Name;
  }

  const isHuman2 = state.config.mode === 'pvp' || state.config.mode === 'sandbox';
  if (p2Name) {
    p2Name.setAttribute('contenteditable', isHuman2 ? 'true' : 'false');
    if (document.activeElement !== p2Name) {
      p2Name.textContent = isHuman2 ? state.config.player2Name : 'Computer';
    }
  }

  if (p1Avatar) p1Avatar.textContent = abbr(state.config.player1Name, 'P1');
  if (p2Avatar) {
    p2Avatar.textContent = state.config.mode === 'pve'
      ? 'CMP'
      : abbr(state.config.player2Name, 'P2');
  }

  if (statusMsg) {
    if (state.isGameOver) {
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
  if (undoBtn) undoBtn.disabled = state.history.length === 0 || state.isGameOver;
  if (redoBtn) redoBtn.disabled = state.redoStack.length === 0 || state.isGameOver;
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

  const p2Label = state.config.mode === 'pve' ? 'Computer' : state.config.player2Name;
  if (p1NameEl) p1NameEl.textContent = state.config.player1Name;
  if (p2NameEl) p2NameEl.textContent = p2Label;
  if (p1ScoreEl) p1ScoreEl.textContent = `${state.scores[1]}`;
  if (p2ScoreEl) p2ScoreEl.textContent = `${state.scores[2]}`;

  if (title) {
    if (state.winner === 1) title.textContent = `${state.config.player1Name.toUpperCase()} VICTORY! 🎉`;
    else if (state.winner === 2) title.textContent = `${p2Label.toUpperCase()} VICTORY! 🎉`;
    else title.textContent = 'DRAW MATCH! 🤝';
  }
  if (subtitle) subtitle.textContent = `Final Score: ${state.scores[1]} vs ${state.scores[2]}`;

  modal.classList.add('active');
}

// ─── Player Names Modal ───────────────────────────────────────────────────────

function openPlayerNamesModal(mode: string) {
  const namesModal = document.getElementById('player-names-modal');
  const titleEl = document.getElementById('names-modal-title');
  const descEl = document.getElementById('names-modal-desc');
  const p1Label = namesModal?.querySelector('.p1-input-group label');
  const p2Group = document.getElementById('p2-name-group');
  const p1Input = document.getElementById('p1-name-input') as HTMLInputElement;
  const p2Input = document.getElementById('p2-name-input') as HTMLInputElement;
  const startBtn = document.getElementById('start-2p-btn');

  // Stop any running timer while modal is open
  if (timerInterval) clearInterval(timerInterval);

  if (mode === 'pvp') {
    if (titleEl) titleEl.textContent = '⚔️ 2 Player Mode';
    if (descEl) descEl.textContent = 'Enter names for both players to start the match.';
    if (p1Label) p1Label.innerHTML = '<span class="player-dot p1-dot"></span> Player 1 Name';
    if (p2Group) p2Group.style.display = 'flex';
    if (startBtn) startBtn.textContent = 'Start Battle 🚀';
    if (p1Input) p1Input.value = state.config.player1Name !== 'Player 1' ? state.config.player1Name : 'Player 1';
    if (p2Input) p2Input.value = (state.config.player2Name !== 'Computer' && state.config.player2Name !== 'Player 2')
      ? state.config.player2Name : 'Player 2';
  } else {
    if (titleEl) titleEl.textContent = '🎮 Welcome to BoxBattle';
    if (descEl) descEl.textContent = mode === 'sandbox'
      ? 'Enter your name to start the self-practice session.'
      : 'Enter your name to play against the Computer.';
    if (p1Label) p1Label.innerHTML = '<span class="player-dot p1-dot"></span> Your Name';
    if (p2Group) p2Group.style.display = 'none';
    if (startBtn) startBtn.textContent = "Let's Play 🚀";
    if (p1Input) p1Input.value = state.config.player1Name !== 'Player 1' ? state.config.player1Name : '';
  }

  namesModal?.classList.add('active');

  // Focus the P1 input after a small delay
  setTimeout(() => p1Input?.focus(), 100);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
  // New Game Button — start new game with stored name
  document.getElementById('new-game-btn')?.addEventListener('click', () => {
    audioEngine.playButtonClick();
    state = createInitialState(state.config);
    renderAll();
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

  // Editable Player Name (scoreboard inline edit)
  const p1NameElem = document.getElementById('p1-name');
  p1NameElem?.addEventListener('input', () => {
    state.config.player1Name = p1NameElem.textContent?.trim() || 'Player 1';
  });

  const p2NameElem = document.getElementById('p2-name');
  p2NameElem?.addEventListener('input', () => {
    if (state.config.mode === 'pvp' || state.config.mode === 'sandbox') {
      state.config.player2Name = p2NameElem.textContent?.trim() || 'Player 2';
    }
  });

  // Mode Selector
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  modeSelect?.addEventListener('change', (e) => {
    const newMode = (e.target as HTMLSelectElement).value as any;
    state.config.mode = newMode;

    if (newMode === 'pve') {
      state.config.player2Name = 'Computer';
    } else if (newMode !== 'pvp' && state.config.player2Name === 'Computer') {
      state.config.player2Name = 'Player 2';
    }

    const aiContainer = document.getElementById('ai-level-container');
    if (aiContainer) aiContainer.style.display = newMode === 'pve' ? 'flex' : 'none';

    // Always ask for names when switching mode
    openPlayerNamesModal(newMode);
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
            state = createInitialState(state.config);
            renderAll();
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
  const namesModal = document.getElementById('player-names-modal');
  const p1Input = document.getElementById('p1-name-input') as HTMLInputElement;
  const p2Input = document.getElementById('p2-name-input') as HTMLInputElement;

  // "Let's Play / Start Battle" button
  document.getElementById('start-2p-btn')?.addEventListener('click', () => {
    const name1 = p1Input?.value.trim() || 'Player 1';
    const name2 = state.config.mode === 'pvp' ? (p2Input?.value.trim() || 'Player 2') : 'Computer';
    state.config.player1Name = name1;
    state.config.player2Name = name2;
    // Store the player name for this browser session
    setStoredPlayerName(name1);
    namesModal?.classList.remove('active');
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

  // Victory Modal
  const vicModal = document.getElementById('victory-modal');
  document.getElementById('close-victory-btn')?.addEventListener('click', () => vicModal?.classList.remove('active'));
  document.getElementById('rematch-btn')?.addEventListener('click', () => {
    vicModal?.classList.remove('active');
    state = createInitialState(state.config);
    renderAll();
  });
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
