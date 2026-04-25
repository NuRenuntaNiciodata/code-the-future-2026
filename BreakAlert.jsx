import React from "react";

function BreakAlert({ onOk, onSkip, skipCount }) {
  return (
    <div style={styles.overlay}>
      <div style={styles.dialog}>
        <div style={styles.titleBar}>
          <span style={styles.titleText}>Work Twin</span>
        </div>

        <div style={styles.body}>
          <div style={styles.iconAndText}>
            <span style={styles.icon}>⏱</span>
            <span style={styles.message}>
              You have been sitting for over a minute. Time to take a break.
            </span>
          </div>

          <div style={styles.buttons}>
            <button style={styles.button} onClick={onOk}>
              OK
            </button>
            <button style={styles.button} onClick={onSkip}>
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },

  dialog: {
    width: "320px",
    background: "#f0f0f0",
    border: "1px solid #999",
    boxShadow: "4px 4px 10px rgba(0,0,0,0.4)",
    fontFamily: "Segoe UI, Tahoma, sans-serif",
    fontSize: "12px",
    color: "#000",
  },

  titleBar: {
    background: "linear-gradient(to right, #0078d7, #0050a0)",
    padding: "6px 10px",
    display: "flex",
    alignItems: "center",
  },

  titleText: {
    color: "#fff",
    fontWeight: 600,
    fontSize: "12px",
  },

  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },

  iconAndText: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  },

  icon: {
    fontSize: "32px",
    lineHeight: 1,
    flexShrink: 0,
  },

  message: {
    fontSize: "12px",
    lineHeight: 1.5,
    paddingTop: "4px",
  },

  buttons: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
  },

  button: {
    padding: "4px 20px",
    fontSize: "12px",
    background: "#e1e1e1",
    border: "1px solid #adadad",
    borderRadius: "3px",
    cursor: "pointer",
    fontFamily: "Segoe UI, Tahoma, sans-serif",
    color: "#000",
  },
};

export default BreakAlert;