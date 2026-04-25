const WebSocket = require('ws');

const WS_PORT = Number.parseInt(process.env.WS_PORT || '8080', 10);
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || '';
const RECONNECT_DELAY_MS = 3000;

const wss = new WebSocket.Server({ port: WS_PORT });

let latestCameraFrame = null;
let latestSensorPayload = null;

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toBroadcastPayload(rawMessage) {
  if (typeof rawMessage === 'string') {
    const parsed = safeJsonParse(rawMessage);

    // If the source already sent a typed payload, keep it unchanged.
    if (parsed && parsed.type && parsed.payload) {
      return parsed;
    }

    // Heuristic: treat frame-like messages as camera payloads.
    if (parsed && (parsed.frame || parsed.image || parsed.imageBase64 || parsed.cameraFrame)) {
      const cameraPayload = {
        frame: parsed.frame || parsed.image || parsed.imageBase64 || parsed.cameraFrame,
        mimeType: parsed.mimeType || 'image/jpeg',
        timestamp: parsed.timestamp || new Date().toISOString(),
      };

      latestCameraFrame = cameraPayload;
      return { type: 'camera-frame', payload: cameraPayload };
    }

    if (parsed) {
      latestSensorPayload = parsed;
      return { type: 'sensor-data', payload: parsed };
    }

    return {
      type: 'raw-text',
      payload: {
        message: rawMessage,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Binary payloads are forwarded as base64 camera frames.
  if (Buffer.isBuffer(rawMessage)) {
    const payload = {
      frame: rawMessage.toString('base64'),
      mimeType: 'image/jpeg',
      timestamp: new Date().toISOString(),
    };
    latestCameraFrame = payload;
    return { type: 'camera-frame', payload };
  }

  return {
    type: 'unknown',
    payload: {
      timestamp: new Date().toISOString(),
    },
  };
}

function broadcastJson(obj) {
  const serialized = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  });
}

function connectUpstream() {
  if (!UPSTREAM_WS_URL) {
    return;
  }

  const upstream = new WebSocket(UPSTREAM_WS_URL);

  upstream.on('open', () => {
    console.log(`Connected to upstream stream: ${UPSTREAM_WS_URL}`);
  });

  upstream.on('message', (message, isBinary) => {
    const normalized = toBroadcastPayload(isBinary ? Buffer.from(message) : message.toString());
    broadcastJson(normalized);
  });

  upstream.on('error', (err) => {
    console.error(`Upstream WebSocket error: ${err.message}`);
  });

  upstream.on('close', () => {
    console.log(`Upstream disconnected. Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(connectUpstream, RECONNECT_DELAY_MS);
  });
}

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'connection-status',
      payload: {
        message: 'Connected to WebSocket relay server',
        timestamp: new Date().toISOString(),
      },
    })
  );

  if (latestSensorPayload) {
    ws.send(JSON.stringify({ type: 'sensor-data', payload: latestSensorPayload }));
  }

  if (latestCameraFrame) {
    ws.send(JSON.stringify({ type: 'camera-frame', payload: latestCameraFrame }));
  }

  ws.on('message', (message, isBinary) => {
    const normalized = toBroadcastPayload(isBinary ? Buffer.from(message) : message.toString());
    broadcastJson(normalized);
  });
});

connectUpstream();

console.log(`WebSocket server running on ws://0.0.0.0:${WS_PORT}`);
if (UPSTREAM_WS_URL) {
  console.log(`Upstream source configured: ${UPSTREAM_WS_URL}`);
}
