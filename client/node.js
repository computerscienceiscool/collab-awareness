/**
 * @collab-editor/awareness - Node.js client
 *
 * Provides real-time cursor/presence synchronization for Node.js applications.
 * Uses the 'ws' package for WebSocket connections.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

/**
 * Node.js-based awareness client for real-time presence synchronization.
 * Designed for use in Node.js applications like vimbeam.
 *
 * @example
 * import { AwarenessClientNode } from '@collab-editor/awareness/node';
 *
 * const client = new AwarenessClientNode('ws://localhost:1235', {
 *   userId: 'user-123',
 *   name: 'Bob',
 *   color: '#FF6B6B'
 * });
 *
 * client.on('cursor', (data) => {
 *   console.log('Remote cursor:', data);
 * });
 *
 * client.connect();
 */
export class AwarenessClientNode {
  /**
   * @param {string} url - WebSocket server URL
   * @param {Object} options - Client options
   * @param {string} [options.userId] - Unique user ID (auto-generated if not provided)
   * @param {string} [options.name='User'] - Display name
   * @param {string} [options.color='#000000'] - User color (hex)
   * @param {string} [options.documentId] - Document/room ID for grouping
   * @param {number} [options.heartbeatInterval=30000] - Heartbeat interval in ms
   * @param {number} [options.reconnectDelay=1000] - Initial reconnect delay in ms
   * @param {number} [options.maxReconnectDelay=30000] - Max reconnect delay in ms
   */
  constructor(url, options = {}) {
    this.url = url;
    this.userId = options.userId || randomUUID();
    this.documentId = options.documentId || 'default';

    this.state = {
      user: {
        name: options.name || 'User',
        color: options.color || '#000000'
      },
      typing: false,
      selection: null
    };

    this.heartbeatInterval = options.heartbeatInterval || 5000;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;

    this._ws = null;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._isConnecting = false;
    this._shouldReconnect = true;

    this._remoteStates = new Map();
    this._lastSeen = new Map();
    this._listeners = new Map();

    // Stale user cleanup interval (90 seconds timeout)
    this._userTimeout = 90000;
    this._cleanupInterval = null;
  }

  /**
   * Connect to the awareness server
   */
  connect() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this._isConnecting = true;
    this._shouldReconnect = true;

    try {
      this._ws = new WebSocket(this.url);
    } catch (error) {
      this._emit('error', error);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._isConnecting = false;
      this._reconnectAttempts = 0;

      // Send join message
      this._send({
        type: 'join',
        documentId: this.documentId,
        clientID: this.userId
      });

      // Broadcast initial state
      this._broadcastState();

      // Start heartbeat
      this._startHeartbeat();

      // Start cleanup interval
      this._startCleanup();

      this._emit('connected');
    });

    this._ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleMessage(message);
      } catch (error) {
        console.error('[AwarenessClientNode] Failed to parse message:', error);
      }
    });

    this._ws.on('close', () => {
      this._stopHeartbeat();
      this._stopCleanup();
      this._ws = null;
      this._emit('disconnected');

      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    });

    this._ws.on('error', (error) => {
      this._emit('error', error);
    });
  }

  /**
   * Disconnect from the awareness server
   */
  disconnect() {
    this._shouldReconnect = false;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._stopHeartbeat();
    this._stopCleanup();

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._remoteStates.clear();
    this._lastSeen.clear();
  }

  /**
   * Update cursor position
   * @param {number} offset - Cursor offset in document
   * @param {Object} [selection] - Optional selection range
   * @param {number} [selection.anchor] - Selection anchor
   * @param {number} [selection.head] - Selection head
   */
  updateCursor(offset, selection) {
    if (selection) {
      this.state.selection = {
        anchor: selection.anchor ?? offset,
        head: selection.head ?? offset
      };
    } else {
      this.state.selection = { anchor: offset };
    }
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Update selection range
   * @param {number} anchor - Selection anchor position
   * @param {number} head - Selection head position
   */
  updateSelection(anchor, head) {
    this.state.selection = { anchor, head };
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Set typing indicator
   * @param {boolean} typing - Whether user is typing
   */
  setTyping(typing) {
    this.state.typing = typing;
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Set display name
   * @param {string} name - Display name
   */
  setName(name) {
    this.state.user.name = name;
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Set user color
   * @param {string} color - Hex color (e.g., '#FF6B6B')
   */
  setColor(color) {
    this.state.user.color = color;
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Set document ID (for switching documents)
   * @param {string} documentId - Document/room ID
   */
  setDocumentId(documentId) {
    this.documentId = documentId || 'default';
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Set a local state field
   * @param {string} field - Field name
   * @param {any} value - Field value
   */
  setLocalStateField(field, value) {
    this.state[field] = value;
    this._broadcastState();
    this._notifyChange();
  }

  /**
   * Get local state
   * @returns {Object} Local state
   */
  getLocalState() {
    return this.state;
  }

  /**
   * Get all states (local + remote)
   * @returns {Map} Map of clientID -> state
   */
  getStates() {
    const states = new Map();
    states.set(this.userId, this.state);
    this._remoteStates.forEach((state, id) => {
      states.set(id, state);
    });
    return states;
  }

  /**
   * Register event listener
   * @param {string} event - Event name: 'cursor', 'connected', 'disconnected', 'error', 'change'
   * @param {Function} callback - Event handler
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} callback - Event handler to remove
   */
  off(event, callback) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(callback);
    }
  }

  /**
   * Destroy the client and clean up resources
   */
  destroy() {
    this.disconnect();
    this._listeners.clear();
  }

  // ---- Private methods ----

  _send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  _broadcastState() {
    this._send({
      type: 'awareness',
      clientID: this.userId,
      state: this.state,
      documentId: this.documentId
    });
  }

  _handleMessage(data) {
    if (data.type === 'awareness' && data.clientID !== this.userId) {
      this._remoteStates.set(data.clientID, data.state);
      this._lastSeen.set(data.clientID, Date.now());

      this._emit('cursor', {
        userId: data.clientID,
        name: data.state?.user?.name,
        color: data.state?.user?.color,
        anchor: data.state?.selection?.anchor,
        head: data.state?.selection?.head,
        typing: data.state?.typing
      });

      this._notifyChange();
    }
  }

  _notifyChange() {
    const states = this.getStates();
    this._emit('change', states);
  }

  _emit(event, data) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[AwarenessClientNode] Error in ${event} handler:`, error);
        }
      });
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._broadcastState();
    }, this.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _startCleanup() {
    this._stopCleanup();
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      let removed = false;

      this._lastSeen.forEach((timestamp, clientID) => {
        if (now - timestamp > this._userTimeout) {
          this._remoteStates.delete(clientID);
          this._lastSeen.delete(clientID);
          removed = true;
        }
      });

      if (removed) {
        this._notifyChange();
      }
    }, 30000);
  }

  _stopCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._shouldReconnect) {
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this._reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export default AwarenessClientNode;
