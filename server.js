
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const UPSTREAM_WS =
  process.env.UPSTREAM_WS || 'ws://node1.coolcraft.network:25597/';
const WS_SECRET_PATH = process.env.WS_SECRET_PATH || '';
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function contentType(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
  };

  return types[path.extname(filePath).toLowerCase()] ||
    'application/octet-stream';
}

function sendText(res, status, message) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8'
  });
  res.end(message);
}

function serveStatic(req, res) {
  const rawPath = (req.url || '/').split('?')[0];

  if (rawPath === '/health') {
    sendText(res, 200, 'ok\n');
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(
      rawPath === '/' ? '/index.html' : rawPath
    );
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const relativePath = decoded.replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (
    filePath !== PUBLIC_DIR &&
    !filePath.startsWith(PUBLIC_DIR + path.sep)
  ) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    const selectedFile =
      !statError && stat.isFile()
        ? filePath
        : path.join(PUBLIC_DIR, 'index.html');

    fs.readFile(selectedFile, (readError, data) => {
      if (readError) {
        sendText(res, 404, 'Not Found');
        return;
      }

      res.writeHead(200, {
        'content-type': contentType(selectedFile),
        'cache-control': selectedFile.endsWith('.html')
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

  const requestPath = (req.url || '/').split('?')[0];

  if (WS_SECRET_PATH && requestPath !== WS_SECRET_PATH) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, client => {
    wss.emit('connection', client, req);
  });
});

wss.on('connection', (client, req) => {
  const forwardedFor = String(
    req.headers['x-forwarded-for'] || ''
  ).split(',')[0].trim();

  const clientIp =
    forwardedFor || req.socket.remoteAddress || 'unknown';

  const requestPath = (req.url || '/').split('?')[0];
  const protocolHeader = req.headers['sec-websocket-protocol'];

  const protocols = protocolHeader
    ? protocolHeader.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  log('[IN ] connection', {
    ip: clientIp,
    path: requestPath,
    protocols: protocols || []
  });

  let finished = false;
  let queuedBytes = 0;
  const pendingMessages = [];

  const upstream = new WebSocket(
    UPSTREAM_WS,
    protocols,
    {
      headers: {
        'X-Forwarded-For': clientIp
      },
      perMessageDeflate: false,
      handshakeTimeout: 15000
    }
  );

  function closeBoth(reason) {
    if (finished) return;
    finished = true;

    log('[CLS]', { ip: clientIp, reason });

    try {
      client.terminate();
    } catch {}

    try {
      upstream.terminate();
    } catch {}
  }

  function sendUpstream(data, isBinary) {
    if (finished) return;

    if (upstream.readyState !== WebSocket.OPEN) {
      closeBoth('upstream unavailable');
      return;
    }

    upstream.send(data, {
      binary: isBinary,
      compress: false
    }, error => {
      if (error) {
        log('[UP ] send error', error.message);
        closeBoth('upstream send error');
      }
    });
  }

  client.on('message', (data, isBinary) => {
    if (finished) return;

    if (upstream.readyState === WebSocket.OPEN) {
      sendUpstream(data, isBinary);
      return;
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      const size = typeof data === 'string'
        ? Buffer.byteLength(data)
        : data.length;

      queuedBytes += size;

      if (queuedBytes > MAX_QUEUE_BYTES) {
        closeBoth('message queue overflow');
        return;
      }

      pendingMessages.push({ data, isBinary, size });
      return;
    }

    closeBoth('upstream unavailable');
  });

  upstream.on('open', () => {
    log('[UP ] connected', {
      ip: clientIp,
      upstream: UPSTREAM_WS
    });

    while (
      !finished &&
      pendingMessages.length &&
      upstream.readyState === WebSocket.OPEN
    ) {
      const item = pendingMessages.shift();
      queuedBytes -= item.size;
      sendUpstream(item.data, item.isBinary);
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (finished || client.readyState !== WebSocket.OPEN) return;

    client.send(data, {
      binary: isBinary,
      compress: false
    }, error => {
      if (error) {
        log('[IN ] send error', error.message);
        closeBoth('client send error');
      }
    });
  });

  upstream.on('close', (code, reason) => {
    log('[UP ] closed', {
      ip: clientIp,
      code,
      reason: reason ? reason.toString() : ''
    });
    closeBoth('upstream closed');
  });

  client.on('close', (code, reason) => {
    log('[IN ] closed', {
      ip: clientIp,
      code,
      reason: reason ? reason.toString() : ''
    });
    closeBoth('client closed');
  });

  upstream.on('error', error => {
    log('[UP ] error', {
      ip: clientIp,
      error: error.message || String(error)
    });
    closeBoth('upstream error');
  });

  client.on('error', error => {
    log('[IN ] error', {
      ip: clientIp,
      error: error.message || String(error)
    });
    closeBoth('client error');
  });
});

server.on('error', error => {
  log('[HTTP] server error', error.message || String(error));
});

server.listen(PORT, '0.0.0.0', () => {
  log(
    `StrengthSMP proxy listening on ${PORT} | ` +
    `WSS frontend | WS upstream: ${UPSTREAM_WS}`
  );
});
