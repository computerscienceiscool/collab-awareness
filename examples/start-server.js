#!/usr/bin/env node

/**
 * Example: Starting the awareness server programmatically
 */

import { startAwarenessServer } from '../server/index.js';

// Start server on port 1235 (or from environment)
const port = parseInt(process.env.AWARENESS_PORT, 10) || 1235;

const server = startAwarenessServer({
  port,
  silent: false  // Set to true to suppress logs
});

console.log(`
==============================================
  Awareness Server Started
==============================================

  URL: ws://localhost:${server.port}

  Connect clients using:

    Browser:
      const client = new AwarenessClient('ws://localhost:${server.port}');
      client.connect();

    Node.js:
      const client = new AwarenessClientNode('ws://localhost:${server.port}');
      client.connect();

  Press Ctrl+C to stop the server.
==============================================
`);

// Monitor client count every 10 seconds
setInterval(() => {
  console.log(`[Monitor] Connected clients: ${server.getClientCount()}`);
}, 10000);
