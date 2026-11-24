import { Peer, type DataConnection } from 'peerjs';

export type OnlineRole = 'host' | 'guest' | null;
export type OnlineStatus = 'idle' | 'hosting' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface OnlineMoveData {
  row: number;
  col: number;
  orientation: 'horizontal' | 'vertical';
  lineId: string;
}

export type OnlineMessage =
  | { type: 'INIT'; gridSize: number; hostName: string }
  | { type: 'MOVE'; row: number; col: number; orientation: 'horizontal' | 'vertical'; lineId: string }
  | { type: 'RESTART'; gridSize?: number }
  | { type: 'GRID_CHANGE'; gridSize: number };

export interface OnlineCallbacks {
  onStatusChange?: (status: OnlineStatus, message?: string) => void;
  onMoveReceived?: (move: OnlineMoveData) => void;
  onInitReceived?: (data: { gridSize: number; hostName: string }) => void;
  onRestartReceived?: () => void;
  onGridChangeReceived?: (gridSize: number) => void;
}

const PEER_PREFIX = 'dotsboxes-';
const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return code;
}

export class OnlineManager {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private role: OnlineRole = null;
  private currentRoomCode: string | null = null;
  private status: OnlineStatus = 'idle';
  private callbacks: OnlineCallbacks = {};

  constructor(callbacks?: OnlineCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks;
    }
  }

  public setCallbacks(callbacks: OnlineCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public getRole(): OnlineRole {
    return this.role;
  }

  public isHost(): boolean {
    return this.role === 'host';
  }

  public getMyPlayerId(): 1 | 2 {
    return this.role === 'host' ? 1 : 2;
  }

  public isConnected(): boolean {
    return this.status === 'connected' && !!this.connection && this.connection.open;
  }

  public getRoomCode(): string | null {
    return this.currentRoomCode;
  }

  public getInviteUrl(code?: string): string {
    const targetCode = code || this.currentRoomCode || '';
    const base = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://playdotsandboxes.com/';
    return `${base}?room=${targetCode}`;
  }

  private setStatus(status: OnlineStatus, message?: string) {
    this.status = status;
    this.callbacks.onStatusChange?.(status, message);
  }

  /**
   * Start hosting a game session
   */
  public async startHosting(customCode?: string, initialGridSize: number = 4, hostName: string = 'Host'): Promise<{ roomCode: string; inviteUrl: string }> {
    this.cleanup();

    const roomCode = (customCode || generateRoomCode()).toUpperCase();
    this.currentRoomCode = roomCode;
    this.role = 'host';
    this.setStatus('hosting', 'Waiting for friend to join...');

    const peerId = `${PEER_PREFIX}${roomCode.toLowerCase()}`;

    return new Promise((resolve, reject) => {
      try {
        const peer = new Peer(peerId, {
          debug: 1,
        });

        this.peer = peer;

        peer.on('open', () => {
          resolve({
            roomCode,
            inviteUrl: this.getInviteUrl(roomCode),
          });
        });

        peer.on('connection', (conn) => {
          // Accept incoming guest connection
          this.connection = conn;
          this.setupConnection(conn, () => {
            // Once open, host transmits current grid size and name
            this.sendMessage({
              type: 'INIT',
              gridSize: initialGridSize,
              hostName,
            });
            this.setStatus('connected', 'Friend connected! Game starting...');
          });
        });

        peer.on('error', (err: any) => {
          console.error('[OnlineManager] Host Peer error:', err);
          if (err.type === 'unavailable-id') {
            // ID already taken, retry with a fresh code if auto-generating
            if (!customCode) {
              this.startHosting(undefined, initialGridSize, hostName).then(resolve).catch(reject);
              return;
            }
          }
          this.setStatus('error', err.message || 'Connection error occurred');
          reject(err);
        });
      } catch (err) {
        this.setStatus('error', 'Failed to initialize peer');
        reject(err);
      }
    });
  }

  /**
   * Join an existing game session as guest
   */
  public async joinRoom(roomCode: string): Promise<void> {
    this.cleanup();

    const code = roomCode.trim().toUpperCase();
    this.currentRoomCode = code;
    this.role = 'guest';
    this.setStatus('connecting', `Connecting to room ${code}...`);

    const targetPeerId = `${PEER_PREFIX}${code.toLowerCase()}`;

    return new Promise((resolve, reject) => {
      try {
        // Guest creates an anonymous peer
        const peer = new Peer({
          debug: 1,
        });

        this.peer = peer;

        peer.on('open', () => {
          const conn = peer.connect(targetPeerId, {
            reliable: true,
          });

          this.connection = conn;

          conn.on('open', () => {
            this.setStatus('connected', 'Connected to room! Starting game...');
            this.setupConnection(conn);
            resolve();
          });

          conn.on('error', (err) => {
            console.error('[OnlineManager] Guest connection error:', err);
            this.setStatus('error', 'Unable to connect to host');
            reject(err);
          });
        });

        peer.on('error', (err) => {
          console.error('[OnlineManager] Guest peer error:', err);
          this.setStatus('error', 'Peer connection failed');
          reject(err);
        });

        // Timeout fallback if host is offline or not found
        setTimeout(() => {
          if (this.status === 'connecting') {
            this.setStatus('error', 'Room not found or host is offline');
            reject(new Error('Connection timed out'));
          }
        }, 12000);
      } catch (err) {
        this.setStatus('error', 'Failed to initialize guest connection');
        reject(err);
      }
    });
  }

  private setupConnection(conn: DataConnection, onReady?: () => void) {
    conn.on('open', () => {
      onReady?.();
    });

    conn.on('data', (data: any) => {
      if (!data || typeof data !== 'object') return;
      const msg = data as OnlineMessage;

      switch (msg.type) {
        case 'INIT':
          this.callbacks.onInitReceived?.({
            gridSize: msg.gridSize,
            hostName: msg.hostName,
          });
          break;
        case 'MOVE':
          this.callbacks.onMoveReceived?.({
            row: msg.row,
            col: msg.col,
            orientation: msg.orientation,
            lineId: msg.lineId,
          });
          break;
        case 'RESTART':
          this.callbacks.onRestartReceived?.();
          break;
        case 'GRID_CHANGE':
          this.callbacks.onGridChangeReceived?.(msg.gridSize);
          break;
      }
    });

    conn.on('close', () => {
      this.setStatus('disconnected', 'Opponent disconnected');
    });

    conn.on('error', (err) => {
      console.error('[OnlineManager] DataConnection error:', err);
      this.setStatus('error', 'Connection lost');
    });
  }

  public sendMessage(msg: OnlineMessage): boolean {
    if (this.connection && this.connection.open) {
      try {
        this.connection.send(msg);
        return true;
      } catch (err) {
        console.error('[OnlineManager] Send error:', err);
        return false;
      }
    }
    return false;
  }

  public sendMove(row: number, col: number, orientation: 'horizontal' | 'vertical', lineId: string) {
    this.sendMessage({
      type: 'MOVE',
      row,
      col,
      orientation,
      lineId,
    });
  }

  public sendRestart(gridSize?: number) {
    this.sendMessage({
      type: 'RESTART',
      gridSize,
    });
  }

  public sendGridChange(gridSize: number) {
    this.sendMessage({
      type: 'GRID_CHANGE',
      gridSize,
    });
  }

  public cleanup() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch {}
      this.connection = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {}
      this.peer = null;
    }
    this.role = null;
    this.currentRoomCode = null;
    this.status = 'idle';
  }
}

export const onlineManager = new OnlineManager();
