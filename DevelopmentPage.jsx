import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HomePage from "./HomePage";

/** Same math as backend/camera_detection.py (MediaPipe landmark indices). */
const SLOUCH_THRESHOLD_DEG = 18;
const CLOSE_TO_MONITOR_THRESHOLD = 0.96;

function angleFromVertical(dx, dy) {
  return Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
}

function posturePayloadFromLandmarks(landmarks) {
  const base = {
    slouch_threshold_deg: SLOUCH_THRESHOLD_DEG,
    close_to_monitor_threshold: CLOSE_TO_MONITOR_THRESHOLD,
  };
  if (!landmarks || landmarks.length < 25) {
    return {
      ...base,
      status: "NO PERSON",
      tilt_deg: 0,
      forward_lean: 0,
      slouching: false,
      close_to_monitor: false,
    };
  }

  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (!nose || !leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return {
      ...base,
      status: "NO PERSON",
      tilt_deg: 0,
      forward_lean: 0,
      slouching: false,
      close_to_monitor: false,
    };
  }

  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderMidZ = (leftShoulder.z + rightShoulder.z) / 2;
  const hipMidX = (leftHip.x + rightHip.x) / 2;
  const hipMidY = (leftHip.y + rightHip.y) / 2;

  const dx = shoulderMidX - hipMidX;
  const dy = shoulderMidY - hipMidY;

  const tiltDeg = angleFromVertical(dx, dy);
  const slouching = tiltDeg > SLOUCH_THRESHOLD_DEG;
  const forwardLean = shoulderMidZ - nose.z;
  const closeToMonitor = forwardLean > CLOSE_TO_MONITOR_THRESHOLD;

  let status = "GOOD POSTURE";
  if (slouching && closeToMonitor) status = "YOU ARE TOO SLOUCHED";
  else if (slouching) status = "YOU ARE TOO SLOUCHED";
  else if (closeToMonitor) status = "YOU ARE TOO SLOUCHED";

  return {
    ...base,
    status,
    tilt_deg: tiltDeg,
    forward_lean: forwardLean,
    slouching,
    close_to_monitor: closeToMonitor,
  };
}

const REFRESH_INTERVAL_MS = 1000;
const CAMERA_UPLOAD_INTERVAL_MS = 250;
const CAMERA_JPEG_QUALITY = 0.7;
const POSTURE_UI_MIN_MS = 100;
const POSTURE_POST_MIN_MS = 450;
const MEDIAPIPE_POSE_VER = "0.5.1675469404";

/** Shape compatible with GET /api/posture/latest for the panel. */
function postureRowFromPayload(payload, source) {
  const st = payload.status;
  const person = st !== "NO PERSON";
  const too = st === "YOU ARE TOO SLOUCHED";
  return {
    ok: true,
    has_data: true,
    status: st,
    tilt_deg: payload.tilt_deg,
    forward_lean: payload.forward_lean,
    slouching: payload.slouching,
    close_to_monitor: payload.close_to_monitor,
    too_slouched: too,
    person_detected: person,
    slouch_threshold_deg: payload.slouch_threshold_deg,
    close_to_monitor_threshold: payload.close_to_monitor_threshold,
    source,
    updated_at: new Date().toISOString(),
  };
}

function normalizeBase(url) {
  return String(url).replace(/\/$/, "");
}

function getApiBaseCandidates() {
  const explicit = import.meta.env?.VITE_API_BASE_URL;

  if (explicit) {
    return [normalizeBase(explicit)];
  }

  const hostname = window.location.hostname || "localhost";
  return [
    `http://${hostname}:3000`,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const noCacheUrl = `${url}${separator}_t=${Date.now()}`;
  const response = await fetch(noCacheUrl, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

function formatDate(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString();
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "-";
}

function formatConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(1)}%`;
}

/** Matches backend.js GET /api/lighting/latest (camera + optional ml). */
function lightingBrightnessLine(light) {
  if (!light) return "-";
  const cam = light.brightness_0_100;
  if (light.source === "camera" && cam != null && Number.isFinite(Number(cam))) {
    return `${Math.round(Number(cam))} / 100 (camera)`;
  }
  const mlRgb = light.ml?.brightness_score;
  if (mlRgb != null && Number.isFinite(Number(mlRgb))) {
    return `${Number(mlRgb).toFixed(3)} (ML mean RGB)`;
  }
  const mlB = light.ml?.brightness_0_100;
  if (mlB != null && Number.isFinite(Number(mlB))) {
    return `${Math.round(Number(mlB))} / 100 (ML)`;
  }
  return "-";
}

function lightingLux(light) {
  if (!light) return "-";
  if (light.lux_estimate != null && Number.isFinite(Number(light.lux_estimate))) {
    return String(Math.round(Number(light.lux_estimate)));
  }
  if (light.ml?.lux_estimate != null && Number.isFinite(Number(light.ml.lux_estimate))) {
    return String(Math.round(Number(light.ml.lux_estimate)));
  }
  return "-";
}

function lightingMeanLuminance(light) {
  const v = light?.mean_luminance_0_255;
  if (v == null || !Number.isFinite(Number(v))) return "-";
  return formatNumber(v);
}

function lightingDisplayTimestamp(light) {
  if (!light) return null;
  return light.updated_at || light.ml?.updated_at || null;
}

/** Same row pattern as Lighting Detection, for GET /api/posture/latest (camera_detection.py). */
function postureLabel(p) {
  if (!p?.has_data) return "—";
  return p.status ?? "—";
}

function postureConfidenceLine(p) {
  if (!p?.has_data || !p.person_detected) return "—";
  const th = Number(p.slouch_threshold_deg);
  const tilt = Number(p.tilt_deg);
  if (!Number.isFinite(th) || th <= 0 || !Number.isFinite(tilt)) return "—";
  const upright = Math.max(0, Math.min(1, 1 - tilt / (2 * th)));
  return formatConfidence(upright);
}

function postureTiltScoreLine(p) {
  if (!p?.has_data) return "—";
  return `${formatNumber(p.tilt_deg)}° (slouch if > ${formatNumber(p.slouch_threshold_deg)}°)`;
}

function postureForwardLeanLine(p) {
  if (!p?.has_data) return "—";
  const fl = p.forward_lean;
  const th = p.close_to_monitor_threshold;
  if (!Number.isFinite(Number(fl))) return "—";
  const base = Number(fl).toFixed(3);
  if (th != null && Number.isFinite(Number(th))) {
    return `${base} (threshold ${Number(th).toFixed(2)})`;
  }
  return base;
}

function postureDetailLine(p) {
  if (!p?.has_data) return "—";
  const s = p.slouching ? "yes" : "no";
  const c = p.close_to_monitor ? "yes" : "no";
  const person = p.person_detected ? "yes" : "no";
  return `Slouching: ${s} · Too close: ${c} · Person: ${person}`;
}

function postureSourceLine(p) {
  if (!p?.has_data) return "none";
  return p.source ?? "pi_mediapipe";
}

function postureDisplayTimestamp(p) {
  if (!p?.has_data) return null;
  return p.updated_at ?? null;
}

function normalizeCameraPayload(data) {
  if (!data?.ok) return null;
  const ts = data.updated_at ?? data.timestamp ?? null;
  return { ...data, timestamp: ts };
}

function DevelopmentPage() {
  const apiBaseCandidates = useMemo(() => getApiBaseCandidates(), []);
  const [apiBase, setApiBase] = useState(apiBaseCandidates[0]);
  const wsBase = useMemo(() => {
    const explicit = import.meta.env?.VITE_WS_BASE_URL;
    if (explicit) return String(explicit);
    return `ws://${window.location.host}/ws`;
  }, [apiBase]);

  const [metrics, setMetrics] = useState(null);
  const [seatStatus, setSeatStatus] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [latestSensor, setLatestSensor] = useState(null);
  const [latestDht, setLatestDht] = useState(null);
  const [latestCamera, setLatestCamera] = useState(null);
  const [latestLighting, setLatestLighting] = useState(null);
  const [postureLatest, setPostureLatest] = useState(null);
  const [postureApiError, setPostureApiError] = useState(null);
  const [postureLiveError, setPostureLiveError] = useState("");
  const [qualityReport, setQualityReport] = useState(null);
  const [cameraError, setCameraError] = useState("");
  const [isCameraRunning, setIsCameraRunning] = useState(false);
  const [cameraFramesSent, setCameraFramesSent] = useState(0);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [clockTick, setClockTick] = useState(Date.now());
  const [showAllTools, setShowAllTools] = useState(false);

  const baseContinuousSeatedSeconds = Number(seatStatus?.continuous_seated_seconds ?? 0);
  const secondsSinceLastUpdate = lastUpdated
    ? Math.max(0, Math.floor((clockTick - lastUpdated.getTime()) / 1000))
    : 0;
  const continuousSeatedCounterSeconds =
    seatStatus?.status === "seated"
      ? baseContinuousSeatedSeconds + secondsSinceLastUpdate
      : 0;
  const continuousSeatedCounterMinutes = Math.floor(continuousSeatedCounterSeconds / 60);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const uploadTimerRef = useRef(null);
  const uploadInFlightRef = useRef(false);
  const isCameraRunningRef = useRef(false);
  const poseInstanceRef = useRef(null);
  const poseRafRef = useRef(0);
  const poseResultsRef = useRef(null);
  const posturePostInFlightRef = useRef(false);
  const lastPosturePostMsRef = useRef(0);
  const lastPostureUiMsRef = useRef(0);
  const lastPostureStatusRef = useRef("");

  useEffect(() => {
    isCameraRunningRef.current = isCameraRunning;
  }, [isCameraRunning]);

  const loadFromBase = useCallback(async (base) => {
    const [metricsData, seatData, calibrationData, sensorData, dhtData] = await Promise.all([
      fetchJson(`${base}/api/metrics`),
      fetchJson(`${base}/api/seat-status`),
      fetchJson(`${base}/api/calibration-status`),
      fetchJson(`${base}/api/sensor-readings/latest`),
      fetchJson(`${base}/api/dht22/latest`),
    ]);

    let cameraData = null;
    try {
      cameraData = await fetchJson(`${base}/api/camera/latest`);
    } catch (cameraError) {
      if (cameraError?.message && !String(cameraError.message).includes("404")) {
        throw cameraError;
      }
    }

    let qualityData = null;
    try {
      qualityData = await fetchJson(`${base}/api/data-quality`);
    } catch {
      // Keep the dashboard usable even if quality endpoint is unavailable.
    }

    let lightingData = null;
    try {
      lightingData = await fetchJson(`${base}/api/lighting/latest`);
    } catch {
      // Keep the dashboard usable even if lighting endpoint is unavailable.
    }

    let postureData = null;
    let postureFetchError = null;
    try {
      postureData = await fetchJson(`${base}/api/posture/latest`);
    } catch (postureErr) {
      postureFetchError = postureErr?.message || String(postureErr);
    }

    return {
      metricsData,
      seatData,
      calibrationData,
      sensorData,
      dhtData,
      cameraData,
      qualityData,
      lightingData,
      postureData,
      postureFetchError
    };
  }, []);

  const refreshData = useCallback(async () => {
    const basesToTry = [apiBase, ...apiBaseCandidates.filter((base) => base !== apiBase)];

    for (const base of basesToTry) {
      try {
        const {
          metricsData,
          seatData,
          calibrationData,
          sensorData,
          dhtData,
          cameraData,
          qualityData,
          lightingData,
          postureData,
          postureFetchError,
        } = await loadFromBase(base);

        setMetrics(metricsData);
        setSeatStatus(seatData);
        setCalibration(calibrationData);
        setLatestSensor(sensorData?.latest || null);
        setLatestDht(dhtData?.latest || null);
        setLatestCamera(normalizeCameraPayload(cameraData));
        setLatestLighting(lightingData || null);
        if (!isCameraRunningRef.current) {
          setPostureLatest(postureData ?? null);
        }
        setPostureApiError(postureFetchError ?? null);
        setQualityReport(qualityData);
        setLastUpdated(new Date());
        setError("");

        if (base !== apiBase) {
          setApiBase(base);
        }
        return;
      } catch {
        // Try next candidate base URL.
      }
    }

    setError(`NetworkError: backend unreachable. Tried ${basesToTry.join(", ")}`);
  }, [apiBase, apiBaseCandidates, loadFromBase]);

  useEffect(() => {
    refreshData();
    const timer = setInterval(refreshData, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshData]);

  useEffect(() => {
    const tickTimer = setInterval(() => setClockTick(Date.now()), 1000);
    return () => clearInterval(tickTimer);
  }, []);

  const stopCameraStream = useCallback(() => {
    if (uploadTimerRef.current) {
      clearInterval(uploadTimerRef.current);
      uploadTimerRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    uploadInFlightRef.current = false;
    setIsCameraRunning(false);
  }, []);

  const uploadCameraFrame = useCallback(async () => {
    if (uploadInFlightRef.current) {
      return;
    }

    const videoEl = videoRef.current;
    const canvasEl = canvasRef.current;
    if (!videoEl || !canvasEl || videoEl.readyState < 2) {
      return;
    }

    const width = videoEl.videoWidth || 640;
    const height = videoEl.videoHeight || 360;
    canvasEl.width = width;
    canvasEl.height = height;

    const ctx = canvasEl.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.drawImage(videoEl, 0, 0, width, height);
    const frameDataUrl = canvasEl.toDataURL("image/jpeg", CAMERA_JPEG_QUALITY);

    uploadInFlightRef.current = true;
    try {
      const response = await fetch(`${apiBase}/api/camera-frame`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          frame: frameDataUrl,
          width,
          height,
          source: "development-page",
        }),
      });

      if (!response.ok) {
        throw new Error(`Upload failed (${response.status})`);
      }

      const payload = await response.json();
      if (payload?.ok) {
        setLatestCamera(normalizeCameraPayload({ ...payload, has_frame: true, image_base64: null }));
        setLatestLighting((prev) => ({
          ...(typeof prev === "object" && prev !== null ? prev : { ok: true }),
          source: "camera",
          brightness_0_100: payload.brightness_0_100 ?? null,
          lux_estimate: payload.lux_estimate ?? null,
          mean_luminance_0_255: payload.mean_luminance_0_255 ?? null,
          updated_at: payload.updated_at ?? null,
        }));
      }
      setCameraFramesSent((prev) => prev + 1);
      setCameraError("");
    } catch (streamError) {
      setCameraError(streamError?.message || "Failed to upload camera frame");
    } finally {
      uploadInFlightRef.current = false;
    }
  }, [apiBase]);

  const startCameraStream = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "Camera access is not available in this browser or context."
      );
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          facingMode: "user",
        },
        audio: false,
      });

      mediaStreamRef.current = mediaStream;

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }

      setCameraError("");
      setIsCameraRunning(true);

      if (uploadTimerRef.current) {
        clearInterval(uploadTimerRef.current);
      }
      uploadTimerRef.current = setInterval(uploadCameraFrame, CAMERA_UPLOAD_INTERVAL_MS);
    } catch (streamError) {
      setCameraError(streamError?.message || "Unable to start camera stream");
      stopCameraStream();
    }
  }, [stopCameraStream, uploadCameraFrame]);

  useEffect(() => () => stopCameraStream(), [stopCameraStream]);

  useEffect(() => {
    if (!isCameraRunning) {
      setPostureLiveError("");
      return undefined;
    }

    let cancelled = false;
    setPostureLiveError("");
    lastPostureUiMsRef.current = 0;
    lastPosturePostMsRef.current = 0;
    lastPostureStatusRef.current = "";

    (async () => {
      try {
        // Load from CDN so `npm install` on the Pi does not require @mediapipe/pose in node_modules.
        const mod = await import(
          /* @vite-ignore */
          `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${MEDIAPIPE_POSE_VER}/+esm`
        );
        const ns = mod?.default ?? mod;
        const PoseCtor =
          (typeof ns?.Pose === "function" && ns.Pose) ||
          (typeof mod?.Pose === "function" && mod.Pose) ||
          (typeof globalThis.Pose === "function" && globalThis.Pose) ||
          null;
        if (typeof PoseCtor !== "function") {
          throw new Error("MediaPipe Pose nu s-a încărcat din CDN (verifică rețeaua / firewall).");
        }
        if (cancelled) return;
        const pose = new PoseCtor({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${MEDIAPIPE_POSE_VER}/${file}`,
        });
        pose.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        pose.onResults((results) => {
          poseResultsRef.current = results;
        });
        await pose.initialize();
        if (cancelled) {
          pose.close();
          return;
        }
        poseInstanceRef.current = pose;

        const tick = async () => {
          if (cancelled) return;
          const vEl = videoRef.current;
          if (!vEl || vEl.readyState < 2) {
            poseRafRef.current = requestAnimationFrame(() => void tick());
            return;
          }
          try {
            await pose.send({ image: vEl });
          } catch {
            /* ignore single-frame errors */
          }

          const results = poseResultsRef.current;
          const payload = posturePayloadFromLandmarks(results?.poseLandmarks);

          const now = Date.now();
          if (
            now - lastPostureUiMsRef.current >= POSTURE_UI_MIN_MS ||
            payload.status !== lastPostureStatusRef.current
          ) {
            lastPostureUiMsRef.current = now;
            lastPostureStatusRef.current = payload.status;
            setPostureLatest(postureRowFromPayload(payload, "browser_camera"));
          }

          if (
            now - lastPosturePostMsRef.current >= POSTURE_POST_MIN_MS &&
            !posturePostInFlightRef.current
          ) {
            lastPosturePostMsRef.current = now;
            posturePostInFlightRef.current = true;
            const body = { ...payload, source: "browser_camera" };
            fetch(`${apiBase}/api/posture/latest`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
              .catch(() => {})
              .finally(() => {
                posturePostInFlightRef.current = false;
              });
          }

          poseRafRef.current = requestAnimationFrame(() => void tick());
        };

        poseRafRef.current = requestAnimationFrame(() => void tick());
      } catch (e) {
        if (!cancelled) {
          setPostureLiveError(e?.message || String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (poseRafRef.current) {
        cancelAnimationFrame(poseRafRef.current);
        poseRafRef.current = 0;
      }
      const p = poseInstanceRef.current;
      poseInstanceRef.current = null;
      poseResultsRef.current = null;
      lastPostureStatusRef.current = "";
      if (p) {
        try {
          p.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [isCameraRunning, apiBase]);

  useEffect(() => {
    let socket;
    let reconnectTimer;

    const connect = () => {
      socket = new WebSocket(wsBase);

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.type === "sensor-reading") {
            refreshData();
          }
        } catch {
          // Ignore non-JSON websocket messages.
        }
      };

      socket.onclose = () => {
        reconnectTimer = setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [refreshData, wsBase]);

  return (
    <div style={styles.page}>
      <HomePage wsUrl={wsBase} />

      <aside style={styles.panel}>
        <div style={styles.headerRow}>
          <h2 style={styles.title}>Development</h2>
          <div style={styles.headerActions}>
            <button style={styles.refreshButton} onClick={refreshData} type="button">
              Refresh
            </button>
            <button
              type="button"
              style={showAllTools ? styles.toggleToolsButtonActive : styles.toggleToolsButton}
              onClick={() => setShowAllTools((v) => !v)}
            >
              {showAllTools ? "Ascunde instrumentele" : "Toate instrumentele"}
            </button>
          </div>
        </div>

        {showAllTools ? (
          <>
            <div style={styles.subtitle}>Backend: {apiBase}</div>
            <div style={styles.subtitle}>WebSocket: {wsBase}</div>
          </>
        ) : (
          <div style={styles.metaCompact} title={`${apiBase}\n${wsBase}`}>
            API · {apiBase.replace(/^https?:\/\//, "")}
          </div>
        )}
        <div style={styles.meta}>Last update: {lastUpdated ? lastUpdated.toLocaleTimeString() : "-"}</div>

        {error ? <div style={styles.error}>Error: {error}</div> : null}

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Rezumat</h3>
          <div style={styles.line}>
            <strong>Șezut:</strong> {seatStatus?.status || "—"} · {seatStatus?.recommendation || "—"}
          </div>
          <div style={styles.line}>
            Continue at desk: ~{continuousSeatedCounterMinutes} min · fatigue:{" "}
            {metrics?.fatigue_risk != null ? formatNumber(metrics.fatigue_risk) : "—"}
          </div>
          <div style={styles.line}>
            <strong>Air:</strong>{" "}
            {metrics?.air_ventilation?.open_window_recommended
              ? "merită aerisire"
              : "fără nevoie urgentă"}{" "}
            · confort ~{formatNumber(metrics?.air_ventilation?.indoor_confort_0_100)}/100
          </div>
          <div style={styles.line}>
            <strong>Postură:</strong> {postureLabel(postureLatest)}
          </div>
          <div style={styles.line}>
            Calibrated: {seatStatus?.calibrated ? "da" : "nu"} · BMP/DHT:{" "}
            {latestSensor?.pressure != null ? "citiri" : "—"} /{" "}
            {latestDht?.temperature != null ? "DHT ok" : "fără DHT"}
          </div>
          {postureApiError ? (
            <div style={{ ...styles.line, color: "#fecaca", marginTop: 6 }}>
              API Posture: {postureApiError}
            </div>
          ) : null}
        </section>

        {showAllTools ? (
          <>
        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Seat Status</h3>
          <div style={styles.line}>Status: {seatStatus?.status || "-"}</div>
          <div style={styles.line}>Recommendation: {seatStatus?.recommendation || "-"}</div>
          <div style={styles.line}>Continuous seated: {continuousSeatedCounterSeconds} sec ({continuousSeatedCounterMinutes} min)</div>
          <div style={styles.line}>Total seated: {seatStatus?.total_seated_seconds ?? "-"} sec ({seatStatus?.total_seated_minutes ?? "-"} min)</div>
          <div style={styles.line}>Current pressure: {formatNumber(seatStatus?.current_pressure)}</div>
          <div style={styles.line}>Baseline pressure: {formatNumber(seatStatus?.baseline_pressure)}</div>
          <div style={styles.line}>Threshold pressure: {formatNumber(seatStatus?.threshold_pressure)}</div>
          <div style={styles.line}>Calibrated: {seatStatus?.calibrated ? "yes" : "no"}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Calibration</h3>
          <div style={styles.line}>
            Samples: {calibration?.sample_count ?? 0}/{calibration?.required_samples ?? 0}
          </div>
          <div style={styles.line}>Baseline: {formatNumber(calibration?.baseline_pressure)}</div>
          <div style={styles.line}>Threshold: {formatNumber(calibration?.threshold_pressure)}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Metrics</h3>
          <div style={styles.line}>Pressure level: {formatNumber(metrics?.pressure_level)}</div>
          <div style={styles.line}>Temperature level: {formatNumber(metrics?.temperature_level)}</div>
          <div style={styles.line}>
            Room brightness (0–100):{" "}
            {latestLighting?.brightness_0_100 != null &&
            Number.isFinite(Number(latestLighting.brightness_0_100))
              ? Math.round(Number(latestLighting.brightness_0_100))
              : "-"}
          </div>
          <div style={styles.line}>Total sitting minutes: {metrics?.total_sitting_minutes ?? "-"}</div>
          <div style={styles.line}>Seated minutes counter: {continuousSeatedCounterMinutes}</div>
          <div style={styles.line}>Fatigue risk: {formatNumber(metrics?.fatigue_risk)}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Ventilation (DHT22 + presiune BMP)</h3>
          <div style={styles.line}>
            <strong>Window:</strong> {metrics?.air_ventilation?.open_window_recommended ? "deschide / aerisește" : "nu e necesar acum"}
          </div>
          <div style={styles.line}>{metrics?.air_ventilation?.recommendation_ro ?? "—"}</div>
          <div style={styles.line}>
            Ventilation need: (0–100): {formatNumber(metrics?.air_ventilation?.ventilation_need_0_100)} · Confort
            estimat (0–100): {formatNumber(metrics?.air_ventilation?.indoor_confort_0_100)}
          </div>
          <div style={styles.line}>
            DHT: {metrics?.air_ventilation?.temperature_c ?? "—"} °C, umiditate{" "}
            {metrics?.air_ventilation?.humidity_pct ?? "—"}%
          </div>
          <div style={styles.line}>
            Presiune ultimă (Pa): {formatNumber(metrics?.air_ventilation?.pressure_last_pa)} · Trend (Pa/h):{" "}
            {metrics?.air_ventilation?.pressure_trend_pa_per_hour != null &&
            Number.isFinite(Number(metrics.air_ventilation.pressure_trend_pa_per_hour))
              ? formatNumber(metrics.air_ventilation.pressure_trend_pa_per_hour)
              : "—"}
          </div>
          <div style={styles.lineMuted}>
            Score: high humidity / heat rises; cold lowers; pressure trend (90 min) has small weight.
          </div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Lighting Detection</h3>
          <div style={styles.line}>Label: {latestLighting?.ml?.label ?? "—"}</div>
          <div style={styles.line}>Confidence: {formatConfidence(latestLighting?.ml?.confidence)}</div>
          <div style={styles.line}>Brightness score: {lightingBrightnessLine(latestLighting)}</div>
          <div style={styles.line}>Lux (est.): {lightingLux(latestLighting)}</div>
          <div style={styles.line}>Mean luminance (0–255): {lightingMeanLuminance(latestLighting)}</div>
          <div style={styles.line}>Source: {latestLighting?.source ?? "—"}</div>
          <div style={styles.line}>Timestamp: {formatDate(lightingDisplayTimestamp(latestLighting))}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Posture Detection</h3>
          {postureApiError ? (
            <div style={styles.error}>
              Cannot reach <code style={styles.codeInline}>/api/posture/latest</code>: {postureApiError}. Deploy latest{" "}
              <code style={styles.codeInline}>backend.js</code> on the Pi and restart Node.
            </div>
          ) : null}
          {!postureLatest?.has_data && !postureApiError ? (
            <div style={styles.lineMuted}>
              <strong>Live:</strong> open <strong>Camera Stream</strong> below, press <strong>Start Camera</strong>
              — MediaPipe runs in the browser and updates this card (source <code style={styles.codeInline}>
                browser_camera
              </code>
              ). Optional on the Pi:{" "}
              <code style={styles.codeInline}>
                python backend/camera_detection.py --engine opencv --backend-url {apiBase}
              </code>
              .
            </div>
          ) : null}
          {postureLiveError ? <div style={styles.error}>Live pose: {postureLiveError}</div> : null}
          {isCameraRunning && !postureLiveError ? (
            <div style={styles.lineMuted}>Live pose from webcam → backend (max ~{Math.round(1000 / POSTURE_POST_MIN_MS)} POST/s).</div>
          ) : null}
          <div style={styles.line}>
            Label:{" "}
            <span
              style={
                postureLatest?.too_slouched
                  ? styles.postureBad
                  : postureLatest?.status === "GOOD POSTURE"
                    ? styles.postureGood
                    : undefined
              }
            >
              {postureLabel(postureLatest)}
            </span>
          </div>
          <div style={styles.line}>Confidence: {postureConfidenceLine(postureLatest)}</div>
          <div style={styles.line}>Tilt score: {postureTiltScoreLine(postureLatest)}</div>
          <div style={styles.line}>Forward lean: {postureForwardLeanLine(postureLatest)}</div>
          <div style={styles.line}>Slouch / lean / person: {postureDetailLine(postureLatest)}</div>
          <div style={styles.line}>Source: {postureSourceLine(postureLatest)}</div>
          <div style={styles.line}>Timestamp: {formatDate(postureDisplayTimestamp(postureLatest))}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Latest Sensor Payload</h3>
          <div style={styles.line}>Pressure: {formatNumber(latestSensor?.pressure)}</div>
          <div style={styles.line}>Temperature: {formatNumber(latestSensor?.temperature)}</div>
          <div style={styles.line}>Seat occupied: {latestSensor?.seat_occupied ? "yes" : "no"}</div>
          <div style={styles.line}>Timestamp: {formatDate(latestSensor?.timestamp)}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Latest DHT22</h3>
          <div style={styles.line}>Temperature: {formatNumber(latestDht?.temperature)}</div>
          <div style={styles.line}>Humidity: {formatNumber(latestDht?.humidity)}</div>
          <div style={styles.line}>Timestamp: {formatDate(latestDht?.timestamp)}</div>
        </section>

        <section style={styles.card}>
          <h3 style={styles.cardTitle}>Camera Stream To Raspberry Pi</h3>
          <div style={styles.line}>Frame ingest endpoint: {apiBase}/api/camera-frame</div>
          <div style={styles.line}>Python stream URL: {apiBase}/video</div>
          <div style={styles.line}>Frames sent: {cameraFramesSent}</div>
          <div style={styles.line}>Latest frame at: {formatDate(latestCamera?.timestamp)}</div>

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.refreshButton}
              onClick={startCameraStream}
              disabled={isCameraRunning}
            >
              Start Camera
            </button>
            <button
              type="button"
              style={styles.refreshButton}
              onClick={stopCameraStream}
              disabled={!isCameraRunning}
            >
              Stop Camera
            </button>
          </div>

          {cameraError ? <div style={styles.error}>Camera: {cameraError}</div> : null}

          <video ref={videoRef} style={styles.preview} muted playsInline />
          <canvas ref={canvasRef} style={styles.canvasHidden} />
        </section>
          </>
        ) : null}
      </aside>
    </div>
  );
}

const styles = {
  page: {
    position: "relative",
  },
  panel: {
    position: "fixed",
    top: 12,
    right: 12,
    width: "min(380px, 90vw)",
    maxHeight: "calc(100vh - 24px)",
    overflowY: "auto",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.35)",
    background: "rgba(2, 6, 23, 0.9)",
    backdropFilter: "blur(6px)",
    color: "#e2e8f0",
    padding: 12,
    boxSizing: "border-box",
    zIndex: 1000,
    fontFamily: "Arial, sans-serif",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
    gap: 8,
    flexWrap: "wrap",
  },
  headerActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "flex-end",
  },
  toggleToolsButton: {
    border: "1px solid #a78bfa",
    borderRadius: 8,
    background: "rgba(139, 92, 246, 0.15)",
    color: "#ddd6fe",
    fontWeight: 700,
    fontSize: 11,
    padding: "5px 9px",
    cursor: "pointer",
  },
  toggleToolsButtonActive: {
    border: "1px solid #c4b5fd",
    borderRadius: 8,
    background: "rgba(139, 92, 246, 0.35)",
    color: "#f5f3ff",
    fontWeight: 700,
    fontSize: 11,
    padding: "5px 9px",
    cursor: "pointer",
  },
  metaCompact: {
    fontSize: 11,
    color: "#94a3b8",
    marginBottom: 6,
    wordBreak: "break-all",
  },
  title: {
    margin: 0,
    fontSize: 18,
    color: "#f8fafc",
  },
  subtitle: {
    fontSize: 12,
    color: "#93c5fd",
    marginBottom: 2,
    wordBreak: "break-all",
  },
  meta: {
    fontSize: 11,
    color: "#94a3b8",
    marginBottom: 10,
  },
  refreshButton: {
    border: "1px solid #38bdf8",
    borderRadius: 8,
    background: "transparent",
    color: "#7dd3fc",
    fontWeight: 700,
    fontSize: 12,
    padding: "5px 9px",
    cursor: "pointer",
  },
  error: {
    color: "#fecaca",
    border: "1px solid rgba(248,113,113,0.5)",
    background: "rgba(127,29,29,0.3)",
    borderRadius: 8,
    padding: "6px 8px",
    marginBottom: 10,
    fontSize: 12,
  },
  card: {
    border: "1px solid rgba(148,163,184,0.3)",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    background: "rgba(15, 23, 42, 0.72)",
  },
  cardTitle: {
    margin: "0 0 8px",
    fontSize: 14,
    color: "#bfdbfe",
  },
  line: {
    fontSize: 12,
    lineHeight: 1.45,
    color: "#e2e8f0",
  },
  lineMuted: {
    fontSize: 11,
    lineHeight: 1.45,
    color: "#94a3b8",
    marginBottom: 8,
  },
  codeInline: {
    fontSize: 10,
    wordBreak: "break-all",
    color: "#cbd5e1",
  },
  postureGood: {
    color: "#86efac",
    fontWeight: 700,
  },
  postureBad: {
    color: "#fca5a5",
    fontWeight: 700,
  },
  buttonRow: {
    display: "flex",
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
  },
  preview: {
    width: "100%",
    height: "auto",
    borderRadius: 10,
    border: "1px solid rgba(148,163,184,0.35)",
    background: "#020617",
    marginTop: 6,
  },
  canvasHidden: {
    display: "none",
  },
};

export default DevelopmentPage;
