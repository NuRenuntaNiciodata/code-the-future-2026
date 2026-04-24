const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'sensor-readings.json');
const DB_FILE = path.join(__dirname, 'sensor-readings.db');
const DHT_DATA_FILE = path.join(__dirname, 'dht22-readings.json');
const MAX_READINGS = 50000;
const BASELINE_SAMPLE_COUNT = 100;
const OCCUPIED_DELTA_PA = 200;
const PERSIST_DEBOUNCE_MS = 500;
const WS_VERBOSE_LOGS = process.env.WS_VERBOSE_LOGS === '1';

app.use(cors());
app.use(express.json());

let readings = [];
let dhtReadings = [];
let baselinePressure = null;
let calibrationSampleCount = 0;
let calibrationPressureSum = 0;
let wss = null;
let lastSensorIngestAt = null;
let lastDhtIngestAt = null;
let readingsPersistTimer = null;
let dhtPersistTimer = null;
let readingsWriteInProgress = false;
let dhtWriteInProgress = false;
let readingsPersistQueued = false;
let dhtPersistQueued = false;
let latestCameraFrameMeta = null;
const db = new sqlite3.Database(DB_FILE);

if (fs.existsSync(DATA_FILE)) {
  try {
    const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(fileContent);
    if (Array.isArray(parsed)) {
      readings = parsed;
    }
  } catch (error) {
    console.error('Failed to load sensor readings file:', error.message);
  }
}

if (fs.existsSync(DHT_DATA_FILE)) {
  try {
    const fileContent = fs.readFileSync(DHT_DATA_FILE, 'utf8');
    const parsed = JSON.parse(fileContent);
    if (Array.isArray(parsed)) {
      dhtReadings = parsed;
    }
  } catch (error) {
    console.error('Failed to load DHT22 readings file:', error.message);
  }
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pressure REAL,
      temperature REAL,
      seat_occupied INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS calibration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baseline_pressure REAL,
      sample_count INTEGER NOT NULL,
      pressure_sum REAL NOT NULL
    )
  `);

  db.get('SELECT baseline_pressure, sample_count, pressure_sum FROM calibration_state WHERE id = 1', (error, row) => {
    if (error) {
      console.error('Failed to load calibration state:', error.message);
      return;
    }
    if (row) {
      baselinePressure = typeof row.baseline_pressure === 'number' ? row.baseline_pressure : null;
      calibrationSampleCount = Number(row.sample_count || 0);
      calibrationPressureSum = Number(row.pressure_sum || 0);
      return;
    }

    const pressureReadings = readings
      .map((reading) => Number(reading.pressure))
      .filter((value) => Number.isFinite(value))
      .slice(0, BASELINE_SAMPLE_COUNT);

    calibrationSampleCount = pressureReadings.length;
    calibrationPressureSum = pressureReadings.reduce((sum, value) => sum + value, 0);
    if (calibrationSampleCount >= BASELINE_SAMPLE_COUNT) {
      baselinePressure = calibrationPressureSum / BASELINE_SAMPLE_COUNT;
    }
    persistCalibrationState();
  });
});

function flushReadingsToDisk() {
  if (readingsWriteInProgress) {
    readingsPersistQueued = true;
    return;
  }
  readingsWriteInProgress = true;
  const snapshot = JSON.stringify(readings);
  fs.promises
    .writeFile(DATA_FILE, snapshot, 'utf8')
    .catch((error) => {
      console.error('Failed to persist sensor readings:', error.message);
    })
    .finally(() => {
      readingsWriteInProgress = false;
      if (readingsPersistQueued) {
        readingsPersistQueued = false;
        flushReadingsToDisk();
      }
    });
}

function persistReadings() {
  if (readingsPersistTimer) {
    return;
  }
  readingsPersistTimer = setTimeout(() => {
    readingsPersistTimer = null;
    flushReadingsToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

function flushDhtReadingsToDisk() {
  if (dhtWriteInProgress) {
    dhtPersistQueued = true;
    return;
  }
  dhtWriteInProgress = true;
  const snapshot = JSON.stringify(dhtReadings);
  fs.promises
    .writeFile(DHT_DATA_FILE, snapshot, 'utf8')
    .catch((error) => {
      console.error('Failed to persist DHT22 readings:', error.message);
    })
    .finally(() => {
      dhtWriteInProgress = false;
      if (dhtPersistQueued) {
        dhtPersistQueued = false;
        flushDhtReadingsToDisk();
      }
    });
}

function persistDhtReadings() {
  if (dhtPersistTimer) {
    return;
  }
  dhtPersistTimer = setTimeout(() => {
    dhtPersistTimer = null;
    flushDhtReadingsToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

function persistCalibrationState() {
  db.run(
    `
      INSERT INTO calibration_state (id, baseline_pressure, sample_count, pressure_sum)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        baseline_pressure = excluded.baseline_pressure,
        sample_count = excluded.sample_count,
        pressure_sum = excluded.pressure_sum
    `,
    [baselinePressure, calibrationSampleCount, calibrationPressureSum],
    (error) => {
      if (error) {
        console.error('Failed to persist calibration state:', error.message);
      }
    }
  );
}

function persistReadingToDb(reading) {
  db.run(
    `
      INSERT INTO sensor_readings (pressure, temperature, seat_occupied, timestamp)
      VALUES (?, ?, ?, ?)
    `,
    [reading.pressure, reading.temperature, reading.seat_occupied ? 1 : 0, reading.timestamp],
    (error) => {
      if (error) {
        console.error('Failed to persist sensor reading to database:', error.message);
      }
    }
  );
}

function updateCalibrationWithPressure(pressure) {
  if (!Number.isFinite(pressure)) {
    return;
  }
  if (calibrationSampleCount >= BASELINE_SAMPLE_COUNT) {
    return;
  }

  calibrationSampleCount += 1;
  calibrationPressureSum += pressure;
  if (calibrationSampleCount === BASELINE_SAMPLE_COUNT) {
    baselinePressure = calibrationPressureSum / BASELINE_SAMPLE_COUNT;
  }
  persistCalibrationState();
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseRelativeEspTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function normalizeIncomingTimestamp(rawTimestamp) {
  if (rawTimestamp == null) {
    return new Date().toISOString();
  }
  return String(rawTimestamp);
}

function processIncomingReading(input) {
  const pressureValue = Number(input.pressure);
  const temperatureValue = Number(input.temperature);
  const hasValidPressure = Number.isFinite(pressureValue);
  const hasValidTemperature = Number.isFinite(temperatureValue);

  if (!hasValidPressure || !hasValidTemperature) {
    return { error: 'pressure (number) and temperature (number) are required' };
  }

  updateCalibrationWithPressure(pressureValue);
  const isCalibrated = baselinePressure != null && calibrationSampleCount >= BASELINE_SAMPLE_COUNT;
  const seatOccupied = isCalibrated ? pressureValue >= baselinePressure + OCCUPIED_DELTA_PA : false;

  const payload = {
    pressure: pressureValue,
    temperature: temperatureValue,
    seat_occupied: seatOccupied,
    timestamp: normalizeIncomingTimestamp(input.timestamp)
  };

  readings.push(payload);
  lastSensorIngestAt = Date.now();
  if (readings.length > MAX_READINGS) {
    readings = readings.slice(readings.length - MAX_READINGS);
  }
  persistReadings();
  persistReadingToDb(payload);
  broadcastRealtimeUpdate({ type: 'sensor-reading', payload });

  return {
    stored: true,
    count: readings.length,
    seat_occupied: seatOccupied,
    seat_status: seatOccupied ? 'seated' : 'not_seated',
    calibration: {
      sample_count: calibrationSampleCount,
      required_samples: BASELINE_SAMPLE_COUNT,
      baseline_pressure: baselinePressure,
      threshold_pressure: baselinePressure == null ? null : baselinePressure + OCCUPIED_DELTA_PA
    }
  };
}

function broadcastRealtimeUpdate(message) {
  if (!wss) {
    return;
  }
  const serialized = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  });
}

function getMetrics() {
  if (readings.length === 0) {
    return {
      pressure_level: 0,
      temperature_level: 0,
      total_sitting_minutes: 0,
      fatigue_risk: 0,
      baseline_pressure: baselinePressure,
      calibration_progress: calibrationSampleCount
    };
  }

  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  const recentSensorReadings = readings.filter((reading) => {
    const ts = toTimestamp(reading.timestamp);
    return ts != null && ts >= tenMinutesAgo;
  });

  const sensorSource = recentSensorReadings.length > 0 ? recentSensorReadings : readings;
  const pressureValues = sensorSource.map((reading) => Number(reading.pressure)).filter((value) => Number.isFinite(value));
  const temperatureValues = sensorSource
    .map((reading) => Number(reading.temperature))
    .filter((value) => Number.isFinite(value));
  const pressureLevel =
    pressureValues.length > 0
      ? Number((pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length).toFixed(2))
      : 0;
  const temperatureLevel =
    temperatureValues.length > 0
      ? Number((temperatureValues.reduce((sum, value) => sum + value, 0) / temperatureValues.length).toFixed(2))
      : 0;

  const sorted = [...readings]
    .map((reading) => ({ ...reading, _ts: toTimestamp(reading.timestamp) }))
    .filter((reading) => reading._ts != null)
    .sort((a, b) => a._ts - b._ts);

  let totalSittingMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    const delta = current._ts - previous._ts;
    if (delta > 0 && delta < 10 * 60 * 1000 && previous.seat_occupied === true) {
      totalSittingMs += delta;
    }
  }
  const totalSittingMinutes = Math.round(totalSittingMs / 60000);

  const recent = sorted.filter((reading) => reading._ts >= twoHoursAgo);
  const recentSittingMinutes = Math.min(
    120,
    Math.round(
      recent.reduce((acc, reading, index) => {
        if (index === 0) return acc;
        const prev = recent[index - 1];
        const delta = reading._ts - prev._ts;
        if (delta > 0 && delta < 10 * 60 * 1000 && prev.seat_occupied === true) {
          return acc + delta / 60000;
        }
        return acc;
      }, 0)
    )
  );
  const sittingRisk = recentSittingMinutes / 120;
  const fatigueRisk = Number(Math.min(1, sittingRisk * 0.8 + 0.1).toFixed(2));

  return {
    pressure_level: pressureLevel,
    temperature_level: temperatureLevel,
    total_sitting_minutes: totalSittingMinutes,
    fatigue_risk: fatigueRisk,
    baseline_pressure: baselinePressure,
    calibration_progress: calibrationSampleCount
  };
}

app.post('/api/sensor-reading', (req, res) => {
  const result = processIncomingReading(req.body || {});
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  return res.status(201).json(result);
});

app.post('/api/dht22-reading', (req, res) => {
  const temperature = Number(req.body?.temperature);
  const humidity = Number(req.body?.humidity);
  const timestamp = req.body?.timestamp ? String(req.body.timestamp) : new Date().toISOString();

  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
    return res.status(400).json({ error: 'temperature (number) and humidity (number) are required' });
  }

  const payload = {
    temperature,
    humidity,
    timestamp
  };

  dhtReadings.push(payload);
  lastDhtIngestAt = Date.now();
  if (dhtReadings.length > MAX_READINGS) {
    dhtReadings = dhtReadings.slice(dhtReadings.length - MAX_READINGS);
  }
  persistDhtReadings();

  return res.status(201).json({ stored: true, count: dhtReadings.length, latest: payload });
});

app.post('/api/camera-frame', (req, res) => {
  const frame = req.body?.frame || req.body?.image || req.body?.imageBase64 || req.body?.cameraFrame;
  if (typeof frame !== 'string' || frame.length === 0) {
    return res.status(400).json({ error: 'frame is required as base64 string or data URL' });
  }

  latestCameraFrameMeta = {
    timestamp: new Date().toISOString(),
    width: Number.isFinite(Number(req.body?.width)) ? Number(req.body.width) : null,
    height: Number.isFinite(Number(req.body?.height)) ? Number(req.body.height) : null,
    source: req.body?.source ? String(req.body.source) : 'webapp',
    bytes: frame.length,
  };

  broadcastRealtimeUpdate({ type: 'camera-frame', payload: latestCameraFrameMeta });
  return res.status(201).json({ stored: true, latest: latestCameraFrameMeta });
});

app.get('/api/metrics', (req, res) => {
  res.json(getMetrics());
});

app.get('/api/sensor-readings/latest', (req, res) => {
  const latest = readings.length > 0 ? readings[readings.length - 1] : null;
  const thresholdPressure = baselinePressure == null ? null : baselinePressure + OCCUPIED_DELTA_PA;
  const pressureDeltaFromBaseline =
    latest && thresholdPressure != null && Number.isFinite(Number(latest.pressure))
      ? Number((Number(latest.pressure) - baselinePressure).toFixed(2))
      : null;
  res.json({
    latest,
    count: readings.length,
    seat_status: latest ? (latest.seat_occupied ? 'seated' : 'not_seated') : 'unknown',
    threshold_pressure: thresholdPressure,
    pressure_delta_from_baseline: pressureDeltaFromBaseline
  });
});

app.get('/api/dht22/latest', (req, res) => {
  const latest = dhtReadings.length > 0 ? dhtReadings[dhtReadings.length - 1] : null;
  res.json({ latest, count: dhtReadings.length });
});

app.get('/api/calibration-status', (req, res) => {
  const thresholdPressure = baselinePressure == null ? null : baselinePressure + OCCUPIED_DELTA_PA;
  res.json({
    baseline_pressure: baselinePressure,
    sample_count: calibrationSampleCount,
    required_samples: BASELINE_SAMPLE_COUNT,
    threshold_pressure: thresholdPressure,
    calibrated: calibrationSampleCount >= BASELINE_SAMPLE_COUNT && baselinePressure != null
  });
});

app.get('/api/seat-status', (req, res) => {
  const latest = readings.length > 0 ? readings[readings.length - 1] : null;
  const thresholdPressure = baselinePressure == null ? null : baselinePressure + OCCUPIED_DELTA_PA;
  const currentPressure = latest ? Number(latest.pressure) : null;
  const pressureDeltaFromBaseline =
    latest && baselinePressure != null && Number.isFinite(currentPressure)
      ? Number((currentPressure - baselinePressure).toFixed(2))
      : null;

  res.json({
    status: latest ? (latest.seat_occupied ? 'seated' : 'not_seated') : 'unknown',
    seat_occupied: latest ? latest.seat_occupied : null,
    current_pressure: Number.isFinite(currentPressure) ? currentPressure : null,
    baseline_pressure: baselinePressure,
    threshold_pressure: thresholdPressure,
    pressure_delta_from_baseline: pressureDeltaFromBaseline,
    calibrated: calibrationSampleCount >= BASELINE_SAMPLE_COUNT && baselinePressure != null,
    sample_count: calibrationSampleCount
  });
});

app.get('/api/camera/latest', (req, res) => {
  res.json({
    has_frame: latestCameraFrameMeta != null,
    latest: latestCameraFrameMeta,
  });
});

app.get('/api/ingest-status', (req, res) => {
  const now = Date.now();
  const memory = process.memoryUsage();
  res.json({
    counts: {
      sensor: readings.length,
      dht22: dhtReadings.length
    },
    last_ingest: {
      sensor_epoch_ms: lastSensorIngestAt,
      sensor_seconds_ago: lastSensorIngestAt == null ? null : Math.floor((now - lastSensorIngestAt) / 1000),
      dht22_epoch_ms: lastDhtIngestAt,
      dht22_seconds_ago: lastDhtIngestAt == null ? null : Math.floor((now - lastDhtIngestAt) / 1000)
    },
    memory_mb: {
      rss: Number((memory.rss / 1024 / 1024).toFixed(2)),
      heap_used: Number((memory.heapUsed / 1024 / 1024).toFixed(2)),
      heap_total: Number((memory.heapTotal / 1024 / 1024).toFixed(2))
    },
    limits: {
      max_readings_kept: MAX_READINGS
    }
  });
});

const server = http.createServer(app);
wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ message: 'Connected to sensor websocket endpoint' }));

  ws.on('message', (rawMessage) => {
    if (WS_VERBOSE_LOGS) {
      console.log('[WS] Message received:', rawMessage.toString());
    }
    let parsed;
    try {
      parsed = JSON.parse(rawMessage.toString());
    } catch (error) {
      ws.send(JSON.stringify({ error: 'Invalid JSON payload' }));
      return;
    }

    const result = processIncomingReading(parsed);
    ws.send(JSON.stringify(result));
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Express server running on port:${PORT}`);
});

console.log(`WebSocket server running on port:${PORT}`);
