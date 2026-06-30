import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startAwarenessServer } from '../server/index.js';
import { AwarenessClientNode } from '../client/node.js';

// Use a random high port to avoid conflicts
const TEST_PORT = 19235 + Math.floor(Math.random() * 1000);
const TEST_URL = `ws://localhost:${TEST_PORT}`;

// Helper: wait for an event with timeout
function waitForEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.on(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Helper: small delay
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================================
// Server tests
// ============================================================================

describe('Awareness Server', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('starts and reports zero clients', () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });
    assert.equal(server.getClientCount(), 0);
  });

  it('tracks connected clients', async () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });

    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-1',
      documentId: 'doc-1'
    });

    client.connect();
    await waitForEvent(client, 'connected');
    assert.equal(server.getClientCount(), 1);

    client.destroy();
    await delay(100);
    assert.equal(server.getClientCount(), 0);
  });

  it('broadcasts messages to other clients (not sender)', async () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });

    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'user-1',
      name: 'Alice',
      documentId: 'doc-1'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'user-2',
      name: 'Bob',
      documentId: 'doc-1'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    // client2 should receive client1's cursor update
    const cursorPromise = waitForEvent(client2, 'cursor');
    client1.updateCursor(42);
    const cursor = await cursorPromise;

    assert.equal(cursor.userId, 'user-1');
    assert.equal(cursor.anchor, 42);

    client1.destroy();
    client2.destroy();
  });
});

// ============================================================================
// Node client tests
// ============================================================================

describe('AwarenessClientNode', () => {
  let server;

  before(async () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });
  });

  after(async () => {
    await server.close();
  });

  it('connects and emits connected event', async () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-connect',
      documentId: 'doc-1'
    });

    client.connect();
    await waitForEvent(client, 'connected');
    client.destroy();
  });

  it('sets initial state from constructor options', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-state',
      name: 'Alice',
      color: '#FF0000',
      documentId: 'doc-1'
    });

    const state = client.getLocalState();
    assert.equal(state.user.name, 'Alice');
    assert.equal(state.user.color, '#FF0000');
    assert.equal(state.typing, false);
    assert.equal(state.selection, null);

    client.destroy();
  });

  it('updates cursor position', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-cursor',
      documentId: 'doc-1'
    });

    client.updateCursor(100);
    assert.deepEqual(client.getLocalState().selection, { anchor: 100 });

    client.destroy();
  });

  it('updates selection range', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-selection',
      documentId: 'doc-1'
    });

    client.updateSelection(10, 50);
    assert.deepEqual(client.getLocalState().selection, { anchor: 10, head: 50 });

    client.destroy();
  });

  it('sets name and color', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-name',
      documentId: 'doc-1'
    });

    client.setName('Bob');
    assert.equal(client.getLocalState().user.name, 'Bob');

    client.setColor('#00FF00');
    assert.equal(client.getLocalState().user.color, '#00FF00');

    client.destroy();
  });

  it('sets typing indicator', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-typing',
      documentId: 'doc-1'
    });

    client.setTyping(true);
    assert.equal(client.getLocalState().typing, true);

    client.setTyping(false);
    assert.equal(client.getLocalState().typing, false);

    client.destroy();
  });

  it('sets arbitrary state fields', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-field',
      documentId: 'doc-1'
    });

    client.setLocalStateField('custom', { foo: 'bar' });
    assert.deepEqual(client.getLocalState().custom, { foo: 'bar' });

    client.destroy();
  });

  it('changes documentId', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-docid',
      documentId: 'doc-1'
    });

    assert.equal(client.documentId, 'doc-1');
    client.setDocumentId('doc-2');
    assert.equal(client.documentId, 'doc-2');

    client.destroy();
  });

  it('defaults documentId to "default" when not provided', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-default'
    });

    assert.equal(client.documentId, 'default');
    client.destroy();
  });

  it('includes local state in getStates()', () => {
    const client = new AwarenessClientNode(TEST_URL, {
      userId: 'test-states',
      name: 'Alice',
      documentId: 'doc-1'
    });

    const states = client.getStates();
    assert.equal(states.size, 1);
    assert.equal(states.get('test-states').user.name, 'Alice');

    client.destroy();
  });
});

// ============================================================================
// DocumentId filtering tests
// ============================================================================

describe('DocumentId filtering', () => {
  let server;

  before(async () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });
  });

  after(async () => {
    await server.close();
  });

  it('receives cursors from same documentId', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'same-doc-1',
      name: 'Alice',
      documentId: 'automerge:abc123'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'same-doc-2',
      name: 'Bob',
      documentId: 'automerge:abc123'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    const cursorPromise = waitForEvent(client2, 'cursor');
    client1.updateCursor(99);
    const cursor = await cursorPromise;

    assert.equal(cursor.userId, 'same-doc-1');
    assert.equal(cursor.name, 'Alice');
    assert.equal(cursor.anchor, 99);

    client1.destroy();
    client2.destroy();
  });

  it('ignores cursors from different documentId', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'diff-doc-1',
      name: 'Alice',
      documentId: 'automerge:doc-A'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'diff-doc-2',
      name: 'Bob',
      documentId: 'automerge:doc-B'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    // client2 should NOT receive client1's cursor (different doc)
    let received = false;
    client2.on('cursor', () => { received = true; });

    client1.updateCursor(50);
    await delay(300);

    assert.equal(received, false, 'Should not receive cursor from different documentId');

    client1.destroy();
    client2.destroy();
  });

  it('receives cursors after switching to matching documentId', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'switch-1',
      name: 'Alice',
      documentId: 'automerge:doc-X'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'switch-2',
      name: 'Bob',
      documentId: 'automerge:doc-Y'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    // Switch client2 to same doc as client1
    client2.setDocumentId('automerge:doc-X');
    await delay(100);

    const cursorPromise = waitForEvent(client2, 'cursor');
    client1.updateCursor(77);
    const cursor = await cursorPromise;

    assert.equal(cursor.anchor, 77);

    client1.destroy();
    client2.destroy();
  });
});

// ============================================================================
// Integration: full cursor exchange
// ============================================================================

describe('Integration: cursor exchange', () => {
  let server;

  before(async () => {
    server = startAwarenessServer({ port: TEST_PORT, silent: true });
  });

  after(async () => {
    await server.close();
  });

  it('two clients see each other cursors', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'int-1',
      name: 'Alice',
      color: '#FF0000',
      documentId: 'automerge:integration'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'int-2',
      name: 'Bob',
      color: '#00FF00',
      documentId: 'automerge:integration'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    // client1 sends cursor, client2 receives
    const cursor2Promise = waitForEvent(client2, 'cursor');
    client1.updateCursor(10);
    const cursor2 = await cursor2Promise;
    assert.equal(cursor2.userId, 'int-1');
    assert.equal(cursor2.name, 'Alice');
    assert.equal(cursor2.color, '#FF0000');
    assert.equal(cursor2.anchor, 10);

    // client2 sends cursor, client1 receives
    // Filter for the specific updateCursor message (not initial broadcast)
    const cursor1 = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for cursor')), 2000);
      client1.on('cursor', (data) => {
        if (data.anchor === 20) {
          clearTimeout(timer);
          resolve(data);
        }
      });
      client2.updateCursor(20);
    });
    assert.equal(cursor1.userId, 'int-2');
    assert.equal(cursor1.name, 'Bob');
    assert.equal(cursor1.color, '#00FF00');
    assert.equal(cursor1.anchor, 20);

    client1.destroy();
    client2.destroy();
  });

  it('selection range is exchanged correctly', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'sel-1',
      name: 'Alice',
      documentId: 'automerge:selection-test'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'sel-2',
      name: 'Bob',
      documentId: 'automerge:selection-test'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    const cursorPromise = waitForEvent(client2, 'cursor');
    client1.updateSelection(5, 25);
    const cursor = await cursorPromise;

    assert.equal(cursor.anchor, 5);
    assert.equal(cursor.head, 25);

    client1.destroy();
    client2.destroy();
  });

  it('typing indicator is exchanged', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'type-1',
      name: 'Alice',
      documentId: 'automerge:typing-test'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'type-2',
      name: 'Bob',
      documentId: 'automerge:typing-test'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    const cursorPromise = waitForEvent(client2, 'cursor');
    client1.setTyping(true);
    const cursor = await cursorPromise;

    assert.equal(cursor.typing, true);

    client1.destroy();
    client2.destroy();
  });

  it('getStates includes remote users after exchange', async () => {
    const client1 = new AwarenessClientNode(TEST_URL, {
      userId: 'states-1',
      name: 'Alice',
      documentId: 'automerge:states-test'
    });
    const client2 = new AwarenessClientNode(TEST_URL, {
      userId: 'states-2',
      name: 'Bob',
      documentId: 'automerge:states-test'
    });

    client1.connect();
    client2.connect();
    await Promise.all([
      waitForEvent(client1, 'connected'),
      waitForEvent(client2, 'connected')
    ]);

    // Wait for initial broadcast exchange
    await waitForEvent(client1, 'cursor');

    const states = client1.getStates();
    assert.equal(states.size, 2);
    assert.equal(states.get('states-1').user.name, 'Alice');
    assert.equal(states.get('states-2').user.name, 'Bob');

    client1.destroy();
    client2.destroy();
  });
});
