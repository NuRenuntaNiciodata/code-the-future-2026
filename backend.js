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
const BASELINE_SAMPLE_COUNT = 10;
const OCCUPIED_DELTA_PA = 100;
const MAX_GAP_MS = 10 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 500;
const WS_VERBOSE_LOGS = process.env.WS_VERBOSE_LOGS === '1';
const CAMERA_JSON_LIMIT = '25mb';
/** Throttle DB rows for camera lighting (browser may POST frames every ~250ms). */
const LIGHTING_CAMERA_DB_MIN_MS = Number(process.env.LIGHTING_CAMERA_DB_MIN_MS) || 10000;
let lastLightingCameraDbInsertAt = 0;

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('Optional dependency "sharp" not available; camera-based brightness disabled:', e.message);
}

const multer = require('multer');
const cameraUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: CAMERA_JSON_LIMIT }));

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
const db = new sqlite3.Database(DB_FILE);

let cameraLatest = {
  has_frame: false,
  mime_type: null,
  image_base64: null,
  width: null,
  height: null,
  updated_at: null,
  bytes: 0,
  /** Same idea as OpenCV frame stats in camera_detection.py: luminance from the decoded camera frame. */
  mean_luminance_0_255: null,
  brightness_0_100: null,
  lux_estimate: null,
  decode_error: null
};

/** Latest ML room-lighting push from backend/light_detection.py (POST /api/lighting/ml). */
let lightingMlLatest = null;

/** Latest posture snapshot from backend/camera_detection.py (POST /api/posture/latest). */
let postureLatest = null;

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

// BMP history is tied to a specific baseline; we reset calibration on every boot,
// so keep in-memory history empty until fresh samples arrive (DB table is wiped in db.serialize).
readings = [];
lastSensorIngestAt = null;
try {
  fs.writeFileSync(DATA_FILE, JSON.stringify(readings), 'utf8');
} catch (error) {
  console.error('Failed to reset sensor readings JSON on boot:', error.message);
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
    CREATE TABLE IF NOT EXISTS dht22_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS lighting_camera_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      brightness_0_100 REAL,
      mean_luminance_0_255 REAL,
      lux_estimate REAL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      decode_error TEXT,
      source TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS lighting_ml_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      label TEXT NOT NULL,
      confidence REAL NOT NULL,
      brightness_score REAL NOT NULL,
      brightness_0_100 INTEGER NOT NULL,
      lux_estimate INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS posture_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      tilt_deg REAL NOT NULL,
      forward_lean REAL NOT NULL,
      slouching INTEGER NOT NULL,
      close_to_monitor INTEGER NOT NULL,
      too_slouched INTEGER NOT NULL,
      person_detected INTEGER NOT NULL,
      slouch_threshold_deg REAL,
      close_to_monitor_threshold REAL,
      source TEXT
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_lighting_camera_ts ON lighting_camera_samples(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lighting_ml_ts ON lighting_ml_samples(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_posture_ts ON posture_samples(timestamp)');

  // Always recalibrate on backend start from fresh incoming BMP readings.
  baselinePressure = null;
  calibrationSampleCount = 0;
  calibrationPressureSum = 0;
  db.run('DELETE FROM calibration_state WHERE id = 1', (error) => {
    if (error) {
      console.error('Failed to reset calibration state on startup:', error.message);
      return;
    }
    persistCalibrationState();
  });

  // Old BMP rows were captured with a different baseline; wipe them so totals don't "jump"
  // when baseline is recomputed from the next 10 samples.
  db.run('DELETE FROM sensor_readings', (error) => {
    if (error) {
      console.error('Failed to reset BMP readings table on startup:', error.message);
      return;
    }
    readings = [];
    lastSensorIngestAt = null;
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

function persistDhtReadingToDb(reading) {
  db.run(
    `
      INSERT INTO dht22_readings (temperature, humidity, timestamp)
      VALUES (?, ?, ?)
    `,
    [reading.temperature, reading.humidity, reading.timestamp],
    (error) => {
      if (error) {
        console.error('Failed to persist DHT22 reading to database:', error.message);
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

function maybePersistLightingCameraRow(body) {
  const cam = cameraLatest;
  if (!cam.has_frame || !cam.updated_at) {
    return;
  }
  const b = cam.brightness_0_100;
  const brightnessDecodeOk =
    cam.decode_error == null &&
    b !== null &&
    b !== undefined &&
    Number.isFinite(Number(b));
  if (!brightnessDecodeOk) {
    return;
  }
  const nowMs = Date.now();
  if (nowMs - lastLightingCameraDbInsertAt < LIGHTING_CAMERA_DB_MIN_MS) {
    return;
  }
  lastLightingCameraDbInsertAt = nowMs;
  const ingestSource =
    body && typeof body.source === 'string' && body.source.trim()
      ? String(body.source).trim().slice(0, 64)
      : null;
  db.run(
    `
      INSERT INTO lighting_camera_samples (
        timestamp, brightness_0_100, mean_luminance_0_255, lux_estimate,
        width, height, bytes, decode_error, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      cam.updated_at,
      Number(b),
      cam.mean_luminance_0_255,
      cam.lux_estimate,
      cam.width,
      cam.height,
      cam.bytes,
      cam.decode_error,
      ingestSource
    ],
    (error) => {
      if (error) {
        console.error('Failed to persist lighting_camera_samples:', error.message);
      }
    }
  );
}

function persistLightingMlRow(row) {
  db.run(
    `
      INSERT INTO lighting_ml_samples (
        timestamp, label, confidence, brightness_score, brightness_0_100, lux_estimate
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      row.updated_at,
      row.label,
      row.confidence,
      row.brightness_score,
      row.brightness_0_100,
      row.lux_estimate_ml
    ],
    (error) => {
      if (error) {
        console.error('Failed to persist lighting_ml_samples:', error.message);
      }
    }
  );
}

function persistPostureRow(row) {
  db.run(
    `
      INSERT INTO posture_samples (
        timestamp, status, tilt_deg, forward_lean,
        slouching, close_to_monitor, too_slouched, person_detected,
        slouch_threshold_deg, close_to_monitor_threshold, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      row.updated_at,
      row.status,
      row.tilt_deg,
      row.forward_lean,
      row.slouching ? 1 : 0,
      row.close_to_monitor ? 1 : 0,
      row.too_slouched ? 1 : 0,
      row.person_detected ? 1 : 0,
      row.slouch_threshold_deg,
      row.close_to_monitor_threshold,
      row.source
    ],
    (error) => {
      if (error) {
        console.error('Failed to persist posture_samples:', error.message);
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
  if (!Number.isNaN(timestamp)) {
    return timestamp;
  }
  const relativeTimestamp = parseRelativeEspTimestamp(value);
  return relativeTimestamp == null ? null : relativeTimestamp;
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

function computeSeatedDurationsFromRows(rows, baseline, deltaPa) {
  if (baseline == null || !Number.isFinite(baseline) || rows.length === 0) {
    return { total_seated_ms: 0, continuous_seated_ms: 0 };
  }

  const threshold = baseline + deltaPa;
  const sorted = [...rows]
    .map((row) => ({
      pressure: Number(row.pressure),
      _ts: toTimestamp(row.timestamp)
    }))
    .filter((row) => Number.isFinite(row.pressure) && row._ts != null)
    .sort((a, b) => a._ts - b._ts);

  if (sorted.length === 0) {
    return { total_seated_ms: 0, continuous_seated_ms: 0 };
  }

  let totalSeatedMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    const delta = current._ts - previous._ts;
    if (delta > 0 && delta <= MAX_GAP_MS && previous.pressure >= threshold) {
      totalSeatedMs += delta;
    }
  }

  const last = sorted[sorted.length - 1];
  if (!(last.pressure >= threshold)) {
    return { total_seated_ms: totalSeatedMs, continuous_seated_ms: 0 };
  }

  let continuousSeatedMs = 0;
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    const delta = current._ts - previous._ts;
    if (!(delta > 0 && delta <= MAX_GAP_MS)) {
      break;
    }
    if (previous.pressure >= threshold) {
      continuousSeatedMs += delta;
    } else {
      break;
    }
  }

  return { total_seated_ms: totalSeatedMs, continuous_seated_ms: continuousSeatedMs };
}

/**
 * Trend presiune BMP (Pa/oră) pe fereastra recentă — semnal slab pentru „aer în mișcare”.
 * `sortedWithTs`: citiri cu _ts și pressure finite, sortate crescător după timp.
 */
function estimatePressureTrendPaPerHour(sortedWithTs) {
  if (!sortedWithTs || sortedWithTs.length < 2) {
    return null;
  }
  const last = sortedWithTs[sortedWithTs.length - 1];
  const ref = last._ts;
  const windowMs = 90 * 60 * 1000;
  const inWin = sortedWithTs.filter((r) => r._ts >= ref - windowMs && Number.isFinite(Number(r.pressure)));
  if (inWin.length < 2) {
    return null;
  }
  const first = inWin[0];
  const end = inWin[inWin.length - 1];
  const dtMs = end._ts - first._ts;
  const minSpanMs = 20 * 60 * 1000;
  if (dtMs < minSpanMs) {
    return null;
  }
  const p0 = Number(first.pressure);
  const p1 = Number(end.pressure);
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) {
    return null;
  }
  const hours = dtMs / 3600000;
  return (p1 - p0) / hours;
}

/**
 * Recomandare ventilație (geam) din umiditate + temperatură DHT22 și trend presiune BMP.
 * ventilation_need_0_100: mare = merită aerisire; indoor_confort_0_100: derivat pentru afișaj.
 */
function computeAirVentilation(sortedWithTs, dht) {
  const hum = dht != null ? Number(dht.humidity) : null;
  const temp = dht != null ? Number(dht.temperature) : null;
  const lastReading =
    sortedWithTs && sortedWithTs.length > 0 ? sortedWithTs[sortedWithTs.length - 1] : null;
  const pressureLatest = lastReading != null ? Number(lastReading.pressure) : null;

  let hPts = 0;
  let hNote = null;
  if (hum != null && Number.isFinite(hum)) {
    if (hum >= 75) {
      hPts = 50;
      hNote = 'Umiditate foarte ridicată';
    } else if (hum >= 68) {
      hPts = 36;
      hNote = 'Umiditate ridicată';
    } else if (hum >= 62) {
      hPts = 22;
      hNote = 'Umiditate peste confort';
    } else if (hum >= 58) {
      hPts = 10;
      hNote = 'Umiditate ușor ridicată';
    } else if (hum < 30) {
      hPts = 12;
      hNote = 'Aer foarte uscat';
    } else if (hum < 35) {
      hPts = 5;
      hNote = null;
    }
  }

  let tPts = 0;
  let tNote = null;
  if (temp != null && Number.isFinite(temp)) {
    if (temp >= 29) {
      tPts = 42;
      tNote = 'Temperatură ridicată';
    } else if (temp >= 26.5) {
      tPts = 28;
      tNote = 'Cald — ventilație utilă';
    } else if (temp >= 25) {
      tPts = 14;
      tNote = 'Peste confort termic';
    } else if (temp <= 16) {
      tPts = -18;
      tNote = 'Frig în cameră';
    } else if (temp <= 17.5) {
      tPts = -10;
      tNote = 'Temperatură scăzută';
    } else if (temp <= 18.5) {
      tPts = -4;
      tNote = null;
    }
  }

  let pPts = 0;
  const trend = estimatePressureTrendPaPerHour(sortedWithTs);
  if (trend != null && Number.isFinite(trend)) {
    if (trend < -200) {
      pPts = 8;
    } else if (trend < -120) {
      pPts = 5;
    } else if (trend > 220) {
      pPts = -4;
    }
  }

  const raw = hPts + tPts + pPts;
  const need = Math.round(clampNumber(raw, 0, 100));
  const comfort = Math.round(clampNumber(100 - need * 0.92, 0, 100));

  const hasDht = hum != null && temp != null && Number.isFinite(hum) && Number.isFinite(temp);
  let recommendationRo = '';
  let openWindow = false;

  if (!hasDht) {
    recommendationRo =
      'Date insuficiente: trimite citiri DHT22 (temperatură + umiditate) pentru o recomandare de geam.';
    if (pressureLatest != null && Number.isFinite(pressureLatest) && trend != null) {
      recommendationRo +=
        ' Trend presiune BMP este disponibil, dar fără umiditate/temperatură aer recomandarea e incompletă.';
    }
  } else if (temp <= 17 && need < 35) {
    recommendationRo = 'Nu deschide geamul pentru răcire — temperatură deja scăzută. Aerisește scurt doar dacă umiditatea e mare.';
    openWindow = false;
  } else if (need >= 62) {
    recommendationRo = 'Da — deschide geamul 10–15 minute pentru aerisire (umiditate sau căldură).';
    openWindow = true;
  } else if (need >= 38) {
    recommendationRo = 'Recomandat — aerisește câteva minute.';
    openWindow = true;
  } else if (need >= 22) {
    recommendationRo = 'Opțional — poți deschide geamul scurt dacă simți aer închis.';
    openWindow = false;
  } else {
    recommendationRo = 'Nu e nevoie să deschizi geamul acum (parametri în interval confortabil).';
    openWindow = false;
  }

  return {
    ventilation_need_0_100: need,
    indoor_confort_0_100: comfort,
    open_window_recommended: openWindow,
    recommendation_ro: recommendationRo,
    humidity_pct: hasDht ? Number(hum.toFixed(1)) : null,
    temperature_c: hasDht ? Number(temp.toFixed(1)) : null,
    pressure_last_pa: pressureLatest != null && Number.isFinite(pressureLatest) ? pressureLatest : null,
    pressure_trend_pa_per_hour: trend,
    components: {
      humidity_points: hPts,
      temperature_points: tPts,
      pressure_points: pPts
    },
    notes: [hNote, tNote].filter(Boolean),
    has_dht: hasDht,
    has_pressure_trend: trend != null
  };
}

function getMetrics() {
  if (readings.length === 0) {
    const dhtOnly = getLatestDhtReading();
    const airVentilation = dhtOnly ? computeAirVentilation([], dhtOnly) : null;
    return {
      pressure_level: 0,
      temperature_level: 0,
      total_sitting_minutes: 0,
      fatigue_risk: 0,
      baseline_pressure: baselinePressure,
      calibration_progress: calibrationSampleCount,
      air_ventilation:
        airVentilation ||
        ({
          ventilation_need_0_100: 0,
          indoor_confort_0_100: 0,
          open_window_recommended: false,
          recommendation_ro: 'Așteaptă citiri de la senzor (BMP + DHT22) pentru recomandare.',
          humidity_pct: null,
          temperature_c: null,
          pressure_last_pa: null,
          pressure_trend_pa_per_hour: null,
          components: { humidity_points: 0, temperature_points: 0, pressure_points: 0 },
          notes: [],
          has_dht: false,
          has_pressure_trend: false
        })
    };
  }

  const sorted = [...readings]
    .map((reading) => ({ ...reading, _ts: toTimestamp(reading.timestamp) }))
    .filter((reading) => reading._ts != null)
    .sort((a, b) => a._ts - b._ts);

  const referenceNow = sorted.length > 0 ? sorted[sorted.length - 1]._ts : Date.now();
  const tenMinutesAgo = referenceNow - 10 * 60 * 1000;
  const twoHoursAgo = referenceNow - 2 * 60 * 60 * 1000;

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

  const airVentilation = computeAirVentilation(sorted, getLatestDhtReading());

  return {
    pressure_level: pressureLevel,
    temperature_level: temperatureLevel,
    total_sitting_minutes: totalSittingMinutes,
    fatigue_risk: fatigueRisk,
    baseline_pressure: baselinePressure,
    calibration_progress: calibrationSampleCount,
    air_ventilation: airVentilation
  };
}

function getLatestDhtReading() {
  if (!Array.isArray(dhtReadings) || dhtReadings.length === 0) {
    return null;
  }
  return dhtReadings[dhtReadings.length - 1];
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Brightness from decoded JPEG/PNG (browser → POST /api/camera-frame), analogous to
 * running cv2.cvtColor(frame, BGR2GRAY) and averaging pixel intensity in camera_detection.py.
 */
async function computeCameraBrightnessFromBuffer(imageBuffer) {
  if (!sharp || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      mean_luminance_0_255: null,
      brightness_0_100: null,
      lux_estimate: null,
      decode_error: !sharp ? 'sharp module not loaded (run npm install sharp on the Pi)' : 'empty buffer'
    };
  }
  try {
    const { data, info } = await sharp(imageBuffer)
      .resize({ width: 320, height: 320, fit: 'inside' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!data.length || info.channels !== 1) {
      return {
        mean_luminance_0_255: null,
        brightness_0_100: null,
        lux_estimate: null,
        decode_error: 'unexpected raw image shape'
      };
    }
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      sum += data[i];
    }
    const mean = sum / data.length;
    const brightness_0_100 = Math.round(clampNumber((mean / 255) * 100, 0, 100));
    const lux_estimate = Math.round(brightness_0_100 * 12);
    return {
      mean_luminance_0_255: Number(mean.toFixed(2)),
      brightness_0_100,
      lux_estimate,
      decode_error: null
    };
  } catch (err) {
    console.warn('Camera brightness decode failed:', err.message);
    return {
      mean_luminance_0_255: null,
      brightness_0_100: null,
      lux_estimate: null,
      decode_error: err.message || String(err)
    };
  }
}

function estimateDataQuality(metrics, dht) {
  const hasDht = Boolean(dht) && Number.isFinite(Number(dht?.humidity)) && Number.isFinite(Number(dht?.temperature));
  const hasBmp = Array.isArray(readings) && readings.length > 0;
  const calibrationOk =
    Number.isFinite(baselinePressure) && calibrationSampleCount >= BASELINE_SAMPLE_COUNT;
  let score = 0;
  if (hasBmp) score += 35;
  if (hasDht) score += 35;
  if (calibrationOk) score += 20;
  if (cameraLatest.has_frame) score += 10;
  score = Math.round(clampNumber(score, 0, 100));
  const label =
    score >= 85 ? 'good' : score >= 60 ? 'fair' : score >= 40 ? 'degraded' : 'poor';
  return {
    score,
    label,
    has_bmp280: hasBmp,
    has_dht22: hasDht,
    calibration_ready: calibrationOk,
    has_camera_frame: cameraLatest.has_frame,
    fatigue_risk: metrics?.fatigue_risk ?? null
  };
}

app.get('/api/camera/latest', (req, res) => {
  if (!cameraLatest.has_frame || !cameraLatest.image_base64) {
    return res.status(200).json({
      ok: true,
      has_frame: false,
      mime_type: null,
      image_base64: null,
      width: null,
      height: null,
      updated_at: null,
      mean_luminance_0_255: null,
      brightness_0_100: null,
      lux_estimate: null,
      brightness_decode_ok: false,
      decode_error: null,
      bytes: 0
    });
  }
  const brightnessDecodeOk =
    cameraLatest.decode_error == null &&
    cameraLatest.brightness_0_100 !== null &&
    cameraLatest.brightness_0_100 !== undefined &&
    Number.isFinite(Number(cameraLatest.brightness_0_100));
  return res.status(200).json({
    ok: true,
    has_frame: true,
    mime_type: cameraLatest.mime_type,
    image_base64: cameraLatest.image_base64,
    width: cameraLatest.width,
    height: cameraLatest.height,
    updated_at: cameraLatest.updated_at,
    mean_luminance_0_255: cameraLatest.mean_luminance_0_255,
    brightness_0_100: cameraLatest.brightness_0_100,
    lux_estimate: cameraLatest.lux_estimate,
    brightness_decode_ok: brightnessDecodeOk,
    decode_error: cameraLatest.decode_error,
    bytes: cameraLatest.bytes
  });
});

function cameraMultipartMiddleware(req, res, next) {
  const ct = req.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) {
    return next();
  }
  cameraUpload.any()(req, res, (err) => {
    if (!err) return next();
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'File too large (max 25MB)' });
    }
    return res.status(400).json({ ok: false, error: err.message || 'Upload parse failed' });
  });
}

app.post(
  '/api/camera-frame',
  cameraMultipartMiddleware,
  async (req, res) => {
    let buffer = null;
    let mimeType = 'image/jpeg';
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let width = Number(body.width);
    let height = Number(body.height);

    const files = req.files;
    if (Array.isArray(files) && files.length > 0) {
      const img =
        files.find((f) => f.mimetype && String(f.mimetype).startsWith('image/')) ||
        files.find((f) => Buffer.isBuffer(f.buffer) && f.buffer.length) ||
        files[0];
      if (img && Buffer.isBuffer(img.buffer) && img.buffer.length) {
        buffer = img.buffer;
        if (img.mimetype && typeof img.mimetype === 'string') mimeType = img.mimetype;
      }
    }

    let base64ForStore = null;
    if (!buffer) {
      const raw =
        typeof body.frame === 'string'
          ? body.frame
          : typeof body.image === 'string'
            ? body.image
            : typeof body.data === 'string'
              ? body.data
              : typeof body.image_base64 === 'string'
                ? body.image_base64
                : null;
      if (!raw || typeof raw !== 'string') {
        return res.status(400).json({
          ok: false,
          error:
            'No image: use JSON { "frame": "<base64>" } or multipart/form-data with an image file (e.g. field frame, image, file, photo).',
          content_type: req.get('Content-Type') || null
        });
      }
      mimeType =
        typeof body.mime_type === 'string' && body.mime_type.trim()
          ? body.mime_type.trim()
          : typeof body.content_type === 'string' && body.content_type.trim()
            ? body.content_type.trim()
            : 'image/jpeg';
      const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
      if (!base64) {
        return res.status(400).json({ ok: false, error: 'Empty frame payload' });
      }
      buffer = Buffer.from(base64, 'base64');
      base64ForStore = base64;
      if (!buffer.length) {
        return res.status(400).json({ ok: false, error: 'Invalid base64 frame' });
      }
    } else {
      base64ForStore = buffer.toString('base64');
    }

    const lum = await computeCameraBrightnessFromBuffer(buffer);
    cameraLatest = {
      has_frame: true,
      mime_type: mimeType,
      image_base64: base64ForStore,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      updated_at: new Date().toISOString(),
      bytes: buffer.length,
      mean_luminance_0_255: lum.mean_luminance_0_255,
      brightness_0_100: lum.brightness_0_100,
      lux_estimate: lum.lux_estimate,
      decode_error: lum.decode_error != null ? lum.decode_error : null
    };
    const brightnessDecodeOk =
      lum.decode_error == null &&
      lum.brightness_0_100 !== null &&
      lum.brightness_0_100 !== undefined &&
      Number.isFinite(Number(lum.brightness_0_100));
    maybePersistLightingCameraRow(body);
    return res.status(200).json({
      ok: true,
      received_bytes: buffer.length,
      updated_at: cameraLatest.updated_at,
      mean_luminance_0_255: lum.mean_luminance_0_255,
      brightness_0_100: lum.brightness_0_100,
      lux_estimate: lum.lux_estimate,
      brightness_decode_ok: brightnessDecodeOk,
      decode_error: lum.decode_error,
      sharp_loaded: Boolean(sharp),
      content_type: req.get('Content-Type') || null
    });
  }
);

const ML_LIGHT_LABELS = new Set(['dark', 'dim', 'normal', 'bright']);

app.post('/api/lighting/ml', (req, res) => {
  const body = req.body || {};
  const label = typeof body.label === 'string' ? body.label.trim().toLowerCase() : '';
  const confidence = Number(body.confidence);
  const brightnessScore = Number(body.brightness_score);
  if (!ML_LIGHT_LABELS.has(label)) {
    return res.status(400).json({
      ok: false,
      error: `label must be one of: ${[...ML_LIGHT_LABELS].join(', ')}`
    });
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return res.status(400).json({ ok: false, error: 'confidence must be a number between 0 and 1' });
  }
  if (!Number.isFinite(brightnessScore) || brightnessScore < 0 || brightnessScore > 1) {
    return res
      .status(400)
      .json({ ok: false, error: 'brightness_score must be a number between 0 and 1 (mean RGB from model)' });
  }
  const brightness_0_100 = Math.round(clampNumber(brightnessScore * 100, 0, 100));
  const updated_at = new Date().toISOString();
  lightingMlLatest = {
    label,
    confidence,
    brightness_score: brightnessScore,
    brightness_0_100,
    lux_estimate_ml: Math.round(brightness_0_100 * 12),
    updated_at
  };
  persistLightingMlRow(lightingMlLatest);
  return res.status(200).json({ ok: true, stored: true, ...lightingMlLatest });
});

app.get('/api/lighting/latest', (req, res) => {
  const dht = getLatestDhtReading();
  // Number(null) === 0 is finite — must not treat missing sharp decode as valid camera brightness.
  const camBright = cameraLatest.brightness_0_100;
  const hasCameraBrightness =
    cameraLatest.has_frame &&
    camBright !== null &&
    camBright !== undefined &&
    Number.isFinite(Number(camBright));
  const lighting = hasCameraBrightness
    ? {
        lux_estimate: cameraLatest.lux_estimate,
        brightness_0_100: cameraLatest.brightness_0_100,
        mean_luminance_0_255: cameraLatest.mean_luminance_0_255,
        source: 'camera'
      }
    : {
        lux_estimate: null,
        brightness_0_100: null,
        mean_luminance_0_255: null,
        source: 'none'
      };
  const ml =
    lightingMlLatest && lightingMlLatest.updated_at
      ? {
          label: lightingMlLatest.label,
          confidence: lightingMlLatest.confidence,
          brightness_score: lightingMlLatest.brightness_score,
          brightness_0_100: lightingMlLatest.brightness_0_100,
          lux_estimate: lightingMlLatest.lux_estimate_ml,
          updated_at: lightingMlLatest.updated_at
        }
      : null;
  return res.status(200).json({
    ok: true,
    updated_at: hasCameraBrightness ? cameraLatest.updated_at : null,
    temperature_c: dht ? Number(dht.temperature) : null,
    humidity_pct: dht ? Number(dht.humidity) : null,
    ...lighting,
    ml
  });
});

app.post('/api/posture/latest', (req, res) => {
  const body = req.body || {};
  const raw = typeof body.status === 'string' ? body.status.trim() : '';
  const upper = raw.toUpperCase();
  let normalizedStatus = '';
  if (upper.includes('NO PERSON')) {
    normalizedStatus = 'NO PERSON';
  } else if (upper.includes('SLOUCH')) {
    normalizedStatus = 'YOU ARE TOO SLOUCHED';
  } else if (upper.includes('GOOD')) {
    normalizedStatus = 'GOOD POSTURE';
  }
  if (!normalizedStatus) {
    return res.status(400).json({
      ok: false,
      error: 'status must resemble NO PERSON, GOOD POSTURE, or YOU ARE TOO SLOUCHED'
    });
  }
  const tiltDeg = Number(body.tilt_deg);
  const forwardLean = Number(body.forward_lean);
  if (!Number.isFinite(tiltDeg) || !Number.isFinite(forwardLean)) {
    return res.status(400).json({ ok: false, error: 'tilt_deg and forward_lean must be finite numbers' });
  }
  const slouching = Boolean(body.slouching);
  const closeToMonitor = Boolean(body.close_to_monitor);
  const slouchThresholdDeg =
    body.slouch_threshold_deg != null && Number.isFinite(Number(body.slouch_threshold_deg))
      ? Number(body.slouch_threshold_deg)
      : null;
  const closeToMonitorThreshold =
    body.close_to_monitor_threshold != null && Number.isFinite(Number(body.close_to_monitor_threshold))
      ? Number(body.close_to_monitor_threshold)
      : null;
  const tooSlouched = normalizedStatus === 'YOU ARE TOO SLOUCHED';
  const personDetected = normalizedStatus !== 'NO PERSON';
  const updated_at = new Date().toISOString();
  const sourceTag =
    typeof body.source === 'string' && body.source.trim()
      ? String(body.source).trim().slice(0, 64)
      : 'pi_mediapipe';
  postureLatest = {
    status: normalizedStatus,
    tilt_deg: Number(tiltDeg.toFixed(2)),
    forward_lean: Number(forwardLean.toFixed(4)),
    slouching,
    close_to_monitor: closeToMonitor,
    too_slouched: tooSlouched,
    person_detected: personDetected,
    slouch_threshold_deg: slouchThresholdDeg,
    close_to_monitor_threshold: closeToMonitorThreshold,
    source: sourceTag,
    updated_at
  };
  persistPostureRow(postureLatest);
  console.log('[posture]', postureLatest.status, 'tilt', postureLatest.tilt_deg, 'deg');
  return res.status(200).json({ ok: true, stored: true, ...postureLatest });
});

app.get('/api/posture/latest', (req, res) => {
  if (!postureLatest || !postureLatest.updated_at) {
    return res.status(200).json({
      ok: true,
      has_data: false,
      status: null,
      tilt_deg: null,
      forward_lean: null,
      slouching: null,
      close_to_monitor: null,
      too_slouched: null,
      person_detected: null,
      slouch_threshold_deg: null,
      close_to_monitor_threshold: null,
      source: null,
      updated_at: null
    });
  }
  return res.status(200).json({
    ok: true,
    has_data: true,
    ...postureLatest
  });
});

app.get('/api/data-quality', (req, res) => {
  const metrics = getMetrics();
  const dht = getLatestDhtReading();
  return res.status(200).json({
    ok: true,
    updated_at: new Date().toISOString(),
    ...estimateDataQuality(metrics, dht)
  });
});

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
  persistDhtReadingToDb(payload);

  return res.status(201).json({ stored: true, count: dhtReadings.length, latest: payload });
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
  const isCalibrated = calibrationSampleCount >= BASELINE_SAMPLE_COUNT && baselinePressure != null;
  const seatedByPressure =
    isCalibrated && Number.isFinite(currentPressure) && thresholdPressure != null
      ? currentPressure >= thresholdPressure
      : null;

  db.all(
    'SELECT pressure, timestamp FROM sensor_readings ORDER BY id ASC',
    (error, rows) => {
      if (error) {
        console.error('Failed to load sensor readings for seat duration:', error.message);
        return res.status(500).json({ error: 'Failed to compute seated durations' });
      }

      const { total_seated_ms, continuous_seated_ms } = computeSeatedDurationsFromRows(
        rows,
        baselinePressure,
        OCCUPIED_DELTA_PA
      );

      return res.json({
        status:
          latest == null
            ? 'unknown'
            : seatedByPressure === true
              ? 'seated'
              : seatedByPressure === false
                ? 'not_seated'
                : latest.seat_occupied
                  ? 'seated'
                  : 'not_seated',
        seat_occupied: seatedByPressure == null ? (latest ? latest.seat_occupied : null) : seatedByPressure,
        current_pressure: Number.isFinite(currentPressure) ? currentPressure : null,
        baseline_pressure: baselinePressure,
        threshold_pressure: thresholdPressure,
        pressure_delta_from_baseline: pressureDeltaFromBaseline,
        calibrated: isCalibrated,
        sample_count: calibrationSampleCount,
        total_seated_ms: Math.floor(total_seated_ms),
        continuous_seated_ms: Math.floor(continuous_seated_ms),
        total_seated_seconds: Math.floor(total_seated_ms / 1000),
        total_seated_minutes: Math.round(total_seated_ms / 60000),
        continuous_seated_seconds: Math.floor(continuous_seated_ms / 1000),
        continuous_seated_minutes: Math.round(continuous_seated_ms / 60000),
        total_seated_sec: Math.floor(total_seated_ms / 1000),
        continuous_seated_sec: Math.floor(continuous_seated_ms / 1000)
      });
    }
  );
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP + WebSocket listening on 0.0.0.0:${PORT} (e.g. http://127.0.0.1:${PORT} / http://<this-host-ip>:${PORT})`);
});

console.log(`WebSocket server running on port:${PORT}`);
