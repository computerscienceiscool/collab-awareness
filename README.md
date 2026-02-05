# @collab-editor/awareness

Real-time cursor and presence synchronization for collaborative editing.

## Features

- WebSocket server for broadcasting presence updates
- Browser client with CodeMirror 6 integration
- Node.js client for server-side applications
- User list, typing indicators, and remote cursors
- Automatic reconnection with exponential backoff
- Heartbeat-based stale user cleanup

## Installation

```bash
npm install @collab-editor/awareness
```

## Quick Start

### 1. Start the Server

```bash
# Using npx
npx @collab-editor/awareness --port 1235

# Or with environment variable
AWARENESS_PORT=1235 npx @collab-editor/awareness

# Or programmatically
import { startAwarenessServer } from '@collab-editor/awareness/server';
const server = startAwarenessServer({ port: 1235 });
```

### 2. Connect from Browser

```javascript
import { AwarenessClient, createUserList, createTypingIndicator } from '@collab-editor/awareness';

// Create client
const client = new AwarenessClient('ws://localhost:1235', {
  name: 'Alice',
  color: '#4ECDC4',
  documentId: 'my-document'
});

// Set up UI components
createUserList(client, {
  listElement: document.getElementById('user-list'),
  countElement: document.getElementById('user-count')
});

createTypingIndicator(client, {
  element: document.getElementById('typing-indicator')
});

// Connect
client.connect();

// Update cursor position
client.updateCursor(42);  // Position in document

// Set typing indicator
client.setTyping(true);
setTimeout(() => client.setTyping(false), 1500);
```

### 3. Connect from Node.js

```javascript
import { AwarenessClientNode } from '@collab-editor/awareness/node';

const client = new AwarenessClientNode('ws://localhost:1235', {
  userId: 'user-123',
  name: 'Bob',
  color: '#FF6B6B',
  documentId: 'my-document'
});

client.on('cursor', (data) => {
  console.log('Remote cursor:', data);
  // { userId, name, color, anchor, head, typing }
});

client.on('change', (states) => {
  console.log('All states:', states);
});

client.connect();
```

## API Reference

### Server

#### `startAwarenessServer(options)`

Start the WebSocket server.

```javascript
import { startAwarenessServer } from '@collab-editor/awareness/server';

const server = startAwarenessServer({
  port: 1235,      // Default: 1235 or AWARENESS_PORT env var
  silent: false    // Suppress console output
});

// Server instance
server.port              // Current port
server.getClientCount()  // Number of connected clients
server.close()          // Graceful shutdown (returns Promise)
```

### Browser Client

#### `AwarenessClient`

```javascript
import { AwarenessClient } from '@collab-editor/awareness';

const client = new AwarenessClient(url, {
  userId: 'optional-id',      // Auto-generated if not provided
  name: 'Display Name',       // Default: 'User'
  color: '#FF6B6B',           // Default: '#000000'
  documentId: 'doc-id',       // For grouping users (default: 'default')
  heartbeatInterval: 30000,   // Heartbeat frequency (ms)
  reconnectDelay: 1000,       // Initial reconnect delay (ms)
  maxReconnectDelay: 30000    // Max reconnect delay (ms)
});

// Methods
client.connect()                    // Connect to server
client.disconnect()                 // Disconnect from server
client.updateCursor(position)       // Update cursor position
client.updateSelection(anchor, head) // Update selection range
client.setTyping(boolean)           // Set typing indicator
client.setName(name)                // Change display name
client.setColor(color)              // Change user color
client.getStates()                  // Get all user states (Map)
client.getLocalState()              // Get local state
client.destroy()                    // Clean up resources

// Events
client.on('connected', () => {})
client.on('disconnected', () => {})
client.on('error', (error) => {})
client.on('cursor', (data) => {})   // Remote cursor update
client.on('change', (states) => {}) // Any state change
```

#### `createUserList(client, options)`

Set up a user list display.

```javascript
import { createUserList } from '@collab-editor/awareness';

const userList = createUserList(client, {
  listElement: document.getElementById('user-list'),
  countElement: document.getElementById('user-count'),
  renderUser: (state, id) => {
    // Custom user rendering (optional)
    const span = document.createElement('span');
    span.textContent = state.user.name;
    span.style.color = state.user.color;
    return span;
  }
});

userList.render()   // Force re-render
userList.destroy()  // Clean up
```

#### `createTypingIndicator(client, options)`

Set up a typing indicator display.

```javascript
import { createTypingIndicator } from '@collab-editor/awareness';

const indicator = createTypingIndicator(client, {
  element: document.getElementById('typing-indicator'),
  localId: client.userId,  // Exclude local user
  timeout: 2500            // Clear after ms of no typing
});

indicator.update()   // Force update
indicator.destroy()  // Clean up
```

#### CodeMirror Integration

```javascript
import { remoteCursorPlugin, CursorWidget } from '@collab-editor/awareness';
import * as cmView from '@codemirror/view';
import * as cmState from '@codemirror/state';

// Synchronous version (when CodeMirror already imported)
const cursorExtension = remoteCursorPlugin(cmView, cmState, client, client.userId);

// Use in EditorView
const view = new EditorView({
  extensions: [
    // ... other extensions
    cursorExtension
  ]
});

// Track local cursor changes
view.dom.addEventListener('keyup', () => {
  const pos = view.state.selection.main.anchor;
  client.updateCursor(pos);
});
```

#### `injectStyles()`

Inject default CSS styles for cursors and user list.

```javascript
import { injectStyles } from '@collab-editor/awareness';
injectStyles();
```

### Node.js Client

#### `AwarenessClientNode`

Same API as `AwarenessClient`, but uses the `ws` package for WebSocket.

```javascript
import { AwarenessClientNode } from '@collab-editor/awareness/node';

const client = new AwarenessClientNode('ws://localhost:1235', {
  userId: 'user-123',
  name: 'Bot',
  color: '#9B59B6',
  documentId: 'shared-doc'
});

client.on('cursor', (data) => {
  console.log(`${data.name} moved cursor to ${data.anchor}`);
});

client.connect();
```

## Protocol

### Message Format

All messages are JSON with a `type` field:

```javascript
// Join message (sent on connect)
{ type: 'join', documentId: 'doc-id', clientID: 'user-id' }

// Awareness update (cursor, typing, user info)
{
  type: 'awareness',
  clientID: 'user-id',
  documentId: 'doc-id',
  state: {
    user: { name: 'Alice', color: '#4ECDC4' },
    typing: false,
    selection: { anchor: 42, head: 42 }
  }
}
```

### Events

| Event | Data | Description |
|-------|------|-------------|
| `connected` | - | WebSocket connection established |
| `disconnected` | - | WebSocket connection closed |
| `error` | Error | Connection or parsing error |
| `cursor` | `{ userId, name, color, anchor, head, typing }` | Remote cursor update |
| `change` | `Map<clientID, state>` | Any state change |

## Examples

See the `examples/` directory:

- `start-server.js` - Programmatic server startup
- `browser-demo.html` - Interactive browser demo

Run the demo:

```bash
# Terminal 1: Start server
npm start

# Terminal 2: Serve the demo
npx serve examples

# Open http://localhost:3000/browser-demo.html in multiple browser tabs
```

## License

MIT
