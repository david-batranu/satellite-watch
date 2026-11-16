#!/usr/bin/env node
/**
 * Headless screenshot + console harness (development tool).
 *
 *   node scripts/screenshot.mjs <url> <out.png> [width] [height] [waitMs]
 *
 * Launches Google Chrome headless with SwiftShader (WebGL without a GPU),
 * emulates a mobile viewport, waits for the app to settle, prints console
 * errors/warnings and saves a PNG. Used to verify the AR layout during
 * development and in CI-like checks.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error('No Chrome/Chromium found');
  process.exit(1);
}

const url = process.argv[2] ?? 'http://127.0.0.1:8932/';
const outPath = process.argv[3] ?? '/tmp/shot.png';
const width = Number(process.argv[4] ?? 390);
const height = Number(process.argv[5] ?? 844);
const waitMs = Number(process.argv[6] ?? 4500);
const port = 9300 + Math.floor(Math.random() * 300);
// A fresh profile per run: otherwise a service worker from an earlier run can
// serve a stale build, and persisted settings can leak between screenshots.
const profileDir = `/tmp/chrome-shot-${port}-${Date.now()}`;

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
};

const removeProfile = () => {
  try {
    rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function devtoolsTarget() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {
      /* not ready yet */
    }
    await sleep(120);
  }
  throw new Error('Chrome DevTools endpoint never became available');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (event) => reject(new Error(String(event))));
  });
  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, ready, send, on: (listener) => listeners.push(listener) };
}

const logs = [];
const errors = [];

try {
  const version = await devtoolsTarget();
  const client = connect(version.webSocketDebuggerUrl);
  await client.ready;

  client.on((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      errors.push(
        details?.exception?.description ??
          details?.text ??
          'Uncaught exception (no details)',
      );
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry;
      if (entry?.level === 'error') errors.push(`[log] ${entry.text}`);
      else if (entry?.level === 'warning') logs.push(`[warn] ${entry.text}`);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      if (message.params.type === 'error') errors.push(`[console.error] ${text}`);
      else if (message.params.type === 'warning') logs.push(`[console.warn] ${text}`);
    }
  });

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  await client.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: true },
    sessionId,
  );
  await client.send('Page.navigate', { url }, sessionId);
  await sleep(waitMs);

  const diagnostics = await client.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
          cls: c.className, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight,
        }));
        return JSON.stringify({
          canvases,
          sheet: document.querySelector('.sheet-root.is-open') ? 'open' : 'closed',
          gate: !!document.querySelector('.gate'),
          title: document.title,
          dpr: window.devicePixelRatio,
        });
      })()`,
      returnByValue: true,
    },
    sessionId,
  );

  if (process.env.SHOT_EVAL) {
    const extra = await client.send(
      'Runtime.evaluate',
      { expression: process.env.SHOT_EVAL, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    console.log('eval:', JSON.stringify(extra?.result?.value ?? extra));
  }

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(outPath, Buffer.from(shot.data, 'base64'));

  console.log('diagnostics:', diagnostics?.result?.value ?? '(none)');
  if (errors.length) {
    console.log('\nERRORS:');
    for (const error of errors.slice(0, 12)) console.log('  ✗', error);
  } else {
    console.log('\nno page errors');
  }
  if (logs.length) {
    console.log('\nWARNINGS:');
    for (const log of logs.slice(0, 8)) console.log('  !', log);
  }
  console.log(`\nsaved ${outPath}`);
  client.ws.close();
} catch (error) {
  console.error('screenshot harness failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
  await sleep(150);
  removeProfile();
}
