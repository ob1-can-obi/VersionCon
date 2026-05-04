import * as os from 'os';
import * as net from 'net';

/**
 * Detect the primary local IPv4 address of this machine.
 *
 * Iterates network interfaces and returns the first non-internal
 * IPv4 address. Falls back to '127.0.0.1' if no external interface
 * is found (e.g., no network connection).
 *
 * Used by the setup wizard (D-02) for auto-detection with manual override.
 */
export function getLocalIPv4(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const entries = interfaces[name];
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Get all non-internal IPv4 addresses with their interface names.
 *
 * Returns an array of { name, address } pairs for each non-internal
 * IPv4 interface. Useful for presenting a list of available interfaces
 * in the setup wizard (D-02 manual override).
 */
export function getAllIPv4Addresses(): Array<{ name: string; address: string }> {
  const result: Array<{ name: string; address: string }> = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const entries = interfaces[name];
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push({ name, address: entry.address });
      }
    }
  }
  return result;
}

/**
 * Find an available port by binding to port 0 and reading the OS-assigned port.
 *
 * Creates a temporary TCP server, lets the OS assign a free port,
 * reads the port number, then closes the server. This is the standard
 * Node.js pattern for finding an ephemeral port.
 *
 * @returns A promise that resolves to a free port number
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port from server address')));
      }
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}
