```js
'use strict';

/**
 * StrengthSMP Eagler WSS Proxy
 *
 * Frontend:
 *   wss://your-strengthsmp.onrender.com/
 *
 * Backend:
 *   ws://node1.coolcraft.network:25597/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const UPSTREAM_WS =
  process.env.UPSTREAM_WS ||
  'ws://node1.coolcraft.network:25597/';

const WS_SECRET_PATH = process.env.WS_SECRET_PATH || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const urlPathRaw = (req.url || '/').split('?')[0];

  if (urlPathRaw === '/health') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8'
    });
    res.end('ok\n');
    return;
  }

  let urlPath = urlPathRaw === '/' ? '/index.html' : urlPathRaw;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const safePath = path.normalize(decodedPath).replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, safePath);

  if (
    filePath !== path.resolve(PUBLIC_DIR) &&
    !filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    const chosen =
      !err && stat.isFile()
        ? filePath
        : path.join(PUBLIC_DIR, 'index.html');

    fs.readFile(chosen, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8'
        });
        res.end('Not Found');
        return;
      }

      res.writeHead(200, {
        'content-type': contentType(chosen),
        'cache-control': chosen.endsWith('.html')
          ? 'no-cache'
          : 'public, max-age=86400'
      });

      res.end(data);
    });
  });
}

const server = http.createServer(serveStatic);

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 0
});

server.on('upgrade', (req, socket, head) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const pathOnly = (req.url || '/').split('?')[0];

  if (WS_SECRET_PATH && pathOnly !== WS_SECRET_PATH) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (client, req) => {
  // Render normally supplies this header for incoming requests.
  const forwardedFor = (req.headers['x-forwarded-for'] || '')
    .toString()
    .split(',')[0]
    .trim();

  const ip =
    forwardedFor ||
    req.socket.remoteAddress ||
    'unknown';

  const pathOnly = (req.url || '/').split('?')[0];

  const protocolHeader = req.headers['sec-websocket-protocol'];

  const protocols = protocolHeader
    ? protocolHeader.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  log('[IN ] connection', {
    ip,
    path: pathOnly,
    protocols
  });

  const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
  const queue = [];
  let queueBytes = 0;
  let closed = false;

  // Forward the client's address to EaglerXServer.
  const upstream = new WebSocket(
    UPSTREAM_WS,
    protocols,
    {
      headers: {
        'X-Forwarded-For': ip
      },
      perMessageDeflate: false,
      handshakeTimeout: 15000
    }
  );

  function kill(reason) {
    if (closed) return;
    closed = true;

    try {
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      ) {
        client.terminate();
      }
    } catch {}

    try {
      if (
        upstream.readyState === WebSocket.OPEN ||
        upstream.readyState === WebSocket.CONNECTING
      ) {
        upstream.terminate();
      }
    } catch {}

    log('[CLS]', { ip, reason });
  }

  function enqueue(data, isBinary) {
    const size = typeof data === 'string'
      ? Buffer.byteLength(data)
      : data.length;

    queue.push({ data, isBinary, size });
    queueBytes += size;

    if (queueBytes > MAX_QUEUE_BYTES) {
      kill('queue overflow');
    }
  }

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, {
        binary: isBinary,
        compress: false
      });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      enqueue(data, isBinary);
    } else {
      kill('upstream unavailable');
    }
  });

  upstream.on('open', () => {
    log('[UP ] connected', {
      ip,
      upstream: UPSTREAM_WS
    });

    while (queue.length && upstream.readyState === WebSocket.OPEN) {
      const packet = queue.shift();
      queueBytes -= packet.size;

      upstream.send(packet.data, {
        binary: packet.isBinary,
        compress: false
      });
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, {
        binary: isBinary,
        compress: false
      });
    }
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] closed', {
      ip,
      code,
      reason: reason?.toString?.() || ''
    });

    kill('upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] closed', {
      ip,
      code,
      reason: reason?.toString?.() || ''
    });

    kill('client closed');
  });

  upstream.on('error', (error) => {
    log('[UP ] error', {
      ip,
      error: error?.message || String(error)
    });

    kill('upstream error');
  });

  client.on('error', (error) => {
    log('[IN ] error', {
      ip,
      error: error?.message || String(error)
    });

    kill('client error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(
    `StrengthSMP proxy listening on ${PORT} | ` +
    `WSS frontend | WS upstream: ${UPSTREAM_WS}`
  );
});
```
