"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SceneFallback } from "./SceneFallback";

// Lazy: three.js only downloads after first paint, and only where WebGL is usable.
const InterrogationRoom = dynamic(() => import("./InterrogationRoom"), {
  ssr: false,
  loading: () => <SceneFallback quiet />,
});

type Capability = "checking" | "webgl" | "fallback";

function detect(): Capability {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "fallback";
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lowEnd =
      (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 2) ||
      (nav.deviceMemory !== undefined && nav.deviceMemory <= 2);
    if (lowEnd) return "fallback";
    if (localStorage.getItem("nab.3d") === "off") return "fallback";
    return "webgl";
  } catch {
    return "fallback";
  }
}

/** The one persistent scene behind every page. Falls back to a 2D table when 3D isn't viable. */
export function Stage() {
  const [cap, setCap] = useState<Capability>("checking");
  const [crashed, setCrashed] = useState(false);

  useEffect(() => {
    // Capability can only be known in the browser; this runs once after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCap(detect());
    const onToggle = () => setCap(detect());
    window.addEventListener("nab:3d-toggle", onToggle);
    return () => window.removeEventListener("nab:3d-toggle", onToggle);
  }, []);

  return (
    <div className="fixed inset-0 z-0" aria-hidden="true">
      {cap === "webgl" && !crashed ? (
        <InterrogationRoom onContextLost={() => setCrashed(true)} />
      ) : (
        <SceneFallback quiet={cap === "checking"} />
      )}
      {/* Vignette keeps UI text readable over the scene. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,transparent_30%,rgba(13,11,9,0.85)_100%)]" />
    </div>
  );
}
