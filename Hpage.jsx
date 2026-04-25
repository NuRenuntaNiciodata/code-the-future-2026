import React, { useEffect, useMemo, useRef, useState } from "react";

/** Web-only dashboard: same UI as HomePage; WebSocket defaults to current host :8080 or VITE_WS_URL. */
function browserWebSocketUrl() {
  const fromEnv = import.meta.env?.VITE_WS_URL;
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined" && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    const wsScheme = protocol === "https:" ? "wss" : "ws";
    return `${wsScheme}://${hostname}:8080`;
  }
  return "ws://10.48.238.33:8080";
}

/** HTTP API (backend.js): same host as VITE_WS_URL if set, else VITE_BACKEND_ORIGIN or host + VITE_BACKEND_PORT (default 3000). */
function browserBackendOrigin() {
  const explicit = import.meta.env?.VITE_BACKEND_ORIGIN;
  if (explicit) return String(explicit).replace(/\/$/, "");
  const ws = import.meta.env?.VITE_WS_URL;
  if (ws && /^wss?:\/\//i.test(String(ws))) {
    try {
      const u = new URL(String(ws));
      const httpScheme = u.protocol === "wss:" ? "https:" : "http:";
      return `${httpScheme}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined" && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    const httpScheme = protocol === "https:" ? "https" : "http";
    const port = import.meta.env?.VITE_BACKEND_PORT || "3000";
    return `${httpScheme}://${hostname}:${port}`;
  }
  return "http://10.48.238.33:3000";
}

function formatSittingMinutes(totalMinutes) {
  if (totalMinutes == null || !Number.isFinite(Number(totalMinutes))) return "—";
  const n = Math.round(Number(totalMinutes));
  if (n <= 0) return "0m";
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getAirQualityLabel(humidity) {
  if (humidity == null) return { label: "Unknown", color: "#6b7280" };
  if (humidity >= 40 && humidity <= 60) return { label: "Good", color: "#16a34a" };
  if ((humidity >= 30 && humidity < 40) || (humidity > 60 && humidity <= 70)) {
    return { label: "Moderate", color: "#f59e0b" };
  }
  return { label: "Poor", color: "#dc2626" };
}

function Hpage({ wsUrl } = {}) {
  const socketUrl = wsUrl ?? browserWebSocketUrl();
  const apiBase = useMemo(() => browserBackendOrigin(), []);

  const [sensorData, setSensorData] = useState({
    humidity: null,
    pressure: 0,
    timestamp: null,
  });

  const [connectionStatus, setConnectionStatus] = useState("Connecting...");
  const [now, setNow] = useState(Date.now());
  const [lastLeftSeatAt, setLastLeftSeatAt] = useState(null);

  const prevOccupiedRef = useRef(null);

  const [backend, setBackend] = useState({
    loading: true,
    error: null,
    metrics: null,
    dataQuality: null,
    posture: null,
    fetchedAt: null,
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [mRes, dqRes, pRes] = await Promise.all([
          fetch(`${apiBase}/api/metrics`),
          fetch(`${apiBase}/api/data-quality`),
          fetch(`${apiBase}/api/posture/latest`),
        ]);
        const metrics = await mRes.json();
        const dataQuality = await dqRes.json();
        const posture = await pRes.json();
        if (cancelled) return;
        setBackend({
          loading: false,
          error: null,
          metrics,
          dataQuality,
          posture,
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (cancelled) return;
        setBackend((prev) => ({
          ...prev,
          loading: false,
          error: err?.message || String(err),
        }));
      }
    };

    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiBase]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const ws = new window.WebSocket(socketUrl);

    ws.onopen = () => {
      setConnectionStatus("Live");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        const humidity =
          typeof data.humidity === "number" ? data.humidity : null;

        const pressure =
          typeof data.pressure === "number"
            ? data.pressure
            : typeof data.pressure === "boolean"
            ? Number(data.pressure)
            : 0;

        const timestamp = data.timestamp || new Date().toISOString();

        const occupied = pressure === 1;
        const previousOccupied = prevOccupiedRef.current;

        if (previousOccupied === true && occupied === false) {
          setLastLeftSeatAt(Date.now());
        }

        prevOccupiedRef.current = occupied;
        setSensorData({ humidity, pressure, timestamp });
        setConnectionStatus("Live");
      } catch {
        setConnectionStatus("Invalid data");
      }
    };

    ws.onerror = () => {
      setConnectionStatus("Connection error");
    };

    ws.onclose = () => {
      setConnectionStatus("Disconnected");
    };

    return () => ws.close();
  }, [socketUrl]);

  const isOccupied = sensorData.pressure === 1;

  const timeSinceLastLeft = useMemo(() => {
    if (!lastLeftSeatAt) return "Not detected yet";
    return formatDuration(now - lastLeftSeatAt);
  }, [lastLeftSeatAt, now]);

  const airQuality = useMemo(() => {
    return getAirQualityLabel(sensorData.humidity);
  }, [sensorData.humidity]);

  const air = backend.metrics?.air_ventilation;
  const comfortScore =
    air != null && Number.isFinite(Number(air.indoor_confort_0_100))
      ? Number(air.indoor_confort_0_100)
      : null;
  const ventilationNeed =
    air != null && Number.isFinite(Number(air.ventilation_need_0_100))
      ? Number(air.ventilation_need_0_100)
      : null;
  const totalSittingMin = backend.metrics?.total_sitting_minutes;
  const fatigueRisk = backend.metrics?.fatigue_risk;
  const posture = backend.posture;
  const dq = backend.dataQuality;

  return (
    <div style={styles.page}>
      <div style={styles.appShell}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.title}>Desk Air Monitor</div>
            <div style={styles.subtitle}>
              Real-time workspace monitoring dashboard
            </div>
          </div>

          <div
            style={{
              ...styles.liveBadge,
              backgroundColor:
                connectionStatus === "Live" ? "#dcfce7" : "#fee2e2",
              color: connectionStatus === "Live" ? "#166534" : "#991b1b",
            }}
          >
            {connectionStatus}
          </div>
        </div>

        <div style={styles.mainGrid}>
          <div style={styles.leftColumn}>
            <div style={styles.heroCard}>
              <div style={styles.imageBox}>
                <img
                  src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80"
                  alt="Workspace"
                  style={styles.image}
                />
                <div style={styles.imageOverlay}>
                  {isOccupied ? "User seated" : "User away"}
                </div>
              </div>
            </div>

            <div style={styles.statusCard}>
              <div style={styles.label}>Air quality</div>
              <div style={{ ...styles.bigStatus, color: airQuality.color }}>
                {airQuality.label}
              </div>
              <div style={styles.helperText}>
                Temporary estimate based on humidity until a dedicated air-quality
                sensor is added.
              </div>
            </div>
          </div>

          <div style={styles.rightColumn}>
            <div style={styles.grid}>
              <div style={styles.metricCard}>
                <div style={styles.label}>Humidity</div>
                <div style={styles.metricValue}>
                  {sensorData.humidity != null ? `${sensorData.humidity}%` : "--"}
                </div>
              </div>

              <div style={styles.metricCard}>
                <div style={styles.label}>Pressure</div>
                <div style={styles.metricValue}>
                  {sensorData.pressure != null ? sensorData.pressure : "--"}
                </div>
              </div>

              <div style={styles.metricCard}>
                <div style={styles.label}>Seat status</div>
                <div
                  style={{
                    ...styles.metricValue,
                    color: isOccupied ? "#2563eb" : "#ea580c",
                  }}
                >
                  {isOccupied ? "Occupied" : "Away"}
                </div>
              </div>

              <div style={styles.metricCard}>
                <div style={styles.label}>Last left seat</div>
                <div style={styles.metricValueSmall}>{timeSinceLastLeft}</div>
              </div>
            </div>

            <div style={styles.infoCard}>
              <div style={styles.infoTitle}>Session status</div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Connection</span>
                <span style={styles.infoText}>{connectionStatus}</span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Last update</span>
                <span style={styles.infoText}>
                  {sensorData.timestamp
                    ? new Date(sensorData.timestamp).toLocaleTimeString()
                    : "--"}
                </span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Monitoring mode</span>
                <span style={styles.infoText}>Live WebSocket</span>
              </div>
            </div>
          </div>
        </div>

        <div style={styles.backendSection}>
          <div style={styles.infoTitle}>
            Indici calitate &amp; bunăstare (backend.js — HTTP)
          </div>
          <div style={styles.backendMeta}>
            <span style={styles.helperMuted}>API: {apiBase}</span>
            {backend.fetchedAt && (
              <span style={styles.helperMuted}>
                {" "}
                · actualizat {new Date(backend.fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {backend.error && (
            <div style={styles.backendError}>
              Nu pot citi API-ul: {backend.error}
            </div>
          )}

          <div style={styles.backendGrid}>
            <div style={styles.backendCard}>
              <div style={styles.backendCardTitle}>Calitate date (estimateDataQuality)</div>
              {backend.loading && !backend.dataQuality ? (
                <div style={styles.helperMuted}>Se încarcă…</div>
              ) : (
                <>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>Scor</span>
                    <span style={styles.infoText}>
                      {dq?.score != null ? `${dq.score}/100` : "—"}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>Etichetă</span>
                    <span style={styles.infoText}>{dq?.label ?? "—"}</span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>BMP280 / DHT22</span>
                    <span style={styles.infoText}>
                      {dq?.has_bmp280 ? "da" : "nu"} / {dq?.has_dht22 ? "da" : "nu"}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>Calibrare gata</span>
                    <span style={styles.infoText}>
                      {dq?.calibration_ready ? "da" : "nu"}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>Cadru cameră</span>
                    <span style={styles.infoText}>
                      {dq?.has_camera_frame ? "da" : "nu"}
                    </span>
                  </div>
                </>
              )}
            </div>

            <div style={styles.backendCard}>
              <div style={styles.backendCardTitle}>Aer &amp; confort (getMetrics → air_ventilation)</div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>comfort_score (indoor_confort_0_100)</span>
                <span style={styles.infoText}>
                  {comfortScore != null ? `${comfortScore}` : "—"}
                </span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>air_quality — nevoie ventilație (0–100)</span>
                <span style={styles.infoText}>
                  {ventilationNeed != null ? `${ventilationNeed}` : "—"}
                </span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Temp / umid. (DHT)</span>
                <span style={styles.infoText}>
                  {air?.temperature_c != null ? `${air.temperature_c}°C` : "—"} /{" "}
                  {air?.humidity_pct != null ? `${air.humidity_pct}%` : "—"}
                </span>
              </div>
              <div style={styles.backendNote}>
                {air?.recommendation_ro || "—"}
              </div>
            </div>

            <div style={styles.backendCard}>
              <div style={styles.backendCardTitle}>Șezut &amp; oboseală (getMetrics)</div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>total_sitting_time (minute)</span>
                <span style={styles.infoText}>
                  {formatSittingMinutes(totalSittingMin)} ({totalSittingMin ?? "—"} min)
                </span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>fatigue_risk (0–1)</span>
                <span style={styles.infoText}>
                  {fatigueRisk != null ? Number(fatigueRisk).toFixed(2) : "—"}
                </span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>fatigue (data-quality)</span>
                <span style={styles.infoText}>
                  {dq?.fatigue_risk != null ? Number(dq.fatigue_risk).toFixed(2) : "—"}
                </span>
              </div>
            </div>

            <div style={styles.backendCard}>
              <div style={styles.backendCardTitle}>
                slouch_position (GET /api/posture/latest)
              </div>
              {backend.loading && posture == null ? (
                <div style={styles.helperMuted}>Se încarcă…</div>
              ) : !posture?.has_data ? (
                <div style={styles.helperMuted}>Fără date postură încă.</div>
              ) : (
                <>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>status</span>
                    <span style={styles.infoText}>{posture?.status ?? "—"}</span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>tilt_deg</span>
                    <span style={styles.infoText}>
                      {posture?.tilt_deg != null ? posture.tilt_deg : "—"}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>too_slouched</span>
                    <span style={styles.infoText}>
                      {posture?.too_slouched == null
                        ? "—"
                        : posture.too_slouched
                        ? "da"
                        : "nu"}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>actualizat</span>
                    <span style={styles.infoText}>
                      {posture?.updated_at
                        ? new Date(posture.updated_at).toLocaleString()
                        : "—"}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    width: "100%",
    background: "linear-gradient(135deg, #eef2ff 0%, #f8fafc 45%, #ecfeff 100%)",
    fontFamily: "Arial, sans-serif",
  },
  appShell: {
    minHeight: "100vh",
    boxSizing: "border-box",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    background: "rgba(255,255,255,0.9)",
    borderRadius: "20px",
    padding: "20px 24px",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
    border: "1px solid rgba(255,255,255,0.7)",
  },
  title: {
    fontSize: "2rem",
    fontWeight: 800,
    color: "#0f172a",
  },
  subtitle: {
    fontSize: "1rem",
    color: "#64748b",
    marginTop: "6px",
  },
  liveBadge: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontSize: "0.82rem",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  mainGrid: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr",
    gap: "20px",
    flex: 1,
  },
  leftColumn: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  rightColumn: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  heroCard: {
    background: "rgba(255,255,255,0.9)",
    borderRadius: "24px",
    padding: "18px",
    boxShadow: "0 20px 50px rgba(15, 23, 42, 0.12)",
    border: "1px solid rgba(255,255,255,0.7)",
  },
  imageBox: {
    position: "relative",
    borderRadius: "18px",
    overflow: "hidden",
    minHeight: "360px",
    height: "100%",
  },
  image: {
    width: "100%",
    height: "100%",
    minHeight: "360px",
    objectFit: "cover",
    display: "block",
  },
  imageOverlay: {
    position: "absolute",
    left: "16px",
    bottom: "16px",
    background: "rgba(15, 23, 42, 0.75)",
    color: "white",
    padding: "10px 14px",
    borderRadius: "999px",
    fontSize: "0.9rem",
    fontWeight: 600,
  },
  statusCard: {
    background: "rgba(255,255,255,0.9)",
    borderRadius: "20px",
    padding: "20px",
    border: "1px solid #e2e8f0",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
  },
  label: {
    fontSize: "0.85rem",
    color: "#64748b",
    marginBottom: "8px",
  },
  bigStatus: {
    fontSize: "2rem",
    fontWeight: 800,
    lineHeight: 1.1,
  },
  helperText: {
    marginTop: "8px",
    fontSize: "0.82rem",
    color: "#94a3b8",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "16px",
  },
  metricCard: {
    background: "rgba(255,255,255,0.92)",
    borderRadius: "18px",
    padding: "18px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.06)",
    minHeight: "110px",
  },
  metricValue: {
    fontSize: "1.4rem",
    fontWeight: 800,
    color: "#111827",
  },
  metricValueSmall: {
    fontSize: "1.1rem",
    fontWeight: 800,
    color: "#111827",
  },
  infoCard: {
    background: "rgba(255,255,255,0.9)",
    borderRadius: "20px",
    padding: "20px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
  },
  infoTitle: {
    fontSize: "1.05rem",
    fontWeight: 700,
    color: "#0f172a",
    marginBottom: "14px",
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 0",
    borderBottom: "1px solid #eef2f7",
  },
  infoLabel: {
    color: "#64748b",
    fontSize: "0.92rem",
  },
  infoText: {
    color: "#111827",
    fontSize: "0.92rem",
    fontWeight: 600,
    textAlign: "right",
  },
  backendSection: {
    background: "rgba(255,255,255,0.92)",
    borderRadius: "20px",
    padding: "20px 22px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
  },
  backendMeta: {
    marginBottom: "12px",
  },
  helperMuted: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  backendError: {
    color: "#b91c1c",
    fontSize: "0.9rem",
    marginBottom: "12px",
    fontWeight: 600,
  },
  backendGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: "16px",
  },
  backendCard: {
    background: "rgba(248,250,252,0.95)",
    borderRadius: "14px",
    padding: "14px 16px",
    border: "1px solid #e2e8f0",
  },
  backendCardTitle: {
    fontSize: "0.88rem",
    fontWeight: 700,
    color: "#334155",
    marginBottom: "10px",
  },
  backendNote: {
    marginTop: "10px",
    fontSize: "0.82rem",
    color: "#475569",
    lineHeight: 1.45,
  },
};

export default Hpage;
