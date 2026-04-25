import React, { useEffect, useMemo, useRef, useState } from "react";
import BreakAlert from "./BreakAlert";

import sitting from "./images/Sitting_down.png";
import rising from "./images/Rising.png";
import standing from "./images/Standing.png";

const isElectron = navigator.userAgent.toLowerCase().includes("electron");
const API_BASE = isElectron
  ? "http://10.86.222.33:3000"
  : `http://${window.location.hostname}:3000`;

const STATE_CONFIRM_TIME_MS = 3 * 1000;
const FRAME_TIME_MS = 1 * 1000;

const BAD_POSTURE_TIME_MS = 5 * 1000;
const OK_GRACE_TIME_MS = 3 * 1000;
const SKIP_IGNORE_TIME_MS = 15 * 1000; //!!to be changed to 60 

function getFatigueRisk(secondsSinceBreak) {
  if (secondsSinceBreak < 30) return { label: "Low", value: 25, color: "#22c55e" };
  if (secondsSinceBreak < 60) return { label: "Medium", value: 60, color: "#f59e0b" };
  return { label: "High", value: 100, color: "#ef4444" };
}

function HomePage() {
  const [rawIsSitting, setRawIsSitting] = useState(false);
  const [confirmedState, setConfirmedState] = useState("standing");
  const [animationImage, setAnimationImage] = useState(standing);
  const [isAnimating, setIsAnimating] = useState(false);

  const confirmTimerRef = useRef(null);
  const pendingStateRef = useRef(null);
  const animationTimersRef = useRef([]);

  const [sensorData, setSensorData] = useState({
    humidity: null,
    pressure: 0,
    timestamp: null,
  });

  const [connectionStatus, setConnectionStatus] = useState("Connecting...");
  const [lastZeroAt, setLastZeroAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

  const [cameraPostureStatus, setCameraPostureStatus] = useState("UNKNOWN");
  const [badPostureStartedAt, setBadPostureStartedAt] = useState(null);
  const [showPostureAlert, setShowPostureAlert] = useState(false);
  const [skipCount, setSkipCount] = useState(0);
  const [ignoreBadPostureUntil, setIgnoreBadPostureUntil] = useState(null);
  const [okPressedAt, setOkPressedAt] = useState(null);

  const [showBreakAlert, setShowBreakAlert] = useState(false);
  const [ignoreBreakAlertUntil, setIgnoreBreakAlertUntil] = useState(null);

  const isSlouching = cameraPostureStatus === "YOU ARE TOO SLOUCHED";
  const isSitting = confirmedState === "sitting";

  function clearAnimationTimers() {
    animationTimersRef.current.forEach(clearTimeout);
    animationTimersRef.current = [];
  }

  function runStateAnimation(fromState, toState) {
    clearAnimationTimers();
    setIsAnimating(true);

    if (fromState === "sitting" && toState === "standing") {
      setAnimationImage(sitting);

      animationTimersRef.current.push(
        setTimeout(() => {
          setAnimationImage(rising);
        }, FRAME_TIME_MS)
      );

      animationTimersRef.current.push(
        setTimeout(() => {
          setAnimationImage(standing);
          setConfirmedState("standing");
          setIsAnimating(false);
        }, FRAME_TIME_MS * 2)
      );

      return;
    }

    if (fromState === "standing" && toState === "sitting") {
      setAnimationImage(standing);

      animationTimersRef.current.push(
        setTimeout(() => {
          setAnimationImage(rising);
        }, FRAME_TIME_MS)
      );

      animationTimersRef.current.push(
        setTimeout(() => {
          setAnimationImage(sitting);
          setConfirmedState("sitting");
          setIsAnimating(false);
        }, FRAME_TIME_MS * 2)
      );

      return;
    }

    setConfirmedState(toState);
    setAnimationImage(toState === "sitting" ? sitting : standing);
    setIsAnimating(false);
  }

  useEffect(() => {
    window.electronAPI?.onCameraPostureUpdate?.((data) => {
      setCameraPostureStatus(data.posture_status || "UNKNOWN");
    });
  }, []);

  useEffect(() => {
    const targetState = rawIsSitting ? "sitting" : "standing";

    if (targetState === confirmedState) {
      pendingStateRef.current = null;
      clearTimeout(confirmTimerRef.current);
      return;
    }

    if (pendingStateRef.current === targetState) {
      return;
    }

    pendingStateRef.current = targetState;
    clearTimeout(confirmTimerRef.current);

    confirmTimerRef.current = setTimeout(() => {
      runStateAnimation(confirmedState, targetState);
      pendingStateRef.current = null;
    }, STATE_CONFIRM_TIME_MS);

    return () => clearTimeout(confirmTimerRef.current);
  }, [rawIsSitting, confirmedState]);

  useEffect(() => {
    return () => {
      clearTimeout(confirmTimerRef.current);
      clearAnimationTimers();
    };
  }, []);

  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let firstRead = true;

    async function readSeatStatus() {
      try {
        const res = await fetch(`${API_BASE}/api/seat-status`);
        const data = await res.json();

        console.log("Seat status API:", data);

        const isSeated =
          data.status === "seated" ||
          data.seat_occupied === true ||
          data.seat_occupied === 1;

        setRawIsSitting(isSeated);
        setConnectionStatus("API Live");

        if (firstRead) {
          const initialState = isSeated ? "sitting" : "standing";

          setConfirmedState(initialState);
          setAnimationImage(isSeated ? sitting : standing);

          firstRead = false;
          return;
        }

        if (!isSeated) {
          setLastZeroAt(Date.now());
        }

        setSensorData({
          humidity: null,
          pressure: data.current_pressure ?? 0,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("API error:", err);
        setConnectionStatus("API error");
      }
    }

    readSeatStatus();

    const interval = setInterval(readSeatStatus, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // IPC listener for Electron
    window.electronAPI?.onCameraPostureUpdate?.((data) => {
      setCameraPostureStatus(data.posture_status || "UNKNOWN");
    });

    // Fallback: poll the backend directly
    async function pollPosture() {
      try {
        const res = await fetch(`${API_BASE}/api/posture/latest`);
        const data = await res.json();
        if (data?.has_data && data?.status) {
          setCameraPostureStatus(data.status);
        }
      } catch (err) {
        // silently ignore
      }
    }

    pollPosture();
    const interval = setInterval(pollPosture, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const isIgnored = ignoreBadPostureUntil && now < ignoreBadPostureUntil;

    if (!isSlouching) {
      setBadPostureStartedAt(null);
      setShowPostureAlert(false);
      setOkPressedAt(null);
      return;
    }

    if (isIgnored) return;

    if (!badPostureStartedAt) {
      setBadPostureStartedAt(now);
      return;
    }

    const slouchingDuration = now - badPostureStartedAt;

    if (
      slouchingDuration >= BAD_POSTURE_TIME_MS &&
      !showPostureAlert &&
      !okPressedAt
    ) {
      setShowPostureAlert(true);
      window.electronAPI?.bringAlertToFront?.();
    }

    if (okPressedAt && now - okPressedAt >= OK_GRACE_TIME_MS) {
      setShowPostureAlert(true);
      setOkPressedAt(null);
      window.electronAPI?.bringAlertToFront?.();
    }
  }, [
    isSlouching,
    now,
    badPostureStartedAt,
    showPostureAlert,
    ignoreBadPostureUntil,
    okPressedAt,
  ]);

  const imageSrc = isAnimating
    ? animationImage
    : confirmedState === "sitting"
    ? sitting
    : standing;

  const secondsSinceBreak = useMemo(() => {
    if (!isSitting) return 0;
    return Math.floor((now - lastZeroAt) / 1000);
  }, [isSitting, now, lastZeroAt]);

  useEffect(() => {
    const isIgnored = ignoreBreakAlertUntil && now < ignoreBreakAlertUntil;
    if (!isSitting || secondsSinceBreak < 15 || showBreakAlert || isIgnored) return; //!!!60
    setShowBreakAlert(true);
    window.electronAPI?.bringAlertToFront?.();
  }, [isSitting, secondsSinceBreak, showBreakAlert, ignoreBreakAlertUntil, now]);

  const fatigueRisk = getFatigueRisk(secondsSinceBreak);

  function handleSkipAlert() {
    setSkipCount((prev) => prev + 1);
    setShowPostureAlert(false);
    setIgnoreBadPostureUntil(Date.now() + SKIP_IGNORE_TIME_MS);
    setBadPostureStartedAt(null);
    setOkPressedAt(null);
  }

  function handleOkAlert() {
    setShowPostureAlert(false);
    setOkPressedAt(Date.now());
  }

  function handleBreakOk() {
    setShowBreakAlert(false);
    setLastZeroAt(Date.now());
  }

  function handleBreakSkip() {
    setSkipCount((prev) => prev + 1);
    setShowBreakAlert(false);
    setIgnoreBreakAlertUntil(Date.now() + SKIP_IGNORE_TIME_MS);
  }

  return (
    <div style={styles.page}>
      <div style={styles.mainLayout}>
        <div style={styles.imageArea}>
          <img src={imageSrc} alt="Posture status" style={styles.image} />
        </div>

        <div style={styles.sidePanel}>
          <div style={styles.breakCard}>
            <div style={styles.breakTitle}>Time since last break</div>
            <div style={styles.breakValue}>{secondsSinceBreak} sec</div>
          </div>

          <div style={styles.statusGrid}>
            <StatusBar
              label="Posture"
              value={100}
              text={isSlouching ? "Slouching" : "Good"}
              color={isSlouching ? "#ef4444" : "#22c55e"}
            />

            <StatusBar
              label="Fatigue risk"
              value={fatigueRisk.value}
              text={fatigueRisk.label}
              color={fatigueRisk.color}
            />
          </div>

          <div style={styles.footer}>
            {connectionStatus} | Raw sitting: {String(rawIsSitting)} | Confirmed:{" "}
            {confirmedState} | Image:{" "}
            {imageSrc === sitting ? "sitting" : imageSrc === rising ? "rising" : "standing"} | Camera:{" "}
            {cameraPostureStatus} | Skips: {skipCount}
          </div>
        </div>
      </div>

      {showPostureAlert && (
        <div style={styles.alertOverlay}>
          <div style={{
            width: "320px",
            background: "#f0f0f0",
            border: "1px solid #999",
            boxShadow: "4px 4px 10px rgba(0,0,0,0.4)",
            fontFamily: "Segoe UI, Tahoma, sans-serif",
            fontSize: "12px",
            color: "#000",
          }}>
            <div style={{
              background: "linear-gradient(to right, #0078d7, #0050a0)",
              padding: "6px 10px",
              display: "flex",
              alignItems: "center",
            }}>
              <span style={{ color: "#fff", fontWeight: 600, fontSize: "12px" }}>
                Work Twin
              </span>
            </div>

            <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                <span style={{ fontSize: "32px", lineHeight: 1, flexShrink: 0 }}>🪑</span>
                <span style={{ fontSize: "12px", lineHeight: 1.5, paddingTop: "4px" }}>
                  Bad posture has been detected. Please sit up straight.
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button style={{
                  padding: "4px 20px", fontSize: "12px", background: "#e1e1e1",
                  border: "1px solid #adadad", borderRadius: "3px", cursor: "pointer",
                  fontFamily: "Segoe UI, Tahoma, sans-serif", color: "#000",
                }} onClick={handleOkAlert}>OK</button>

                <button style={{
                  padding: "4px 20px", fontSize: "12px", background: "#e1e1e1",
                  border: "1px solid #adadad", borderRadius: "3px", cursor: "pointer",
                  fontFamily: "Segoe UI, Tahoma, sans-serif", color: "#000",
                }} onClick={handleSkipAlert}>Skip</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBreakAlert && (
        <BreakAlert
          onOk={handleBreakOk}
          onSkip={handleBreakSkip}
          skipCount={skipCount}
        />
      )}
    </div>
  );
}

function StatusBar({ label, value, text, color }) {
  return (
    <div style={styles.barWrapper}>
      <div style={styles.barHeader}>
        <span style={styles.barLabel}>{label}</span>
        <span style={{ ...styles.barText, color }}>{text}</span>
      </div>

      <div style={styles.barTrack}>
        <div
          style={{
            ...styles.barFill,
            width: `${value}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

const styles = {
  page: {
    width: "100vw",
    height: "100vh",
    margin: 0,
    padding: 0,
    background: "#0b0d0f",
    overflow: "hidden",
    fontFamily: "Arial, sans-serif",
  },

  mainLayout: {
    width: "100%",
    height: "100%",
    display: "grid",
    gridTemplateColumns: "1fr 140px",
    gap: "8px",
    boxSizing: "border-box",
    padding: "8px",
  },

  imageArea: {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    borderRadius: "12px",
    background: "#07111f",
  },

  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },

  sidePanel: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },

  breakCard: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: "12px",
    padding: "10px",
    textAlign: "center",
  },

  breakTitle: {
    color: "#dbeafe",
    fontSize: "11px",
    fontWeight: 700,
    marginBottom: "6px",
  },

  breakValue: {
    color: "#ffffff",
    fontSize: "22px",
    fontWeight: 900,
  },

  statusGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "6px",
  },

  barWrapper: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: "10px",
    padding: "7px",
    boxSizing: "border-box",
    minWidth: 0,
  },

  barHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    marginBottom: "5px",
  },

  barLabel: {
    color: "#dbeafe",
    fontSize: "10px",
    fontWeight: 600,
  },

  barText: {
    fontSize: "11px",
    fontWeight: 800,
    whiteSpace: "nowrap",
  },

  barTrack: {
    width: "100%",
    height: "7px",
    background: "rgba(255,255,255,0.14)",
    borderRadius: "999px",
    overflow: "hidden",
  },

  barFill: {
    height: "100%",
    borderRadius: "999px",
    transition: "width 250ms ease, background-color 250ms ease",
  },

  footer: {
    marginTop: "auto",
    color: "#94a3b8",
    fontSize: "10px",
    textAlign: "center",
  },

  alertOverlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },

  alertBox: {
    width: "85%",
    padding: "18px",
    borderRadius: "18px",
    background: "rgba(15, 23, 42, 0.96)",
    border: "2px solid #ef4444",
    boxShadow: "0 20px 50px rgba(239, 68, 68, 0.35)",
    textAlign: "center",
  },

  alertTitle: {
    color: "#ef4444",
    fontSize: "24px",
    fontWeight: 900,
    marginBottom: "8px",
  },

  alertText: {
    color: "#f8fafc",
    fontSize: "13px",
    lineHeight: 1.4,
    marginBottom: "16px",
  },

  alertButtons: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "10px",
  },

  okButton: {
    border: "none",
    borderRadius: "999px",
    padding: "10px",
    background: "#22c55e",
    color: "#04130a",
    fontWeight: 800,
    cursor: "pointer",
  },

  skipButton: {
    border: "none",
    borderRadius: "999px",
    padding: "10px",
    background: "#ef4444",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
  },

  skipCounter: {
    marginTop: "12px",
    color: "#94a3b8",
    fontSize: "12px",
  },
};

export default HomePage;