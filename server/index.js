#!/usr/bin/env node

/**
 * @collab-editor/awareness - WebSocket server for presence/cursor synchronization
 *
 * Broadcasts awareness messages (cursor positions, user info, typing indicators)
 * to all connected clients except the sender.
 *
 * Usage:
 *   CLI: awareness-server --port 1235
 *   Programmatic: import { startAwarenessServer } from '@collab-editor/awareness/server'
 */

import { WebSocketServer, WebSocket } from 'ws';

/**
 * Default configuration
 */
const DEFAULT_PORT = 1235;

/**
 * Start the awareness WebSocket server
 *
 * @param {Object} options - Server options
 * @param {number} [options.port=1235] - Port to listen on
 * @param {boolean} [options.silent=false] - Suppress console output
 * @returns {Object} Server instance with wss and close() method
 */
export function startAwarenessServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const silent = options.silent || false;

  const wss = new WebSocketServer({ port });
  const clients = new Set();

  const log = (...args) => {
    if (!silent) {
      console.log(...args);
    }
  };

  log(`[Awareness] WebSocket server listening on port ${port}`);

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const clientIp = req.socket.remoteAddress;
    log(`[Awareness] Client connected from ${clientIp}. Total clients: ${clients.size}`);

    ws.on('message', (message) => {
      // Convert Buffer to string if needed
      const data = message.toString();

      // Broadcast to all other connected clients
      clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      });
    });

    ws.on('close', () => {
      clients.delete(ws);
      log(`[Awareness] Client disconnected. Total clients: ${clients.size}`);
    });

    ws.on('error', (error) => {
      log(`[Awareness] Client error:`, error.message);
      clients.delete(ws);
    });
  });

  wss.on('error', (error) => {
    log(`[Awareness] Server error:`, error.message);
  });

  return {
    wss,
    port,
    getClientCount: () => clients.size,
    close: () => {
      return new Promise((resolve) => {
        // Close all client connections
        clients.forEach(client => {
          client.close();
        });
        clients.clear();

        // Close the server
        wss.close(() => {
          log(`[Awareness] Server closed`);
          resolve();
        });
      });
    }
  };
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const options = {
    port: parseInt(process.env.AWARENESS_PORT, 10) || DEFAULT_PORT
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--port' || arg === '-p') {
      const portArg = args[++i];
      if (portArg) {
        const parsed = parseInt(portArg, 10);
        if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
          options.port = parsed;
        } else {
          console.error(`Invalid port: ${portArg}`);
          process.exit(1);
        }
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
@collab-editor/awareness - WebSocket server for presence synchronization

Usage:
  awareness-server [options]
  npx @collab-editor/awareness [options]

Options:
  -p, --port <number>  Port to listen on (default: 1235)
                       Can also be set via AWARENESS_PORT env var
  -h, --help           Show this help message

Examples:
  awareness-server --port 1235
  AWARENESS_PORT=8080 awareness-server
`);
      process.exit(0);
    }
  }

  return options;
}

// CLI entry point - only run when executed directly
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/server/index.js') ||
  process.argv[1].endsWith('/awareness-server') ||
  process.argv[1].includes('@collab-editor/awareness')
);

if (isMainModule) {
  const options = parseArgs(process.argv.slice(2));
  const server = startAwarenessServer(options);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Awareness] Shutting down...');
    server.close().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default startAwarenessServer;
