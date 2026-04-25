import React from "react";

function LandingPage() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Work Twin</h1>

        <p style={styles.text}>
          Install the desktop app to monitor posture, humidity, and fatigue risk
          in real time.
        </p>

        <a style={styles.button} href="/downloads/Work-Twin.exe" download>
          Download app
        </a>

        <p style={styles.note}>
          After installing, open Work Twin from your desktop or Start Menu.
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: {
    width: "100vw",
    height: "100vh",
    margin: 0,
    background: "linear-gradient(135deg, #020617, #0f172a)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "Arial, sans-serif",
  },
  card: {
    width: "min(520px, 90vw)",
    padding: "32px",
    borderRadius: "24px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.16)",
    textAlign: "center",
    color: "white",
  },
  title: {
    fontSize: "2.2rem",
    marginBottom: "12px",
  },
  text: {
    color: "#cbd5e1",
    fontSize: "1rem",
    lineHeight: 1.5,
    marginBottom: "24px",
  },
  button: {
    display: "inline-block",
    padding: "12px 20px",
    borderRadius: "999px",
    background: "#38bdf8",
    color: "#020617",
    fontWeight: 800,
    textDecoration: "none",
  },
  note: {
    marginTop: "18px",
    fontSize: "0.85rem",
    color: "#94a3b8",
  },
};

export default LandingPage;