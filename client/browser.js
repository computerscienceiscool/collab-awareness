/**
 * @collab-editor/awareness - Browser client
 *
 * Provides real-time cursor/presence synchronization for collaborative editing.
 * Includes CodeMirror integration components.
 */

// ============================================================================
// AwarenessClient - Core WebSocket client for browser
// ============================================================================

/**
 * Browser-based awareness client for real-time presence synchronization.
 *
 * @example
 * const client = new AwarenessClient('ws://localhost:1235', {
 *   name: 'Alice',
 *   color: '#4ECDC4'
 * });
 *
 * client.on('cursor', (data) => console.log('Remote cursor:', data));
 * client.connect();
 */
export class AwarenessClient {
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
    this.userId = options.userId || this._generateId();
    this.documentId = options.documentId || 'default';

    this.state = {
      user: {
        name: options.name || 'User',
        color: options.color || '#000000'
      },
      typing: false,
      selection: null
    };

    this.heartbeatInterval = options.heartbeatInterval || 30000;
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

    this._ws.onopen = () => {
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
    };

    this._ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch (error) {
        console.error('[AwarenessClient] Failed to parse message:', error);
      }
    };

    this._ws.onclose = () => {
      this._stopHeartbeat();
      this._stopCleanup();
      this._ws = null;
      this._emit('disconnected');

      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = (error) => {
      this._emit('error', error);
    };
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
   * @param {number|Object} position - Cursor offset or {line, ch} object
   */
  updateCursor(position) {
    const anchor = typeof position === 'number' ? position : position;
    this.state.selection = { anchor };
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

  _generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }

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
      // Only accept messages for our document
      if (data.documentId && data.documentId !== this.documentId) {
        return;
      }

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
          console.error(`[AwarenessClient] Error in ${event} handler:`, error);
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

// ============================================================================
// CursorWidget - CodeMirror widget for remote cursor display
// ============================================================================

/**
 * CodeMirror widget for displaying a remote user's cursor.
 * Compatible with CodeMirror 6's WidgetType interface.
 */
export class CursorWidget {
  /**
   * @param {string} name - User's display name
   * @param {string} color - Cursor color (hex)
   * @param {string} clientID - Unique client identifier
   */
  constructor(name, color, clientID) {
    this.name = name || 'User';
    this.color = color || '#000';
    this.clientID = clientID || '';
  }

  toDOM() {
    const wrapper = document.createElement('span');
    wrapper.className = 'remote-cursor';
    wrapper.style.borderLeft = '2px solid ' + this.color;

    const label = document.createElement('span');
    label.className = 'remote-cursor-label';
    label.textContent = this.name;
    label.style.background = this.color;

    wrapper.appendChild(label);
    return wrapper;
  }

  updateDOM(dom) {
    dom.style.borderLeft = '2px solid ' + this.color;
    const label = dom.querySelector('.remote-cursor-label');
    if (label) {
      label.textContent = this.name;
      label.style.background = this.color;
    }
    return true;
  }

  ignoreEvent() { return true; }
  eq(other) { return this.clientID === other.clientID; }
  compare(other) { return this.clientID === other.clientID; }
  destroy() {}
  coordsAt() { return null; }
}

// ============================================================================
// remoteCursorPlugin - CodeMirror extension for remote cursors
// ============================================================================

/**
 * Synchronous version of createRemoteCursorPlugin for use when CodeMirror is already imported.
 * Use this when you've already imported @codemirror/view and @codemirror/state.
 *
 * @param {Object} cmView - @codemirror/view module
 * @param {Object} cmState - @codemirror/state module
 * @param {AwarenessClient} awareness - Awareness client instance
 * @param {string} clientID - Local client ID
 * @returns {Array} CodeMirror extension array
 */
export function remoteCursorPlugin(cmView, cmState, awareness, clientID) {
  const { Decoration, ViewPlugin, EditorView } = cmView;
  const { StateField, StateEffect } = cmState;

  const setRemoteCursors = StateEffect.define();

  const remoteCursorField = StateField.define({
    create() {
      return Decoration.none;
    },
    update(deco, tr) {
      for (let e of tr.effects) {
        if (e.is(setRemoteCursors)) {
          return e.value;
        }
      }
      try {
        return deco.map(tr.changes);
      } catch (e) {
        console.warn('[RemoteCursor] Decoration mapping failed, clearing:', e.message);
        return Decoration.none;
      }
    },
    provide: f => EditorView.decorations.from(f)
  });

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.updateDecorations = this.updateDecorations.bind(this);
        this.updateDecorations();
        awareness.on('change', this.updateDecorations);
      }

      update(update) {
        if (update.docChanged || update.selectionSet) {
          this.updateDecorations();
        }
      }

      updateDecorations() {
        const buildDecorations = (currentDocLength) => {
          const decorations = [];
          const states = awareness.getStates();

          states.forEach((state, id) => {
            if (id === clientID) return;

            const user = state.user;
            const selection = state.selection;

            if (user && selection && typeof selection.anchor === 'number') {
              const anchor = Math.max(0, Math.min(selection.anchor, currentDocLength));
              decorations.push(
                Decoration.widget({
                  widget: new CursorWidget(user.name, user.color, id),
                  side: -1,
                }).range(anchor)
              );
            }
          });

          return Decoration.set(decorations, true);
        };

        setTimeout(() => {
          try {
            const currentDocLength = this.view.state.doc.length;
            const freshDecorations = buildDecorations(currentDocLength);
            this.view.dispatch({
              effects: setRemoteCursors.of(freshDecorations)
            });
          } catch (e) {
            console.warn('[RemoteCursor] Dispatch failed:', e.message);
          }
        }, 0);
      }

      destroy() {
        awareness.off('change', this.updateDecorations);
      }
    }
  );

  return [remoteCursorField, plugin];
}

// ============================================================================
// createUserList - User list display
// ============================================================================

/**
 * Sets up a live user list display.
 *
 * @param {AwarenessClient} awareness - Awareness client instance
 * @param {Object} options - Display options
 * @param {HTMLElement} [options.listElement] - Container element for user list
 * @param {HTMLElement} [options.countElement] - Element to display user count
 * @param {Function} [options.renderUser] - Custom user rendering function
 * @returns {Object} Controller with destroy() method
 *
 * @example
 * const userList = createUserList(awareness, {
 *   listElement: document.getElementById('user-list'),
 *   countElement: document.getElementById('user-count')
 * });
 */
export function createUserList(awareness, options = {}) {
  const listElement = options.listElement || document.getElementById('user-list');
  const countElement = options.countElement || document.getElementById('user-count');
  const renderUser = options.renderUser || defaultRenderUser;

  let changeHandler = null;
  let backupInterval = null;

  function defaultRenderUser(state, id) {
    const span = document.createElement('span');
    span.className = 'user';
    const shortId = String(id).slice(-6);
    const name = state.user?.name || 'User';
    span.textContent = `${name} (${shortId})`;
    span.style.backgroundColor = state.user?.color || '#ccc';
    return span;
  }

  function render() {
    if (!listElement) return;

    listElement.innerHTML = '';
    const states = awareness.getStates();
    let count = 0;

    states.forEach((state, id) => {
      if (state.user) {
        count++;
        const element = renderUser(state, id);
        if (element) {
          listElement.appendChild(element);
        }
      }
    });

    if (countElement) {
      countElement.textContent = count.toString();
    }
  }

  changeHandler = () => render();
  awareness.on('change', changeHandler);

  // Initial render
  render();

  // Backup refresh every 5 seconds
  backupInterval = setInterval(render, 5000);

  return {
    render,
    destroy() {
      if (changeHandler) {
        awareness.off('change', changeHandler);
        changeHandler = null;
      }
      if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
      }
    }
  };
}

// ============================================================================
// createTypingIndicator - Typing indicator display
// ============================================================================

/**
 * Sets up a typing indicator display.
 *
 * @param {AwarenessClient} awareness - Awareness client instance
 * @param {Object} options - Display options
 * @param {HTMLElement} [options.element] - Element to display typing messages
 * @param {string} [options.localId] - Local client ID to exclude
 * @param {number} [options.timeout=2500] - Typing timeout in ms
 * @returns {Object} Controller with destroy() method
 *
 * @example
 * const typingIndicator = createTypingIndicator(awareness, {
 *   element: document.getElementById('typing-indicator'),
 *   localId: awareness.userId
 * });
 */
export function createTypingIndicator(awareness, options = {}) {
  const element = options.element || document.getElementById('typing-indicator');
  const localId = options.localId || awareness.userId;
  const timeout = options.timeout || 2500;

  let changeHandler = null;
  const activeTimeouts = new Map();

  function update() {
    if (!element) return;

    // Clear existing timeouts
    activeTimeouts.forEach(t => clearTimeout(t));
    activeTimeouts.clear();

    const messages = [];
    const states = awareness.getStates();

    states.forEach((state, id) => {
      if (id === localId) return;

      const user = state.user;
      const typing = state.typing;

      if (user?.name && typing) {
        messages.push(`${user.name} is typing...`);

        // Auto-clear after timeout
        const t = setTimeout(() => {
          update();
        }, timeout);
        activeTimeouts.set(id, t);
      }
    });

    element.textContent = messages.length ? messages.join(', ') : '';
  }

  changeHandler = () => update();
  awareness.on('change', changeHandler);

  return {
    update,
    destroy() {
      if (changeHandler) {
        awareness.off('change', changeHandler);
        changeHandler = null;
      }
      activeTimeouts.forEach(t => clearTimeout(t));
      activeTimeouts.clear();
    }
  };
}

// ============================================================================
// CSS Styles
// ============================================================================

/**
 * Default CSS styles for remote cursors and user list.
 * Call this function to inject styles, or use your own CSS.
 */
export function injectStyles() {
  if (document.getElementById('collab-awareness-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'collab-awareness-styles';
  style.textContent = `
    .remote-cursor {
      position: relative;
      border-left: 2px solid;
      margin-left: -1px;
      margin-right: -1px;
      pointer-events: none;
    }

    .remote-cursor-label {
      position: absolute;
      top: -1.4em;
      left: -1px;
      font-size: 10px;
      font-family: sans-serif;
      font-weight: 500;
      line-height: 1.2;
      white-space: nowrap;
      color: white;
      padding: 1px 4px;
      border-radius: 3px 3px 3px 0;
      pointer-events: none;
      z-index: 10;
    }

    .user {
      display: inline-block;
      padding: 2px 8px;
      margin: 2px;
      border-radius: 12px;
      font-size: 12px;
      font-family: sans-serif;
      color: white;
    }

    #typing-indicator {
      font-style: italic;
      color: #666;
      font-size: 12px;
      min-height: 1.2em;
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// Exports
// ============================================================================

export default AwarenessClient;
