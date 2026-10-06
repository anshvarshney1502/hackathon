"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { SEAT_COUNT, sceneStore, useSceneState } from "@/lib/client/sceneStore";

const TABLE_R = 1.25;
const SEAT_R = 1.75;
const LAMP_PIVOT_Y = 4.2;
const LAMP_LEN = 1.55;

const COLORS = {
  floor: new THREE.Color("#0a0806"),
  wall: new THREE.Color("#120f0b"),
  table: new THREE.Color("#2a2219"),
  chair: new THREE.Color("#17130f"),
  bust: new THREE.Color("#2b251e"),
  amber: new THREE.Color("#f2a33a"),
  warm: new THREE.Color("#ffcf8a"),
  paper: new THREE.Color("#ede5d5"),
};

function seatAngle(i: number) {
  return Math.PI / 6 + (i * Math.PI) / 3;
}
function seatPos(i: number, r = SEAT_R): THREE.Vector3 {
  const a = seatAngle(i);
  return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
}

/** This module only ever loads in the browser (dynamic import, ssr: false). */
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One material pair per seat, owned at module scope: they are mutated every frame
 * in useFrame, which is exactly what three.js materials are for.
 */
const SEAT_MATERIALS = Array.from({ length: SEAT_COUNT }, () => ({
  solid: new THREE.MeshStandardMaterial({
    color: COLORS.bust,
    roughness: 0.75,
    emissive: COLORS.amber,
    emissiveIntensity: 0,
    transparent: true,
  }),
  wire: new THREE.MeshBasicMaterial({ color: COLORS.paper, wireframe: true, transparent: true, opacity: 0 }),
}));

/** Deterministic speckle so the tag texture is a pure function of its inputs. */
function speckle(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Which reveal step is active, and how far into it (0..1). */
function revealProgress(now: number) {
  const r = sceneStore.get().reveal;
  if (!r || now < r.startAt) return null;
  const idx = Math.floor((now - r.startAt) / r.stepMs);
  const t = ((now - r.startAt) % r.stepMs) / r.stepMs;
  return { idx, t, steps: r.steps, done: idx >= r.steps.length };
}

/* ------------------------------------------------------------------ camera */

function CameraRig() {
  const { camera, size } = useThree();
  const look = useRef(new THREE.Vector3(0, 0.9, 0));
  const reduced = REDUCED_MOTION;
  const home = useMemo(() => new THREE.Vector3(0, 4.1, 6.3), []);

  useFrame((_, dt) => {
    const s = sceneStore.get();
    const cam = camera as THREE.PerspectiveCamera;
    // Keep the table centred in the part of the screen the UI doesn't cover.
    const w = size.width;
    const h = size.height;
    cam.setViewOffset(w, h, (s.insetRight - s.insetLeft) / 2, s.insetBottom / 2, w, h);

    const targetPos = home.clone();
    const targetLook = new THREE.Vector3(0, 0.9, 0);
    if (s.mode === "landing") targetPos.set(0, 3.6, 7.2);
    // Portrait screens: pull back so all six seats stay in frame.
    const aspect = w / Math.max(1, h - s.insetBottom);
    if (aspect < 1.2) targetPos.multiplyScalar(Math.min(1.9, 1.2 / Math.max(0.45, aspect)));
    const now = Date.now();
    if (s.mode === "room") {
      // The camera plays along: tighter during the defense, wide for the verdicts,
      // drawn toward whoever is on the spot, and nudged toward whoever just spoke.
      if (s.phase === "DEFENSE") targetPos.multiplyScalar(0.82).setY(targetPos.y * 0.82);
      if (s.phase === "VOTE") targetPos.multiplyScalar(1.08);
      if (s.focusSeat !== null) {
        const f = seatPos(s.focusSeat, SEAT_R);
        targetLook.lerp(new THREE.Vector3(f.x, 1.2, f.z), 0.45);
        targetPos.lerp(new THREE.Vector3(-f.x * 0.9, 2.9, -f.z * 0.9 + 1.5), 0.35);
      } else if (s.pulse && now - s.pulse.at < 2500) {
        const sp = seatPos(s.pulse.seat, SEAT_R);
        targetLook.lerp(new THREE.Vector3(sp.x, 1.1, sp.z), 0.15);
      }
    }
    const rp = revealProgress(now);
    if (rp && !rp.done) {
      const seat = rp.steps[rp.idx].seat;
      const p = seatPos(seat, SEAT_R);
      targetLook.set(p.x, 1.25, p.z);
      // Move across the table and face the suspect from slightly above, like the interrogator.
      targetPos.set(-p.x * 0.55, 2.15, -p.z * 0.55);
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 1.8);
    cam.position.lerp(targetPos, k);
    look.current.lerp(targetLook, k);
    cam.lookAt(look.current);
  });
  return null;
}

/* ------------------------------------------------------------------ lamp */

function Lamp() {
  const pivot = useRef<THREE.Group>(null);
  const spot = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const reduced = REDUCED_MOTION;
  const tilt = useRef({ x: 0, z: 0 });

  useEffect(() => {
    if (spot.current) spot.current.target = target;
  }, [target]);

  useFrame((state, dt) => {
    if (!pivot.current) return;
    const t = state.clock.elapsedTime;
    let tx = reduced ? 0 : Math.sin(t * 0.7) * 0.035;
    let tz = reduced ? 0 : Math.cos(t * 0.53) * 0.03;
    let intensity = 38;
    const rp = revealProgress(Date.now());
    const focus = rp && !rp.done ? rp.steps[rp.idx].seat : sceneStore.get().focusSeat;
    if (focus !== null && focus !== undefined) {
      const p = seatPos(focus, SEAT_R);
      // The reveal swings hard toward the suspect; a hot seat only leans.
      const lean = rp && !rp.done ? 0.55 : 0.28;
      tz = Math.asin(Math.min(0.95, (p.x * lean) / LAMP_LEN));
      tx = -Math.asin(Math.min(0.95, (p.z * lean) / LAMP_LEN));
      intensity = rp && !rp.done ? 55 : 48;
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    tilt.current.x += (tx - tilt.current.x) * k;
    tilt.current.z += (tz - tilt.current.z) * k;
    pivot.current.rotation.set(tilt.current.x, 0, tilt.current.z);
    if (spot.current) spot.current.intensity += (intensity - spot.current.intensity) * k;
  });

  return (
    <group ref={pivot} position={[0, LAMP_PIVOT_Y, 0]}>
      {/* cord */}
      <mesh position={[0, -LAMP_LEN / 2, 0]}>
        <cylinderGeometry args={[0.008, 0.008, LAMP_LEN, 4]} />
        <meshBasicMaterial color="#050403" />
      </mesh>
      <group position={[0, -LAMP_LEN, 0]}>
        {/* shade */}
        <mesh>
          <coneGeometry args={[0.42, 0.34, 18, 1, true]} />
          <meshStandardMaterial color="#1c1813" side={THREE.DoubleSide} roughness={0.6} metalness={0.4} />
        </mesh>
        {/* bulb */}
        <mesh position={[0, -0.12, 0]}>
          <sphereGeometry args={[0.09, 12, 8]} />
          <meshBasicMaterial color={COLORS.warm} />
        </mesh>
        <spotLight
          ref={spot}
          position={[0, -0.1, 0]}
          angle={0.78}
          penumbra={0.75}
          intensity={38}
          decay={1.4}
          distance={9}
          color="#ffc27a"
        />
        <primitive object={target} position={[0, -3, 0]} />
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ name tag */

function useTagTexture(name: string, index: number) {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 96;
    const g = c.getContext("2d");
    if (g) {
      const family = getComputedStyle(document.body).fontFamily;
      g.fillStyle = "#e6dcc7";
      g.fillRect(0, 0, 256, 96);
      g.fillStyle = "rgba(60,40,20,0.12)";
      for (let i = 0; i < 40; i++) g.fillRect(speckle(i, index) * 256, speckle(i, index + 7) * 96, 2, 1);
      g.fillStyle = "#6b5f4c";
      g.font = `500 14px ${family}`;
      g.fillText(`SUBJECT 0${index + 1}`, 14, 24);
      g.fillStyle = "#16120d";
      g.font = `700 34px ${family}`;
      g.fillText(name.toUpperCase().slice(0, 12), 14, 70);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }, [name, index]);
}

function NameTag({ name, index }: { name: string; index: number }) {
  const tex = useTagTexture(name, index);
  useEffect(() => () => tex.dispose(), [tex]);
  const p = seatPos(index, TABLE_R - 0.32);
  const a = seatAngle(index);
  return (
    <mesh position={[p.x, 0.8, p.z]} rotation={[-Math.PI / 2, 0, a + Math.PI]}>
      <planeGeometry args={[0.46, 0.17]} />
      <meshStandardMaterial map={tex} roughness={0.9} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ seat + bust */

function Seat({ index }: { index: number }) {
  const scene = useSceneState();
  const seat = scene.seats[index];
  const group = useRef<THREE.Group>(null);
  const bust = useRef<THREE.Group>(null);
  const scale = useRef(0);
  const head = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);

  const p = seatPos(index);
  const facing = seatAngle(index) + Math.PI;

  useFrame((_, dt) => {
    const { solid, wire } = SEAT_MATERIALS[index];
    const reduced = REDUCED_MOTION;
    const s = sceneStore.get();
    const current = s.seats[index];
    const now = Date.now();
    const k = 1 - Math.exp(-dt * 6);

    scale.current += ((current ? 1 : 0) - scale.current) * (reduced ? 1 : k);
    if (bust.current) bust.current.scale.setScalar(Math.max(0.0001, scale.current));

    let emissive = 0;
    let emissiveColor = COLORS.amber;
    let solidOpacity = current?.signalLost ? 0.35 : 1;
    let wireOpacity = 0;
    let jitter = 0;

    if (current?.typing) emissive = 0.08 + (reduced ? 0 : Math.abs(Math.sin(now / 140)) * 0.07);
    if (s.pulse && s.pulse.seat === index) {
      const age = (now - s.pulse.at) / 1400;
      if (age < 1) emissive = Math.max(emissive, 0.38 * (1 - age) ** 2);
    }

    const rp = revealProgress(now);
    if (rp) {
      const myStep = rp.steps.findIndex((st) => st.seat === index);
      if (myStep !== -1 && (rp.idx > myStep || (rp.idx === myStep && rp.t > 0.42))) {
        const sinceVerdict = rp.idx > myStep ? 1 : (rp.t - 0.42) / 0.58;
        if (rp.steps[myStep].isBot) {
          // Glitch, then dissolve into wireframe.
          const g = Math.min(1, sinceVerdict * 1.8);
          jitter = reduced || g >= 1 ? 0 : (1 - g) * 0.05;
          solidOpacity = Math.max(0, 1 - g) * (reduced ? 0 : Math.random() > 0.3 ? 1 : 0.2);
          wireOpacity = 0.75 * g;
          emissive = 0;
        } else {
          // Warm light fills the human.
          emissiveColor = COLORS.warm;
          emissive = rp.idx === myStep ? 0.15 + 0.3 * Math.min(1, sinceVerdict * 2) : 0.18;
        }
      } else if (myStep === rp.idx && !rp.done) {
        emissive = Math.max(emissive, 0.12 * rp.t);
      }
    }

    solid.emissive.copy(emissiveColor);
    solid.emissiveIntensity += (emissive - solid.emissiveIntensity) * (reduced ? 1 : Math.min(1, k * 1.5));
    solid.opacity = solidOpacity;
    solid.depthWrite = solidOpacity > 0.9;
    wire.opacity = wireOpacity;
    if (group.current) {
      group.current.position.set(p.x + (Math.random() - 0.5) * jitter, 0, p.z + (Math.random() - 0.5) * jitter);
    }

    // Body language (no React state, all per-frame): breathing, look at the last speaker, dip while typing.
    const t = now / 1000;
    // Per-seat mannerisms keyed by the round alias (same rule for humans and bots, so no tell),
    // and different every case because aliases are re-rolled.
    let hsh = 7;
    for (const ch of current?.name ?? "") hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const fidget = 0.6 + (hsh % 100) / 100; // 0.6..1.6
    const sway = 0.06 + ((hsh >> 7) % 100) / 600; // 0.06..0.23
    if (bust.current && !reduced) bust.current.position.y = 0.48 + Math.sin(t * 1.3 * fidget + index) * 0.006 * fidget;
    if (head.current) {
      let yaw = reduced ? 0 : Math.sin(t * 0.4 * fidget + index * 1.7) * sway;
      if (s.pulse && s.pulse.seat !== index && now - s.pulse.at < 4000) {
        const other = seatPos(s.pulse.seat);
        const world = Math.atan2(other.x - p.x, other.z - p.z);
        let local = world - (seatAngle(index) + Math.PI);
        local = Math.atan2(Math.sin(local), Math.cos(local));
        yaw = Math.max(-0.75, Math.min(0.75, local));
      }
      const pitch = current?.typing ? 0.12 + sway * 0.4 + (reduced ? 0 : Math.sin(t * 7 * fidget) * 0.03) : 0;
      head.current.rotation.y += (yaw - head.current.rotation.y) * Math.min(1, dt * 4);
      head.current.rotation.x += (pitch - head.current.rotation.x) * Math.min(1, dt * 6);
    }
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial;
      const on = s.mode === "room" && !rp && (s.focusSeat === index || s.suspectSeat === index);
      const target = on ? (s.focusSeat === index ? 0.85 : 0.45) * (reduced ? 1 : 0.8 + Math.sin(t * 3) * 0.2) : 0;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 4);
      ring.current.visible = m.opacity > 0.01;
    }
  });

  return (
    <>
      <group ref={group} position={[p.x, 0, p.z]} rotation={[0, facing, 0]}>
        {/* chair */}
        <mesh position={[0, 0.45, 0]}>
          <boxGeometry args={[0.5, 0.05, 0.48]} />
          <meshStandardMaterial color={COLORS.chair} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.82, -0.23]}>
          <boxGeometry args={[0.5, 0.7, 0.04]} />
          <meshStandardMaterial color={COLORS.chair} roughness={0.85} />
        </mesh>
        {[[-0.21, -0.2], [0.21, -0.2], [-0.21, 0.2], [0.21, 0.2]].map(([x, z]) => (
          <mesh key={`${x}${z}`} position={[x, 0.22, z]}>
            <boxGeometry args={[0.04, 0.45, 0.04]} />
            <meshStandardMaterial color={COLORS.chair} />
          </mesh>
        ))}
        {/* abstract bust: torso, neck, head */}
        <group ref={bust} position={[0, 0.48, 0.02]}>
          {[SEAT_MATERIALS[index].solid, SEAT_MATERIALS[index].wire].map((mat, i) => (
            <group key={i}>
              <mesh material={mat} position={[0, 0.36, 0]}>
                <cylinderGeometry args={[0.2, 0.31, 0.62, 9]} />
              </mesh>
              <mesh material={mat} position={[0, 0.74, 0]}>
                <cylinderGeometry args={[0.07, 0.08, 0.14, 6]} />
              </mesh>
            </group>
          ))}
          {/* Head pivots at the neck so it can turn toward speakers and dip while typing. */}
          <group ref={head} position={[0, 0.8, 0]}>
            {[SEAT_MATERIALS[index].solid, SEAT_MATERIALS[index].wire].map((mat, i) => (
              <mesh key={i} material={mat} position={[0, 0.15, 0.01]}>
                <icosahedronGeometry args={[0.17, 1]} />
              </mesh>
            ))}
          </group>
        </group>
      </group>
      {/* Suspicion ring on the floor: the seat the room pointed at, or the one on the spot. */}
      <mesh ref={ring} position={[p.x, 0.012, p.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.42, 0.47, 32]} />
        <meshBasicMaterial color={COLORS.amber} transparent opacity={0} depthWrite={false} />
      </mesh>
      {seat && <NameTag name={seat.name} index={index} />}
    </>
  );
}

/* ------------------------------------------------------------------ room */

function Room() {
  const shadowTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(64, 64, 10, 64, 64, 64);
      grd.addColorStop(0, "rgba(0,0,0,0.85)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(c);
  }, []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[24, 24]} />
        <meshStandardMaterial color={COLORS.floor} roughness={0.95} />
      </mesh>
      {/* baked contact shadow under the table */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <planeGeometry args={[5.5, 5.5]} />
        <meshBasicMaterial map={shadowTex} transparent depthWrite={false} />
      </mesh>
      {/* back wall with a one-way mirror */}
      <mesh position={[0, 3, -4.2]}>
        <planeGeometry args={[24, 8]} />
        <meshStandardMaterial color={COLORS.wall} roughness={1} />
      </mesh>
      <mesh position={[0, 2.2, -4.18]}>
        <planeGeometry args={[4.6, 1.5]} />
        <meshStandardMaterial color="#0b0b0b" roughness={0.15} metalness={0.85} />
      </mesh>
      <mesh position={[-5.5, 3, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[16, 8]} />
        <meshStandardMaterial color={COLORS.wall} roughness={1} />
      </mesh>
      <mesh position={[5.5, 3, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[16, 8]} />
        <meshStandardMaterial color={COLORS.wall} roughness={1} />
      </mesh>
      {/* table */}
      <mesh position={[0, 0.74, 0]}>
        <cylinderGeometry args={[TABLE_R, TABLE_R, 0.07, 32]} />
        <meshStandardMaterial color={COLORS.table} roughness={0.55} metalness={0.15} />
      </mesh>
      <mesh position={[0, 0.37, 0]}>
        <cylinderGeometry args={[0.09, 0.32, 0.72, 10]} />
        <meshStandardMaterial color={COLORS.chair} />
      </mesh>
      {/* a case file and a cup, for scale and story */}
      <mesh position={[0.25, 0.79, -0.15]} rotation={[-Math.PI / 2, 0, 0.3]}>
        <planeGeometry args={[0.42, 0.3]} />
        <meshStandardMaterial color="#c9b98f" roughness={0.9} />
      </mesh>
      <mesh position={[-0.35, 0.83, 0.2]}>
        <cylinderGeometry args={[0.05, 0.04, 0.1, 12]} />
        <meshStandardMaterial color="#d9d0bf" roughness={0.5} />
      </mesh>
    </group>
  );
}

export default function InterrogationRoom({ onContextLost }: { onContextLost: () => void }) {
  const [dpr, setDpr] = useState(1.5);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return (
    <Canvas
      dpr={[1, dpr]}
      frameloop={visible ? "always" : "never"}
      camera={{ fov: 36, position: [0, 3.1, 6.8], near: 0.1, far: 40 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
      onCreated={({ gl, scene }) => {
        scene.background = COLORS.floor.clone();
        scene.fog = new THREE.Fog(COLORS.floor, 7, 15);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          onContextLost();
        });
      }}
    >
      <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} />
      <hemisphereLight args={["#3a2c1c", "#050403", 0.35]} />
      <Room />
      <Lamp />
      {Array.from({ length: SEAT_COUNT }, (_, i) => (
        <Seat key={i} index={i} />
      ))}
      <CameraRig />
    </Canvas>
  );
}
