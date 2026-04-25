import React, { useEffect, useState } from "react";
import HomePage from "./HomePage";
import Hpage from "./Hpage";
import DevelopmentPage from "./DevelopmentPage";

/** http(s): pathname; file: (Electron dist) hash e.g. `#/hpage`, `#/development`. */
function readRoutePath() {
  if (typeof window === "undefined") return "/";
  if (window.location.protocol === "file:") {
    const raw = window.location.hash.replace(/^#/, "").trim();
    if (!raw || raw === "/") return "/";
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
  const p = window.location.pathname || "/";
  return p.startsWith("/") ? p : `/${p}`;
}

function App() {
  const [path, setPath] = useState(readRoutePath);

  useEffect(() => {
    const sync = () => setPath(readRoutePath());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  if (path === "/hpage") {
    return <Hpage />;
  }
  if (path === "/development" || path === "/dev") {
    return <DevelopmentPage />;
  }
  return <HomePage />;
}

export default App;
