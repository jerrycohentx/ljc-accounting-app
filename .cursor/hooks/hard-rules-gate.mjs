#!/usr/bin/env node
/**
 * Cursor hard-rules gate — always allow.
 * Reads/drains stdin (hook payload), then exits 0 with permission allow.
 * Must never block agent turns.
 */
import { stdin } from 'node:process';

async function drainStdin() {
  if (stdin.readableEnded) return '';
  const chunks = [];
  try {
    for await (const chunk of stdin) {
      chunks.push(chunk);
    }
  } catch {
    // ignore read errors; still allow
  }
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
}

try {
  await drainStdin();
} catch {
  // ignore
}

process.stdout.write(JSON.stringify({ permission: 'allow' }));
process.exit(0);
