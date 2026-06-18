/**
 * 3D scene components (fully procedural modeling, no GLB dependency).
 *
 * Two generations (A5 / A6). Four scenes, switched by ClusterView per view mode:
 *   OverviewScene   data-hall floor: compute-cabinet grid + comms-cabinet block
 *   RackScene       single cabinet internals (compute blade rack / UB switch rack)
 *   NodeScene       compute blade: 8× NPU (multi-die) + CPU + UB fabric,
 *                   with toggleable die / process(rank) / thread comm overlays
 *   TopologyScene   UB interconnect hierarchy L0→L4 (die → node → rack mesh
 *                   → pod-level Clos → cluster scale-out)
 *
 * Colour coding follows the UB hierarchy levels (UB_LEVELS), not per-plane.
 * Display text with product/brand terms is sourced from ../content (decoded at
 * runtime); this file carries no plaintext product names.
 */
import { Suspense, createContext, useContext, useEffect, useMemo, useState, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text as DreiText, Edges, Line } from '@react-three/drei';
import * as THREE from 'three';
import {
  RACK_DIM, COMPUTE_RACK_UNITS, SWITCH_RACK_UNITS,
  NODE_DIM, NODE_PARTS, NPU_GRID, DIES_PER_NPU, NPUS_PER_NODE,
  UB_LEVELS, COMM_PATTERNS, RACK_COLORS,
  buildHall, CAB_W, CAB_H, CAB_D,
  SCALES, makeAdjacency, makeSwitchedAdjacency, TRACE_SCHED, PARTITION_PALETTE, STATUS_COLORS,
  type RackKind, type RackUnit, type NodePart, type GenSpec, type CabinetCell, type Scale, type RunMode, type RunPhase, type PartitionDim,
} from './data';
import { TOK } from '../content';

// ─── Theme-aware scene palette ───────────────────────────────────────────────
// Structural / neutral / text colours for every procedural object. Light variant
// = brushed-metal greys on a near-white floor; dark variant = graphite surfaces
// on a near-black floor (PTO-style #101010 stage), so the topology objects and
// their labels stay legible when the UI theme switches.
export interface ScenePalette {
  primary: string; rackBody: string; rackDoor: string; rackEdge: string; rackEdgeHov: string;
  text: string; textDim: string; textInv: string; nodeUnit: string; powerUnit: string;
  mgmtUnit: string; switchUnit: string; cduUnit: string; pcb: string; npuBody: string;
  npuTop: string; cpuBody: string; cpuTop: string; ubBody: string; dpuBody: string;
  opticalBody: string; dimmBody: string; metal: string; vent: string;
  substrate: string; substrate2: string; block: string; blockHi: string; blockAlt: string;
  cardBase: string; bladeBase: string; cabBase: string; hoverTint: string; matIndirect: string; matSelf: string;
}
const PALETTE: Record<'light' | 'dark', ScenePalette> = {
  light: {
    primary: '#4369ef', rackBody: '#e8ebf1', rackDoor: '#dde1e9', rackEdge: '#aab4c4', rackEdgeHov: '#4369ef',
    text: '#1c2433', textDim: '#6b7890', textInv: '#ffffff', nodeUnit: '#f2f4f8', powerUnit: '#e9edf3',
    mgmtUnit: '#e6eaf1', switchUnit: '#edf0f5', cduUnit: '#e2e7ee', pcb: '#bcd2c4', npuBody: '#e4e8ef',
    npuTop: '#aeb8c6', cpuBody: '#e1e7ea', cpuTop: '#b2c6c0', ubBody: '#e8ebf1', dpuBody: '#e3e8f2',
    opticalBody: '#dde3ec', dimmBody: '#e0e5ee', metal: '#c4cad4', vent: '#9aa4b2',
    substrate: '#eef1f6', substrate2: '#eaeef4', block: '#cdd6e4', blockHi: '#d6e0f0', blockAlt: '#dbe6f2',
    cardBase: '#aeb8c6', bladeBase: '#dbe9fb', cabBase: '#efe7fb', hoverTint: '#dbe4fb', matIndirect: '#e2e6ec', matSelf: '#3a4256',
  },
  dark: {
    primary: '#5b7cff', rackBody: '#23262d', rackDoor: '#1b1e24', rackEdge: '#3d4452', rackEdgeHov: '#5b7cff',
    text: '#e6e6e6', textDim: '#9aa4b6', textInv: '#ffffff', nodeUnit: '#2a2f38', powerUnit: '#23272f',
    mgmtUnit: '#262b33', switchUnit: '#2c313a', cduUnit: '#242931', pcb: '#2b3a31', npuBody: '#2b303a',
    npuTop: '#4b5160', cpuBody: '#283038', cpuTop: '#3e544c', ubBody: '#262b33', dpuBody: '#242a34',
    opticalBody: '#222831', dimmBody: '#232932', metal: '#565e6c', vent: '#6b7688',
    substrate: '#1f242c', substrate2: '#1c2128', block: '#2c3442', blockHi: '#314056', blockAlt: '#2a3a4c',
    cardBase: '#4b5160', bladeBase: '#2c3a52', cabBase: '#332c46', hoverTint: '#2f3c58', matIndirect: '#272c34', matSelf: '#aab4c8',
  },
};
export function scenePalette(dark: boolean): ScenePalette { return dark ? PALETTE.dark : PALETTE.light; }

const L = (i: number) => UB_LEVELS[i].color;       // UB level colour shortcut

// dark/light theme for the 3-D scenes (provided inside the Canvas)
export const SceneTheme = createContext(false);
// resolve the structural palette for the current scene theme
function useLC(): ScenePalette { return scenePalette(useContext(SceneTheme)); }

export interface SceneCallbacks { onHoverInfo: (text: string | null) => void; }
const setCursor = (on: boolean) => { document.body.style.cursor = on ? 'pointer' : 'default'; };

// drei <Text> preloads a font via suspend-react; wrap in local Suspense so an
// unreachable font source can't bubble up and block the view.
function Text(props: ComponentProps<typeof DreiText>) {
  return <Suspense fallback={null}><DreiText {...props} /></Suspense>;
}

// ─── Generic edged box ───────────────────────────────────────────────────────
function Slab(props: {
  size: [number, number, number];
  position?: [number, number, number];
  color: string; metalness?: number; roughness?: number;
  emissive?: string; emissiveIntensity?: number; edgeColor?: string; opacity?: number;
}) {
  const { size, position, color, metalness = 0.3, roughness = 0.6, emissive, emissiveIntensity = 0, edgeColor, opacity } = props;
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color} metalness={metalness} roughness={roughness}
        emissive={emissive ?? '#000000'} emissiveIntensity={emissiveIntensity}
        transparent={opacity !== undefined} opacity={opacity ?? 1}
      />
      {edgeColor && <Edges color={edgeColor} threshold={20} />}
    </mesh>
  );
}

function Floor({ size = 22 }: { size?: number }) {
  const dark = useContext(SceneTheme);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color={dark ? '#15171c' : '#f0f1f4'} roughness={0.95} metalness={0.05} />
      </mesh>
      <gridHelper args={[size, size * 2, dark ? '#2b303a' : '#d0d5dd', dark ? '#202329' : '#e1e4ea']} position={[0, 0.001, 0]} />
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Overview: data-hall floor (compute grid + comms block)
// ═══════════════════════════════════════════════════════════════════════════

function HallCabinet({ cell, hovered, onClick, onHover }: {
  cell: CabinetCell; hovered: boolean; onClick: () => void; onHover: (h: boolean) => void;
}) {
  return (
    <group
      position={cell.pos}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); setCursor(true); }}
      onPointerOut={() => { onHover(false); setCursor(false); }}
    >
      <CabinetBox w={CAB_W} h={CAB_H} d={CAB_D} kind={cell.kind} hovered={hovered} />
    </group>
  );
}

/** Cabinet interconnect: every cabinet uplinks (full-optical) to the UB-switch
 *  Clos in the communication cabinets → cross-cabinet all-to-all; plus in-hall
 *  row/column adjacency mesh. (Schematic, but reflects the real relationship.) */
function HallSpine({ cells, onHoverInfo }: { cells: CabinetCell[]; onHoverInfo: (t: string | null) => void }) {
  const { uplinkGeo, meshGeo, apex } = useMemo(() => {
    const compute = cells.filter((c) => c.kind === 'compute');
    const comms = cells.filter((c) => c.kind === 'switch');
    const cz = comms.length ? comms.reduce((s, c) => s + c.pos[2], 0) / comms.length : 0;
    const apex: [number, number, number] = [0, CAB_H + 1.5, cz];
    // uplinks: every cabinet → Clos apex
    const up: number[] = [];
    for (const c of cells) up.push(c.pos[0], CAB_H, c.pos[2], apex[0], apex[1], apex[2]);
    // in-hall adjacency mesh among compute cabinets (row + column neighbours)
    const key = (v: number) => Math.round(v * 100);
    const byRow = new Map<number, CabinetCell[]>();
    const byCol = new Map<number, CabinetCell[]>();
    for (const c of compute) {
      (byRow.get(key(c.pos[2])) ?? byRow.set(key(c.pos[2]), []).get(key(c.pos[2]))!).push(c);
      (byCol.get(key(c.pos[0])) ?? byCol.set(key(c.pos[0]), []).get(key(c.pos[0]))!).push(c);
    }
    const mesh: number[] = [];
    const connect = (arr: CabinetCell[], axis: 'x' | 'z') => {
      arr.sort((a, b) => (axis === 'x' ? a.pos[0] - b.pos[0] : a.pos[2] - b.pos[2]));
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = arr[i], b = arr[i + 1];
        mesh.push(a.pos[0], CAB_H * 0.5, a.pos[2], b.pos[0], CAB_H * 0.5, b.pos[2]);
      }
    };
    byRow.forEach((a) => connect(a, 'x'));
    byCol.forEach((a) => connect(a, 'z'));
    const g = (s: number[]) => { const x = new THREE.BufferGeometry(); x.setAttribute('position', new THREE.Float32BufferAttribute(s, 3)); return x; };
    return { uplinkGeo: g(up), meshGeo: g(mesh), apex };
  }, [cells]);

  return (
    <group
      onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`机柜互联：全部计算柜 + 通信柜经全光上行至 ${TOK.ub} 交换 Clos（通信柜），实现跨柜全互联；柜间在机房内另有 ${TOK.fullmesh} 行/列邻接（示意）`); }}
      onPointerOut={() => onHoverInfo(null)}
    >
      {/* in-hall adjacency mesh (L2 violet) */}
      <lineSegments geometry={meshGeo}><lineBasicMaterial color={L(2)} transparent opacity={0.25} /></lineSegments>
      {/* uplinks to Clos apex (L3 orange) */}
      <lineSegments geometry={uplinkGeo}><lineBasicMaterial color={L(3)} transparent opacity={0.22} /></lineSegments>
      {/* Clos apex node */}
      <mesh position={apex}><sphereGeometry args={[0.16, 16, 16]} /><meshStandardMaterial color={L(3)} emissive={L(3)} emissiveIntensity={0.6} /></mesh>
      <Text position={[apex[0], apex[1] + 0.3, apex[2]]} fontSize={0.32} color={L(3)} anchorX="center">{`${TOK.ub} 交换 Clos（通信柜）· 跨柜全互联`}</Text>
    </group>
  );
}

export function OverviewScene({ gen, highlightCabinet, onHoverInfo, onSelectRack }: SceneCallbacks & {
  gen: GenSpec; highlightCabinet?: number | null; onSelectRack: (kind: RackKind) => void;
}) {
  const LC = useLC();
  const cells = useMemo(() => buildHall(gen), [gen]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hlId = highlightCabinet != null ? `c-${highlightCabinet}` : null;
  const depth = useMemo(() => {
    const zs = cells.map((c) => c.pos[2]); return Math.max(...zs) - Math.min(...zs) + 4;
  }, [cells]);

  return (
    <group>
      <Floor size={Math.max(16, depth + 4)} />
      {cells.map((cell) => (
        <HallCabinet
          key={cell.id}
          cell={cell}
          hovered={hoverId === cell.id || hlId === cell.id}
          onClick={() => onSelectRack(cell.kind)}
          onHover={(h) => {
            setHoverId(h ? cell.id : null);
            onHoverInfo(h
              ? cell.kind === 'compute'
                ? `计算柜 · 8 节点 / 64× ${gen.npuShort} NPU · 柜内 ${TOK.fullmesh} · 液冷（点击下钻）`
                : `通信柜 · ${TOK.ub} 交换设备 · Clos 顶层 · 全光（点击下钻）`
              : null);
          }}
        />
      ))}
      <HallSpine cells={cells} onHoverInfo={onHoverInfo} />
      <Text position={[0, 0.02, -(depth / 2) + 0.6]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.34} color={LC.textDim} anchorX="center">
        {`${gen.code} · ${gen.totalCabs} cabinets (${gen.computeCabs} compute + ${gen.commCabs} comms) · ${gen.totalNpus} NPU`}
      </Text>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Cabinet internals
// ═══════════════════════════════════════════════════════════════════════════

function QuickConnectors({ count, width }: { count: number; width: number }) {
  const LC = useLC();
  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} position={[(i - (count - 1) / 2) * (width / count), 0, 0.012]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.028, 0.02, 20]} />
          <meshStandardMaterial color={LC.metal} metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

function RackUnitMesh({ unit, rackKind, hovered, clickable, onClick, onHover }: {
  unit: RackUnit; rackKind: RackKind; hovered: boolean; clickable: boolean;
  onClick?: () => void; onHover: (h: boolean) => void;
}) {
  const LC = useLC();
  const innerW = RACK_DIM.w * 2.6, innerD = RACK_DIM.d * 2.6, rackH = RACK_DIM.h * 2.6;
  const h = unit.hFrac * rackH * 0.92;
  const y = (unit.y0 + unit.hFrac / 2) * rackH;
  const swColor = L(3);   // UB Clos level colour for switch trays
  const bodyColor =
    unit.type === 'power'       ? LC.powerUnit :
    unit.type === 'mgmt'        ? LC.mgmtUnit :
    unit.type === 'cdu'         ? LC.cduUnit :
    unit.type === 'switch-unit' ? LC.switchUnit : LC.nodeUnit;

  return (
    <group
      position={[0, y, 0]}
      onClick={clickable ? (e) => { e.stopPropagation(); onClick?.(); } : undefined}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); if (clickable) setCursor(true); }}
      onPointerOut={() => { onHover(false); setCursor(false); }}
    >
      <Slab
        size={[innerW - 0.12, h, innerD - 0.2]} color={bodyColor} metalness={0.3} roughness={0.55}
        edgeColor={hovered ? (rackKind === 'switch' ? swColor : RACK_COLORS.computeGlow) : LC.rackEdge}
      />
      <group position={[0, 0, (innerD - 0.2) / 2]}>
        {unit.type === 'power' && (
          <group>
            {Array.from({ length: 4 }, (_, i) => (
              <group key={i} position={[(i - 1.5) * (innerW / 4.6), 0, 0.015]}>
                <Slab size={[innerW / 5.2, h * 0.7, 0.02]} color={LC.metal} metalness={0.6} roughness={0.4} edgeColor={LC.rackEdge} />
                <Slab size={[0.02, 0.02, 0.012]} position={[innerW / 12, h * 0.22, 0.014]} color="#22c55e" emissive="#22c55e" emissiveIntensity={1.2} />
              </group>
            ))}
          </group>
        )}
        {unit.type === 'mgmt' && (
          <group>
            <Slab size={[innerW * 0.7, h * 0.5, 0.02]} position={[-innerW * 0.06, 0, 0.012]} color={LC.rackDoor} edgeColor={LC.rackEdge} />
            <Slab size={[0.016, 0.016, 0.012]} position={[innerW * 0.36, 0, 0.018]} color="#38bdf8" emissive="#38bdf8" emissiveIntensity={1.1} />
          </group>
        )}
        {unit.type === 'node' && (
          <group>
            {[-1, 1].map((s) => (
              <Slab key={s} size={[0.05, h * 0.62, 0.03]} position={[s * (innerW / 2 - 0.16), 0, 0.02]} color={LC.metal} metalness={0.6} roughness={0.4} />
            ))}
            {Array.from({ length: 3 }, (_, i) => (
              <Slab key={i} size={[innerW * 0.62, 0.012, 0.012]} position={[0, (i - 1) * h * 0.26, 0.016]} color={LC.vent} />
            ))}
            <group position={[0, -h * 0.3, 0.01]}><QuickConnectors count={2} width={0.3} /></group>
            <Slab size={[0.018, 0.018, 0.012]} position={[innerW * 0.33, h * 0.3, 0.018]} color={RACK_COLORS.computeGlow} emissive={RACK_COLORS.computeGlow} emissiveIntensity={hovered ? 1.6 : 0.9} />
          </group>
        )}
        {unit.type === 'switch-unit' && (
          <group>
            <Slab size={[innerW * 0.78, 0.022, 0.014]} position={[0, h * 0.3, 0.016]} color={swColor} emissive={swColor} emissiveIntensity={0.8} />
            {/* optical port row */}
            {Array.from({ length: 10 }, (_, i) => (
              <Slab key={i} size={[0.03, 0.03, 0.01]} position={[(i - 4.5) * (innerW * 0.085), -h * 0.12, 0.016]} color={LC.vent} emissive="#fbbf24" emissiveIntensity={0.5} />
            ))}
          </group>
        )}
        {unit.type === 'cdu' && (
          <group>
            {[-1, 1].map((s) => (
              <mesh key={s} position={[s * innerW * 0.22, 0, 0.03]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.045, 0.045, 0.05, 16]} />
                <meshStandardMaterial color="#26527a" metalness={0.6} roughness={0.4} />
              </mesh>
            ))}
          </group>
        )}
      </group>
      <Text position={[-(innerW / 2) + 0.02, 0, (innerD - 0.2) / 2 + 0.04]} fontSize={0.072} color={hovered ? LC.primary : LC.textDim} anchorX="left" anchorY="middle">
        {unit.labelEn}
      </Text>
    </group>
  );
}

export function RackScene({ rackKind, label, onHoverInfo, onSelectNode, onSelectSwitch }: SceneCallbacks & {
  rackKind: RackKind; label: string; onSelectNode: (slot: number) => void; onSelectSwitch?: () => void;
}) {
  const LC = useLC();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const units = rackKind === 'compute' ? COMPUTE_RACK_UNITS : SWITCH_RACK_UNITS;
  const innerW = RACK_DIM.w * 2.6, innerD = RACK_DIM.d * 2.6, rackH = RACK_DIM.h * 2.6;

  return (
    <group>
      <Floor size={12} />
      <pointLight position={[0, 4.2, 6]} intensity={18} color="#ffffff" />
      <pointLight position={[3.5, 1.4, 4.5]} intensity={8} color="#ffffff" />
      <group
        onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`${label} 机柜框架 · 标准 19" · 浅色钣金 + 后背板全光走线`); }}
        onPointerOut={() => onHoverInfo(null)}
      >
        <Slab size={[innerW + 0.1, 0.08, innerD + 0.1]} position={[0, 0.04, 0]} color={LC.rackBody} metalness={0.5} roughness={0.55} edgeColor={LC.rackEdge} />
        {[-1, 1].map((s) => (
          <Slab key={s} size={[0.05, rackH, innerD]} position={[s * (innerW / 2 + 0.05), rackH / 2 + 0.08, 0]} color={LC.rackBody} metalness={0.55} roughness={0.45} edgeColor={LC.rackEdge} />
        ))}
        <Slab size={[innerW + 0.1, 0.06, innerD + 0.1]} position={[0, rackH + 0.11, 0]} color={LC.rackBody} metalness={0.55} roughness={0.45} edgeColor={LC.rackEdge} />
        <Slab size={[innerW, rackH, 0.04]} position={[0, rackH / 2 + 0.08, -(innerD / 2 + 0.02)]} color={LC.rackDoor} metalness={0.4} roughness={0.6} />
        <Slab size={[0.02, rackH, 0.02]} position={[innerW / 2 + 0.08, rackH / 2 + 0.08, innerD / 2 - 0.02]} color={RACK_COLORS.accent} emissive={RACK_COLORS.accent} emissiveIntensity={0.35} />
      </group>
      <group position={[0, 0.08, 0]}>
        {units.map((u) => {
          const clickable = u.type === 'node' || u.type === 'switch-unit';
          return (
            <RackUnitMesh
              key={u.id}
              unit={u}
              rackKind={rackKind}
              hovered={hoverId === u.id}
              clickable={clickable}
              onClick={u.type === 'node' ? () => onSelectNode(u.nodeSlot!) : u.type === 'switch-unit' ? () => onSelectSwitch?.() : undefined}
              onHover={(h) => {
                setHoverId(h ? u.id : null);
                onHoverInfo(h ? `${u.label}${u.type === 'node' ? '（点击下钻查看刀片 + die/AI Core/Tile）' : u.type === 'switch-unit' ? '（点击下钻查看 UB 交换设备内部）' : ''}` : null);
              }}
            />
          );
        })}
      </group>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Compute node (blade) — static structure (die-level detail)
// ═══════════════════════════════════════════════════════════════════════════

const S_NODE = 3.2;   // node view scale

// ─── Shared element abstractions: one concept → one look in every view ────────
// (abstracted from the real form; node + cabinet views are the reference)

// Chip textures served from public/textures/ (committed → deployed). Drop the two
// images there as npu-chip.png (package photo) and logo.png (logo) and they get
// mapped onto the chip; if absent we fall back to procedural geometry.
const TEX_BASE = `${import.meta.env.BASE_URL}textures/`;
const CHIP_TEX = `${TEX_BASE}image-1781609094658.png`;   // NPU package photo
const LOGO_TEX = `${TEX_BASE}image-1781609100845.png`;   // logo
const texCache = new Map<string, THREE.Texture | null>();
function useOptionalTexture(url: string): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(() => texCache.get(url) ?? null);
  useEffect(() => {
    if (texCache.has(url)) { setTex(texCache.get(url)!); return; }
    let alive = true;
    new THREE.TextureLoader().load(
      url,
      (t) => { t.colorSpace = THREE.SRGBColorSpace; texCache.set(url, t); if (alive) setTex(t); },
      undefined,
      () => { texCache.set(url, null); },   // remember miss → no retry / no 404 spam
    );
    return () => { alive = false; };
  }, [url]);
  return tex;
}

/** NPU = chip package: metal lid + recessed die/HBM tiles + (optional) vendor mark.
 *  Abstracted from the real package photo. */
function NpuChip({ w, h, hovered, selected, dim, logo }: { w: number; h?: number; hovered?: boolean; selected?: boolean; dim?: number; logo?: boolean }) {
  const LC = useLC();
  const hh = h ?? w * 0.5;
  const edge = selected ? COMM_PATTERNS[2].color : hovered ? '#4ade80' : LC.rackEdge;
  const glow = dim ?? (selected ? 0.6 : hovered ? 0.4 : 0);
  const top = hh / 2;
  const chipTex = useOptionalTexture(CHIP_TEX);
  const logoTex = useOptionalTexture(LOGO_TEX);
  // 2 columns × 3 rows of die / HBM tiles on the recessed lid (chiplet layout)
  const tiles: [number, number][] = [];
  for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) tiles.push([(c - 0.5) * w * 0.36, (r - 1) * w * 0.27]);
  return (
    <group>
      {/* package body (brushed metal lid) */}
      <Slab size={[w, hh, w]} color={LC.npuBody} edgeColor={edge} metalness={0.6} roughness={0.35} />
      {chipTex ? (
        /* textured top: real package photo on a plane (local-only image) */
        <mesh position={[0, top + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[w * 0.92, w * 0.92]} />
          <meshBasicMaterial map={chipTex} toneMapped={false} />
        </mesh>
      ) : (
        <group>
          {/* recessed dark frame */}
          <Slab size={[w * 0.9, hh * 0.14, w * 0.9]} position={[0, top, 0]} color="#23272e" metalness={0.4} roughness={0.6} />
          {/* die / HBM tiles */}
          {tiles.map(([tx, tz], i) => (
            <Slab key={i} size={[w * 0.3, hh * 0.16, w * 0.2]} position={[tx, top + hh * 0.12, tz]}
              color={LC.npuTop} emissive={selected || hovered ? L(0) : '#000000'} emissiveIntensity={glow} metalness={0.7} roughness={0.3} />
          ))}
          {/* central vertical seam */}
          <Slab size={[w * 0.02, hh * 0.18, w * 0.86]} position={[0, top + hh * 0.12, 0]} color="#3a4250" metalness={0.5} roughness={0.5} />
          {/* mark: logo image on a plane if provided, else procedural red prism */}
          {logo && (logoTex ? (
            <mesh position={[0, top + hh * 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[w * 0.4, w * 0.4]} />
              <meshBasicMaterial map={logoTex} transparent toneMapped={false} />
            </mesh>
          ) : (
            <mesh position={[0, top + hh * 0.22, 0]} rotation={[0, Math.PI, 0]}>
              <cylinderGeometry args={[w * 0.11, w * 0.11, hh * 0.18, 3]} />
              <meshStandardMaterial color={RACK_COLORS.accent} emissive={RACK_COLORS.accent} emissiveIntensity={0.45} metalness={0.3} roughness={0.4} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}
/** CPU = chip package + lid. */
function CpuChip({ w, h, hovered }: { w: number; h?: number; hovered?: boolean }) {
  const LC = useLC();
  const hh = h ?? w * 0.5;
  return (
    <group>
      <Slab size={[w, hh, w]} color={LC.cpuBody} edgeColor={hovered ? '#38bdf8' : LC.rackEdge} metalness={0.4} roughness={0.5} />
      <Slab size={[w * 0.8, hh * 0.5, w * 0.8]} position={[0, hh * 0.6, 0]} color={LC.cpuTop} metalness={0.85} roughness={0.3} />
    </group>
  );
}
/** Blade / compute node = thin tray with a front accent strip. */
function BladeTray({ w, d, hovered, accent = true }: { w: number; d: number; hovered?: boolean; accent?: boolean }) {
  const LC = useLC();
  return (
    <group>
      <Slab size={[w, 0.05, d]} color={LC.nodeUnit} edgeColor={hovered ? RACK_COLORS.computeGlow : LC.rackEdge} metalness={0.4} roughness={0.5} />
      {accent && <Slab size={[w * 0.86, 0.014, 0.02]} position={[0, 0.032, d / 2 - 0.03]} color={RACK_COLORS.computeGlow} emissive={RACK_COLORS.computeGlow} emissiveIntensity={hovered ? 0.8 : 0.4} />}
    </group>
  );
}
/** Cabinet = tall sheet-metal box + top status strip (compute vs switch). */
function CabinetBox({ w = 0.34, h = 1.0, d = 0.5, kind = 'compute', hovered }: { w?: number; h?: number; d?: number; kind?: RackKind; hovered?: boolean }) {
  const LC = useLC();
  const glow = kind === 'compute' ? RACK_COLORS.computeGlow : RACK_COLORS.switchGlow;
  return (
    <group>
      <Slab size={[w, h, d]} position={[0, h / 2, 0]} color={hovered ? LC.hoverTint : LC.rackBody} edgeColor={hovered ? glow : LC.rackEdge} metalness={0.5} roughness={0.5} />
      <Slab size={[w * 0.78, 0.03, d * 0.7]} position={[0, h + 0.02, 0]} color={glow} emissive={glow} emissiveIntensity={hovered ? 1.0 : 0.5} />
    </group>
  );
}

function NodePartMesh({ part, hovered, selected, onHover, onSelect }: {
  part: NodePart; hovered: boolean; selected?: boolean; onHover: (h: boolean) => void; onSelect?: () => void;
}) {
  const LC = useLC();
  const S = S_NODE;
  const [px, py, pz] = part.pos;
  const [sx, sy, sz] = part.size;
  const selColor = COMM_PATTERNS[2].color;

  const visuals: Record<NodePart['type'], { body: string; top?: string; edge: string }> = {
    npu:        { body: LC.npuBody,     top: LC.npuTop, edge: '#4ade80' },
    cpu:        { body: LC.cpuBody,     top: LC.cpuTop, edge: '#38bdf8' },
    'ub-fabric':{ body: LC.ubBody,      top: L(1),      edge: L(1) },
    dpu:        { body: LC.dpuBody,     top: '#23304a', edge: '#818cf8' },
    optical:    { body: LC.opticalBody, edge: L(3) },
    dimm:       { body: LC.dimmBody,    edge: '#475263' },
  };
  const v = visuals[part.type];

  return (
    <group
      position={[px * S, py * S, pz * S]}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); if (onSelect) setCursor(true); }}
      onPointerOut={() => { onHover(false); if (onSelect) setCursor(false); }}
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(); } : undefined}
    >
      {part.type === 'npu' ? (
        <>
          <NpuChip w={sx * S} h={sy * S} hovered={hovered} selected={selected} logo />
          {selected && <Slab size={[sx * S * 1.08, 0.004 * S, sz * S * 1.08]} position={[0, sy * S * 1.0, 0]} color={selColor} emissive={selColor} emissiveIntensity={1} />}
        </>
      ) : part.type === 'cpu' ? (
        <CpuChip w={sx * S} h={sy * S} hovered={hovered} />
      ) : (
        <>
          <Slab size={[sx * S, sy * S, sz * S]} color={v.body} metalness={0.35} roughness={0.6} edgeColor={hovered ? v.edge : LC.rackEdge} />
          {v.top && (
            <Slab size={[sx * S * 0.82, sy * S * 0.5, sz * S * 0.82]} position={[0, sy * S * 0.62, 0]}
              color={v.top} metalness={part.type === 'ub-fabric' ? 0.3 : 0.85} roughness={part.type === 'ub-fabric' ? 0.5 : 0.3}
              emissive={part.type === 'ub-fabric' ? v.top : '#000000'} emissiveIntensity={part.type === 'ub-fabric' ? (hovered ? 0.9 : 0.4) : 0} />
          )}
          {part.type === 'optical' && Array.from({ length: 14 }, (_, i) => (
            <Slab key={i} size={[0.028 * S, sy * S * 0.6, 0.008 * S]} position={[(i - 6.5) * 0.044 * S, 0, sz * S * 0.7]}
              color={LC.vent} emissive="#fbbf24" emissiveIntensity={hovered ? 0.8 : 0.3} />
          ))}
        </>
      )}
      {(part.type === 'npu' || part.type === 'cpu') && (
        <Text position={[0, sy * S * 1.05, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={part.type === 'npu' ? 0.06 : 0.045} color={LC.textDim} anchorX="center" anchorY="middle">
          {part.type === 'npu' ? `${TOK.ascendEn} ${TOK.n950dt}` : `${TOK.kunpengEn} ${TOK.n950}`}
        </Text>
      )}
      {/* software overlay: process(rank) tag on each NPU */}
      {part.type === 'npu' && part.npuIdx !== undefined && (
        <Text position={[0, sy * S * 1.05, sz * S * 0.66]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.05} color="#4369ef" anchorX="center" anchorY="middle">
          {`rank ${part.npuIdx}`}
        </Text>
      )}
    </group>
  );
}

/** Build a LineSegments geometry from an array of [ax,ay,az,bx,by,bz] in one colour. */
function segGeo(segments: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
  return g;
}

/** Toggleable overlays. ring/a2a → UB hierarchy view; tile/cores → node view. */
export interface CommOverlays { ring: boolean; a2a: boolean; tile: boolean; cores: boolean; }

// ─── Node die compute-detail (AI Core array + SRAM + Tile dataflow) ──────────
const DIE = {
  pos: [2.7, 0.06, 0] as [number, number, number],   // inset podium beside the blade
  w: 1.7, d: 1.1,
  cube: { rows: 4, cols: 4 },     // Cube core array (schematic)
  vec: { rows: 2, cols: 4 },      // Vector cores
};

/** Enlarged single-die view: HBM → L1 → L0 → Cube/Vector cores, with tile dataflow. */
function DieDetail({ npuIdx, overlays, onHoverInfo }: { npuIdx: number; overlays: CommOverlays; onHoverInfo: (t: string | null) => void }) {
  const LC = useLC();
  const [hx, hz] = [DIE.w / 2, DIE.d / 2];
  const cubeColor = COMM_PATTERNS[2].color;   // thread/tile colour (cyan)
  const tileColor = '#f59e0b';

  // tile dataflow polyline: HBM → L1 → L0A/L0B → Cube → L0C → L1
  const flowGeo = useMemo(() => {
    const p = (x: number, z: number): [number, number, number] => [x, 0.06, z];
    const seg: number[] = [];
    const hbm = p(-hx + 0.18, 0), l1 = p(-hx + 0.62, 0), l0 = p(-0.1, 0), cube = p(0.55, 0), l0c = p(0.55, -hz + 0.3);
    const chain = [hbm, l1, l0, cube, l0c, l1];
    for (let i = 0; i < chain.length - 1; i++) seg.push(...chain[i], ...chain[i + 1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    return g;
  }, [hx, hz]);

  const Block = ({ x, z, w, d, label, color }: { x: number; z: number; w: number; d: number; label: string; color: string }) => (
    <group position={[x, 0, z]}
      onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`${label}`); }}
      onPointerOut={() => onHoverInfo(null)}
    >
      <Slab size={[w, 0.05, d]} position={[0, 0.025, 0]} color={color} metalness={0.3} roughness={0.55} edgeColor={LC.rackEdge} />
      <Text position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.08} color={LC.text} anchorX="center" anchorY="middle">{label}</Text>
    </group>
  );

  return (
    <group position={DIE.pos}>
      {/* substrate */}
      <Slab size={[DIE.w + 0.1, 0.03, DIE.d + 0.1]} position={[0, 0, 0]} color={LC.substrate} edgeColor={LC.rackEdge} />
      {/* HBM stack (left) */}
      <Block x={-hx + 0.18} z={0} w={0.22} d={DIE.d * 0.8} label="HBM 144GB" color={LC.block} />
      {/* L1 SRAM */}
      <Block x={-hx + 0.62} z={0} w={0.2} d={DIE.d * 0.7} label="L1 512KB" color={LC.blockHi} />
      {/* L0A/L0B buffers */}
      <Block x={-0.1} z={hz - 0.28} w={0.5} d={0.18} label="L0A/B 64KB" color={LC.blockAlt} />
      {/* AI Core array: Cube + Vector */}
      {overlays.cores && (
        <group>
          {Array.from({ length: DIE.cube.rows * DIE.cube.cols }, (_, k) => {
            const r = Math.floor(k / DIE.cube.cols), c = k % DIE.cube.cols;
            return (
              <Slab key={`cube-${k}`} size={[0.085, 0.06, 0.085]}
                position={[0.4 + c * 0.1, 0.03, (r - 1.5) * 0.1]}
                color={cubeColor} emissive={cubeColor} emissiveIntensity={0.5} />
            );
          })}
          {Array.from({ length: DIE.vec.rows * DIE.vec.cols }, (_, k) => {
            const r = Math.floor(k / DIE.vec.cols), c = k % DIE.vec.cols;
            return (
              <Slab key={`vec-${k}`} size={[0.07, 0.05, 0.07]}
                position={[0.4 + c * 0.1, 0.03, (r - 0.5) * 0.1 + hz - 0.22]}
                color="#7dd3fc" emissive="#7dd3fc" emissiveIntensity={0.35} />
            );
          })}
          <Text position={[0.62, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.07} color={cubeColor} anchorX="center">AI Core · Cube+2Vector ×36/芯片</Text>
        </group>
      )}
      {/* L0C accumulator */}
      <Block x={0.55} z={-hz + 0.3} w={0.5} d={0.18} label="L0C 256KB" color={LC.blockAlt} />
      {/* tile dataflow */}
      {overlays.tile && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`Tile 数据流：HBM→L1→L0→Cube→L0C 异步流水（TileShape 切分 · 参考 TileLang/${TOK.pypto}）`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <lineSegments geometry={flowGeo}><lineBasicMaterial color={tileColor} transparent opacity={0.9} /></lineSegments>
        </group>
      )}
      <Text position={[0, 0.05, hz + 0.18]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.1} color={LC.textDim} anchorX="center">
        {`放大：NPU #${npuIdx + 1} 的 die · AI Core + 多级 SRAM · 线程/Tile 级（点左侧 NPU 切换）`}
      </Text>
    </group>
  );
}

/** IO Die interconnect detail: 18× x4 ports, on-chip switch (9-port forward),
 *  collective engine, ethernet / PCIe uplinks, async / sync memory semantics. */
export type UbJump = { view: 'topology' | 'matrix'; focus: 'ccu' | 'onchip' | 'ub' };
const IODIE = { pos: [-2.7, 0.06, 0] as [number, number, number], w: 1.8, d: 1.1 };
function IoDieDetail({ onHoverInfo, onJump }: { onHoverInfo: (t: string | null) => void; onJump?: (t: UbJump) => void }) {
  const LC = useLC();
  const [hx, hz] = [IODIE.w / 2, IODIE.d / 2];
  const portColor = '#9aa4b2';
  // 18 ports in 2 rows × 9 along the top
  const portPos = (i: number): [number, number, number] => {
    const r = Math.floor(i / 9), c = i % 9;
    return [-hx + 0.22 + c * 0.17, 0.05, hz - 0.18 - r * 0.18];
  };
  const switchPos: [number, number, number] = [0.15, 0.05, -0.08];
  // 9 ports (row 0) forward through the on-chip switch
  const fwdGeo = useMemo(() => {
    const seg: number[] = [];
    for (let i = 0; i < 9; i++) { const p = portPos(i); seg.push(p[0], 0.06, p[2], switchPos[0], 0.06, switchPos[2]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)); return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group position={IODIE.pos}>
      <Slab size={[IODIE.w + 0.1, 0.03, IODIE.d + 0.1]} position={[0, 0, 0]} color={LC.substrate2} edgeColor={LC.rackEdge} />
      {/* 18 UB ports */}
      <group
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`18× x4 ${TOK.ub} Port（72 HiLink lane · 112Gbps · 2016 GB/s 双向）· Scale-up/out 端口复用 · 点击→邻接矩阵看 NPU↔NPU 互联`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); onJump?.({ view: 'matrix', focus: 'ub' }); }}
      >
        {Array.from({ length: 18 }, (_, i) => {
          const p = portPos(i);
          const uboe = i >= 16;       // 2 ports → ethernet uplink
          const pcie = i >= 12 && i < 16; // 4 ports → PCIe
          const col = uboe ? L(4) : pcie ? '#818cf8' : portColor;
          return <Slab key={i} size={[0.12, 0.05, 0.12]} position={[p[0], 0.03, p[2]]} color={col} emissive={col} emissiveIntensity={0.35} />;
        })}
        <Text position={[0, 0.04, hz + 0.04]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.082} color={LC.text} anchorX="center">18× x4 UB Port · 2016 GB/s</Text>
      </group>
      {/* on-chip switch forwarding (9 ports) */}
      <group
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`${TOK.onchip}：单 IO Die 内 9 个 x4 端口间片上转发，经 NoC 直接转出，不进计算 Die、不占 DRAM 带宽 · 点击→UB 互联高亮`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); onJump?.({ view: 'topology', focus: 'onchip' }); }}
      >
        <lineSegments geometry={fwdGeo}><lineBasicMaterial color={L(3)} transparent opacity={0.6} /></lineSegments>
        <Slab size={[0.34, 0.09, 0.26]} position={switchPos} color={L(3)} emissive={L(3)} emissiveIntensity={0.5} edgeColor={L(3)} />
        <Text position={[switchPos[0], 0.12, switchPos[2]]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.07} color="#fff" anchorX="center">On-Chip SW · 9口转发</Text>
      </group>
      {/* collective engine */}
      <group
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`${TOK.ccu}（集合通信单元）：硬件卸载 AllReduce / All2All / ReduceScatter 等，自行搬运+Reduce，释放 AI Core · 点击→UB 互联高亮`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); onJump?.({ view: 'topology', focus: 'ccu' }); }}
      >
        <Slab size={[0.34, 0.09, 0.22]} position={[-0.55, 0.05, -hz + 0.22]} color={COMM_PATTERNS[0].color} emissive={COMM_PATTERNS[0].color} emissiveIntensity={0.4} edgeColor={COMM_PATTERNS[0].color} />
        <Text position={[-0.55, 0.12, -hz + 0.22]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.075} color="#fff" anchorX="center">{`${TOK.ccu} 集合通信`}</Text>
      </group>
      {/* protocol legend */}
      <Text position={[0.5, 0.05, -hz + 0.18]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.07} color={LC.textDim} anchorX="center" maxWidth={1.0}>
        {`${TOK.urma} 异步 · ${TOK.ubmem} 同步(Ld/St/Atomic)`}
      </Text>
      <Text position={[0, 0.05, -hz - 0.04]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.075} color={LC.textDim} anchorX="center">
        {`IO Die · 互连子系统 · 绿=${TOK.uboe} 2×400G · 蓝=PCIe5 x16`}
      </Text>
    </group>
  );
}

/** Node-internal UB 2D-mesh among the 8 NPUs (L1 board fabric). */
function BoardMesh() {
  const S = S_NODE;
  const geo = useMemo(() => {
    const npu = NODE_PARTS.filter((p) => p.type === 'npu');
    const pos = (i: number): [number, number, number] => [npu[i].pos[0] * S, 0.05 * S, npu[i].pos[2] * S];
    const seg: number[] = [];
    for (let r = 0; r < NPU_GRID.rows; r++)
      for (let c = 0; c < NPU_GRID.cols; c++) {
        const i = r * NPU_GRID.cols + c;
        if (i >= npu.length) continue;
        if (c + 1 < NPU_GRID.cols) seg.push(...pos(i), ...pos(i + 1));
        if (r + 1 < NPU_GRID.rows && i + NPU_GRID.cols < npu.length) seg.push(...pos(i), ...pos(i + NPU_GRID.cols));
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    return g;
  }, []);
  return <lineSegments geometry={geo}><lineBasicMaterial color={L(1)} transparent opacity={0.7} /></lineSegments>;
}

export function NodeScene({ onHoverInfo, overlays, onJump, initialSelected }: SceneCallbacks & { overlays: CommOverlays; onJump?: (t: UbJump) => void; initialSelected?: number }) {
  const LC = useLC();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selected, setSelected] = useState(initialSelected ?? 0);   // which NPU's die is enlarged
  useEffect(() => { if (initialSelected != null) setSelected(initialSelected % NPUS_PER_NODE); }, [initialSelected]);
  const S = S_NODE;
  const w = NODE_DIM.w * S, h = NODE_DIM.h * S, d = NODE_DIM.d * S;
  const selColor = COMM_PATTERNS[2].color;

  // leader line from the selected NPU to the die inset
  const leaderGeo = useMemo(() => {
    const npu = NODE_PARTS.filter((p) => p.type === 'npu')[selected];
    const a: [number, number, number] = [npu.pos[0] * S, 0.06 * S + 0.5, npu.pos[2] * S];
    const b: [number, number, number] = [DIE.pos[0] - DIE.w / 2, DIE.pos[1] + 0.2, DIE.pos[2]];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3));
    return g;
  }, [selected, S]);

  return (
    <group>
      <Floor size={10} />
      <group position={[0, 0.5, 0]}>
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`节点托盘 · 全宽液冷刀片 · ${NPUS_PER_NODE}× NPU + CPU + 板载 UB fabric`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <Slab size={[w + 0.12, 0.04, d + 0.12]} position={[0, -0.02, 0]} color={LC.rackBody} metalness={0.6} roughness={0.45} edgeColor={LC.rackEdge} />
          {[-1, 1].map((s) => (
            <Slab key={'w' + s} size={[0.03, h * 0.9, d + 0.12]} position={[s * (w / 2 + 0.045), h * 0.43, 0]} color={LC.rackDoor} metalness={0.6} roughness={0.45} />
          ))}
        </group>
        <mesh
          position={[0, 0.012, 0]}
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`节点主板 PCB · 板载 ${TOK.ub} L1 UB 2D-Mesh fabric（蓝=L1）`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <boxGeometry args={[w, 0.018, d]} />
          <meshStandardMaterial color={LC.pcb} metalness={0.1} roughness={0.85} />
        </mesh>
        {NODE_PARTS.map((p) => (
          <NodePartMesh
            key={p.id}
            part={p}
            hovered={hoverId === p.id}
            selected={p.type === 'npu' && p.npuIdx === selected}
            onSelect={p.type === 'npu' ? () => setSelected(p.npuIdx!) : undefined}
            onHover={(hv) => {
              setHoverId(hv ? p.id : null);
              onHoverInfo(hv ? (p.type === 'npu' ? `${p.label}（点击放大该 die 算子视图 →）` : p.label) : null);
            }}
          />
        ))}
        {/* node-internal UB 2D-mesh (L1 board fabric) */}
        <BoardMesh />
      </group>
      {/* leader: selected NPU → die inset */}
      <lineSegments geometry={leaderGeo}><lineBasicMaterial color={selColor} transparent opacity={0.8} /></lineSegments>
      {/* right inset: AI Die (compute) of the selected NPU */}
      <DieDetail npuIdx={selected} overlays={overlays} onHoverInfo={onHoverInfo} />
      {/* left inset: IO Die (interconnect subsystem) */}
      <IoDieDetail onHoverInfo={onHoverInfo} onJump={onJump} />
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. UB interconnect hierarchy (L0 → L4)
// ═══════════════════════════════════════════════════════════════════════════

const HT = {
  y: [0.4, 1.5, 2.7, 4.0, 5.3],   // tier Y per level
  xSpan: 9.5,
};

export function TopologyScene({ gen, overlays, highlight, subFocus, onHoverInfo }: SceneCallbacks & { gen: GenSpec; overlays: CommOverlays; highlight?: { npu: number; blade: number } | null; subFocus?: 'ccu' | 'onchip' | 'ub' | null }) {
  const LC = useLC();
  const [hov, setHov] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);   // focused parent level (highlight its downstream link)
  const cabs = Math.max(1, Math.round(gen.totalNpus / 64));
  const hlNpu = highlight ? highlight.npu % 8 : -1;
  const hlBlade = highlight ? highlight.blade % 8 : -1;

  // 2×4 grids so full-mesh links spread out and visibly crisscross
  const grid2x4 = (px: number, pz: number): [number, number, number][] =>
    Array.from({ length: 8 }, (_, i) => { const c = i % 4, r = Math.floor(i / 4); return [(c - 1.5) * px, 0, (r - 0.5) * pz]; });
  const npuPts = useMemo(() => grid2x4(0.52, 0.46), []);    // L1: 8 NPU in one blade
  const nodePts = useMemo(() => grid2x4(1.1, 0.5), []);     // L2: 8 blades in one cabinet
  const allPairs = (pts: [number, number, number][]): [number, number, number][] => {
    const o: [number, number, number][] = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) o.push(pts[i], pts[j]);
    return o;
  };
  const rect = (w: number, d: number, y = 0): [number, number, number][] =>
    [[-w / 2, y, -d / 2], [w / 2, y, -d / 2], [w / 2, y, d / 2], [-w / 2, y, d / 2], [-w / 2, y, -d / 2]];

  // process(rank) overlays use the L1 NPU positions
  const yR = HT.y[1] + 0.34;
  const ringGeo = useMemo(() => {
    const order = [0, 1, 2, 3, 7, 6, 5, 4];
    const seg: number[] = [];
    for (let k = 0; k < order.length; k++) { const a = npuPts[order[k]], b = npuPts[order[(k + 1) % 8]]; seg.push(a[0], yR, a[2], b[0], yR, b[2]); }
    return segGeo(seg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npuPts]);

  const levelInfo = (lvl: number): string => {
    switch (lvl) {
      case 0: return `L0 片内：${TOK.ascend} ${gen.npuShort} 封装内 ${DIES_PER_NPU} die · die 间 UB/SIO 直连`;
      case 1: return `L1 刀片/节点内：${NPUS_PER_NODE}× NPU 全互联（full-mesh，每颗对所有）· 单 NPU ${gen.chipUbTBs} TB/s`;
      case 2: return `L2 机柜内：8 刀片 / 64 NPU · 跨刀片 ${TOK.fullmesh} 全互联（复杂交错，非简单聚合）`;
      case 3: return `L3 ${TOK.supernode}内：${cabs} 机柜 经 UB 交换(通信柜) Clos · ${gen.totalNpus} NPU · ${gen.interconnectPBs} PB/s`;
      case 4: return `L4 ${TOK.supernode}间：${TOK.supercluster} scale-out · ${gen.superclusterNpu}卡（全光）`;
      default: return '';
    }
  };

  const Tier = ({ lvl, children }: { lvl: number; children?: ReactNode }) => {
    const isH = hov === lvl;
    return (
      <group
        position={[0, HT.y[lvl], 0]}
        onPointerOver={(e) => { e.stopPropagation(); setHov(lvl); setCursor(true); onHoverInfo(levelInfo(lvl)); }}
        onPointerOut={() => { setHov(null); setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); setFocus((f) => (f === lvl ? null : lvl)); }}
      >
        {children}
        <Text position={[-HT.xSpan / 2 - 0.3, 0, 0]} fontSize={0.2} color={isH ? L(lvl) : LC.textDim} anchorX="right" anchorY="middle" maxWidth={3}>
          {`${UB_LEVELS[lvl].id} ${UB_LEVELS[lvl].label}`}
        </Text>
        <Text position={[HT.xSpan / 2 + 0.3, 0, 0]} fontSize={0.15} color={isH ? L(lvl) : LC.textDim} anchorX="left" anchorY="middle" maxWidth={5}>
          {lvl === 0 ? `${DIES_PER_NPU} die / NPU` : lvl === 1 ? `8 NPU 全互联` : lvl === 2 ? `8 刀片 / 64 NPU` : lvl === 3 ? `${cabs} 机柜 · ${gen.interconnectPBs} PB/s` : `${gen.superclusterNpu}卡`}
        </Text>
      </group>
    );
  };

  // up/down (containment) connectors between adjacent levels — clickable focus.
  // parent level p (1..4) contains the downstream level p-1.
  const downName = (p: number) =>
    p === 1 ? 'NPU / die' : p === 2 ? '刀片 ×8' : p === 3 ? `机柜 ×${cabs}` : p === 4 ? `${TOK.supernode}` : '';
  const parentName = (p: number) =>
    p === 1 ? '刀片' : p === 2 ? '机柜' : p === 3 ? TOK.supernode : p === 4 ? TOK.supercluster : '';
  const edges = [1, 2, 3, 4].map((p) => ({
    p,
    pts: [[0, HT.y[p] - 0.2, 0], [0, HT.y[p - 1] + 0.2, 0]] as [number, number, number][],
  }));

  return (
    <group>
      <Floor size={16} />

      {/* L0 — one NPU package: dual die (NpuChip = same NPU element used everywhere) */}
      <Tier lvl={0}>
        <NpuChip w={0.62} h={0.2} hovered={hov === 0} dim={hov === 0 ? 0.9 : 0.6} logo />
        <Text position={[0, 0, 0.42]} fontSize={0.12} color={LC.textDim} anchorX="center">1 NPU 封装 · 2 die</Text>
      </Tier>

      {/* L1 — ONE blade: 8 NPU FULL-MESH (all-to-all crisscross) inside a 刀片 box */}
      <Tier lvl={1}>
        <Line points={rect(2.05, 0.95)} color={L(1)} lineWidth={1.5} transparent opacity={hov === 1 ? 0.95 : 0.6} />
        <Line points={allPairs(npuPts)} segments color={L(1)} lineWidth={hov === 1 ? 2.6 : 1.8} transparent opacity={hov === 1 ? 0.95 : 0.6} />
        {npuPts.map((p, i) => (
          <group key={i} position={[p[0], 0.02, p[2]]}>
            <NpuChip w={0.18} h={0.12} hovered={hov === 1} selected={i === hlNpu} />
            {i === hlNpu && <Text position={[0, 0.3, 0]} fontSize={0.12} color={PROC_COLOR} anchorX="center">{`rank ${highlight!.npu}`}</Text>}
          </group>
        ))}
        <Text position={[0, 0, 0.66]} fontSize={0.14} color={hov === 1 ? L(1) : LC.textDim} anchorX="center">1 刀片 / 节点 · 8 NPU 全互联</Text>
      </Tier>

      {/* L2 — ONE cabinet: 8 blades, cross-blade FULL-MESH; each blade is a tray, all in a 机柜 box */}
      <Tier lvl={2}>
        <Line points={rect(HT.xSpan * 0.86, 1.15)} color={L(2)} lineWidth={2} transparent opacity={hov === 2 ? 0.95 : 0.7} />
        <Line points={allPairs(nodePts)} segments color={L(2)} lineWidth={hov === 2 ? 2.4 : 1.6} transparent opacity={hov === 2 ? 0.9 : 0.5} />
        {nodePts.map((p, i) => (
          <group key={i} position={[p[0], 0.02, p[2]]}>
            <BladeTray w={0.5} d={0.4} hovered={hov === 2 || i === hlBlade} />
            {i === hlBlade && <Text position={[0, 0.22, 0]} fontSize={0.11} color={L(1)} anchorX="center">{`刀片 B${highlight!.blade}`}</Text>}
          </group>
        ))}
        <Text position={[0, 0, 0.8]} fontSize={0.14} color={hov === 2 ? L(2) : LC.textDim} anchorX="center">1 机柜 · 8 刀片 / 64 NPU（托盘=刀片，外框=机柜）</Text>
      </Tier>

      {/* L3 — pod: cabinets → UB switch Clos (fan to switch, not full-mesh) */}
      <Tier lvl={3}>
        {(() => {
          const M = Math.min(cabs, 8);
          const cx = Array.from({ length: M }, (_, i) => (i / (M - 1 || 1) - 0.5) * HT.xSpan * 0.78);
          const seg: number[] = [];
          for (const x of cx) seg.push(x, 0.18, 0.22, 0, 0.32, -0.18);   // each cabinet top → central switch
          return (
            <group>
              {/* UB switch (Clos core) */}
              <Slab size={[HT.xSpan * 0.5, 0.16, 0.3]} position={[0, 0.32, -0.18]} color={L(3)} emissive={L(3)} emissiveIntensity={hov === 3 ? 0.7 : 0.35} />
              <Text position={[0, 0.46, -0.18]} fontSize={0.12} color={L(3)} anchorX="center">UB 交换 Clos（通信柜）</Text>
              {cx.map((x, i) => (
                <group key={i} position={[x, 0, 0.22]}><CabinetBox w={0.34} h={0.34} d={0.3} kind="compute" hovered={hov === 3} /></group>
              ))}
              <Line points={segPairs(seg)} segments color={L(3)} lineWidth={hov === 3 ? 2.4 : 1.6} transparent opacity={hov === 3 ? 0.9 : 0.55} />
              <Text position={[0, 0, 0.66]} fontSize={0.13} color={hov === 3 ? L(3) : LC.textDim} anchorX="center">{`${cabs} 机柜 经通信柜 Clos 全互联`}</Text>
            </group>
          );
        })()}
      </Tier>

      {/* L4 — cluster scale-out */}
      <Tier lvl={4}>
        <Slab size={[HT.xSpan * 0.72, 0.14, 0.5]} color={L(4)} opacity={hov === 4 ? 0.7 : 0.38} emissive={L(4)} emissiveIntensity={hov === 4 ? 0.4 : 0.16} />
        <Text position={[0, 0, 0.5]} fontSize={0.13} color={hov === 4 ? L(4) : LC.textDim} anchorX="center">{`多超节点 → ${TOK.supercluster}`}</Text>
      </Tier>

      {/* up/down containment connectors — click a level to highlight its line + downstream */}
      {edges.map((e) => {
        const on = focus === e.p;
        return (
          <group key={e.p}
            onPointerOver={(ev) => { ev.stopPropagation(); setCursor(true); }}
            onPointerOut={() => setCursor(false)}
            onClick={(ev) => { ev.stopPropagation(); setFocus((f) => (f === e.p ? null : e.p)); }}
          >
            {/* invisible thick pick target */}
            <mesh position={[0, (e.pts[0][1] + e.pts[1][1]) / 2, 0]}>
              <boxGeometry args={[0.3, Math.abs(e.pts[0][1] - e.pts[1][1]), 0.3]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            <Line points={e.pts} color={on ? L(e.p) : '#9aa4b2'} lineWidth={on ? 4 : 1} dashed={!on} dashScale={4} transparent opacity={on ? 1 : (focus === null ? 0.5 : 0.18)} />
          </group>
        );
      })}
      {focus !== null && (
        <Text position={[1.0, (HT.y[focus] + HT.y[focus - 1]) / 2, 0]} fontSize={0.16} color={L(focus)} anchorX="left" anchorY="middle">
          {`${parentName(focus)} ▸ 下游 = ${downName(focus)}`}
        </Text>
      )}

      {/* ── process(rank) comm overlays (toggled in toolbar) ── */}
      {overlays.a2a && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`进程级 All-to-All（MoE 专家并行）：rank 间全互联，沿 L1/L2 UB full-mesh + L3 Clos`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <Line points={a2aPts(npuPts, yR + 0.04)} segments color={COMM_PATTERNS[1].color} lineWidth={1.5} transparent opacity={0.5} />
          <Text position={[2.0, yR, 0]} fontSize={0.14} color={COMM_PATTERNS[1].color} anchorX="left">All-to-All</Text>
        </group>
      )}
      {overlays.ring && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`进程级 Ring-AllReduce（数据并行梯度规约）：rank 环形通信，沿 UB full-mesh`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <lineSegments geometry={ringGeo}><lineBasicMaterial color={COMM_PATTERNS[0].color} transparent opacity={0.9} /></lineSegments>
          <Text position={[2.0, yR + 0.2, 0]} fontSize={0.14} color={COMM_PATTERNS[0].color} anchorX="left">Ring AllReduce</Text>
        </group>
      )}

      {/* IO-die sub-structures present in every chip: collective engine + on-chip switch */}
      <Text position={[-HT.xSpan / 2 - 0.3, HT.y[1] + 0.55, 0]} fontSize={0.14} color={LC.textDim} anchorX="right">片内互连子结构</Text>
      <group
        position={[-HT.xSpan / 2 - 0.9, HT.y[1] + 0.1, 0]}
        scale={subFocus === 'ccu' ? 1.4 : 1}
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`${TOK.ccu}（集合通信单元）：硬件卸载 Ring-AllReduce / All2All / ReduceScatter，自行搬运+Reduce，释放 AI Core、降总线占用`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
      >
        <Slab size={[0.55, 0.18, 0.3]} color={COMM_PATTERNS[0].color} emissive={COMM_PATTERNS[0].color} emissiveIntensity={subFocus === 'ccu' ? 1.0 : 0.4} edgeColor={subFocus === 'ccu' ? '#fff' : COMM_PATTERNS[0].color} />
        <Text position={[0, 0.16, 0]} fontSize={0.12} color={COMM_PATTERNS[0].color} anchorX="center">{`${TOK.ccu} 集合通信`}</Text>
        {subFocus === 'ccu' && <Text position={[0, -0.18, 0]} fontSize={0.1} color={COMM_PATTERNS[0].color} anchorX="center">← 来自 IO Die</Text>}
      </group>
      <group
        position={[-HT.xSpan / 2 - 0.9, HT.y[2] + 0.1, 0]}
        scale={subFocus === 'onchip' ? 1.4 : 1}
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`${TOK.onchip}：单 IO Die 内 9 个 x4 端口间片上转发（经 NoC 直转），不进计算 Die、不占 DRAM 带宽 — 支撑 nD-Mesh / Clos 路由`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
      >
        <Slab size={[0.55, 0.18, 0.3]} color={L(3)} emissive={L(3)} emissiveIntensity={subFocus === 'onchip' ? 1.0 : 0.4} edgeColor={subFocus === 'onchip' ? '#fff' : L(3)} />
        <Text position={[0, 0.16, 0]} fontSize={0.1} color={L(3)} anchorX="center">On-Chip SW 9口转发</Text>
        {subFocus === 'onchip' && <Text position={[0, -0.18, 0]} fontSize={0.1} color={L(3)} anchorX="center">← 来自 IO Die</Text>}
      </group>

      <Text position={[0, 0.04, 2.6]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.19} color={LC.textDim} anchorX="center">
        {`${TOK.ubmesh}：层内=UB 全互联(full-mesh) · 框=刀片/机柜 · ${TOK.ccu} 卸载集合通信 · On-Chip SW 片上转发`}
      </Text>
    </group>
  );
}

/** helpers shared by topology overlays */
function segPairs(seg: number[]): [number, number, number][] {
  const o: [number, number, number][] = [];
  for (let i = 0; i < seg.length; i += 3) o.push([seg[i], seg[i + 1], seg[i + 2]]);
  return o;
}
function a2aPts(pts: [number, number, number][], y: number): [number, number, number][] {
  const o: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { o.push([pts[i][0], y, pts[i][2]], [pts[j][0], y, pts[j][2]]); }
  return o;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. UB adjacency matrix (NPU × NPU, recursive full-mesh)
// ═══════════════════════════════════════════════════════════════════════════

/** Thin cylinder link between two points (for emphasised pair). */
function LinkTube({ a, b, color, r = 0.025 }: { a: [number, number, number]; b: [number, number, number]; color: string; r?: number }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const dir = vb.clone().sub(va);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { pos: va.clone().add(vb).multiplyScalar(0.5), quat: q, len };
  }, [a, b]);
  return (
    <mesh position={pos} quaternion={quat}>
      <cylinderGeometry args={[r, r, len, 10]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  );
}

/** Animated dashed line — dashes flow along the path (collective-comm direction). */
function FlowLine({ points, color, width = 2.5, speed = 1, opacity = 0.95 }: {
  points: [number, number, number][]; color: string; width?: number; speed?: number; opacity?: number;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  useFrame((_, dt) => { const m = ref.current?.material; if (m) m.dashOffset -= dt * speed; });
  return (
    <Line ref={ref} points={points} color={color} lineWidth={width} transparent opacity={opacity}
      dashed dashSize={0.32} gapSize={0.22} />
  );
}

const MAT_SPAN = 3.8;       // upright matrix footprint
const MAT_POS: [number, number, number] = [-3.7, 2.2, 0];
const MODEL_POS: [number, number, number] = [3.3, 0.5, 0];

export function AdjacencyScene({ scale, onHoverInfo }: SceneCallbacks & { scale: Scale }) {
  const LC = useLC();
  const spec = SCALES[scale];
  const dims = spec.dims;
  const switched = spec.kind === 'switched';
  const paths = spec.paths ?? 6;
  const { n, cell } = useMemo(() => switched ? makeSwitchedAdjacency(spec.npus, paths) : makeAdjacency(dims),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scale]);
  const ref = useRef<THREE.InstancedMesh>(null);
  const modelRef = useRef<THREE.InstancedMesh>(null);
  const lastMat = useRef(-1);     // guard: only setState when hovered cell changes
  const lastModel = useRef(-1);
  const [hoverCell, setHoverCell] = useState<[number, number] | null>(null);  // from matrix
  const [hoverNpu, setHoverNpu] = useState<number | null>(null);              // from 3D model

  // unified highlight: rows/cols to guide in matrix, NPUs to emphasise in model
  const hi = useMemo(() => {
    if (hoverCell) return { rows: [hoverCell[0]], cols: [hoverCell[1]], npus: [hoverCell[0], hoverCell[1]] as number[], pair: hoverCell };
    if (hoverNpu !== null) return { rows: [hoverNpu], cols: [hoverNpu], npus: [hoverNpu], pair: null as [number, number] | null };
    return { rows: [] as number[], cols: [] as number[], npus: [] as number[], pair: null as [number, number] | null };
  }, [hoverCell, hoverNpu]);

  // ── matrix geometry (upright XY plane) ──
  const cellSize = MAT_SPAN / n;
  const colX = (j: number) => -MAT_SPAN / 2 + cellSize * (j + 0.5);
  const rowY = (i: number) => MAT_SPAN / 2 - cellSize * (i + 0.5);   // row 0 at top

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const cSelf = new THREE.Color(LC.matSelf);
    const cIndirect = new THREE.Color(LC.matIndirect);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const idx = i * n + j;
        m.makeScale(cellSize * 0.9, cellSize * 0.9, 1);
        m.setPosition(colX(j), rowY(i), 0);
        mesh.setMatrixAt(idx, m);
        const a = cell(i, j);
        if (a.hops === 0) col.copy(cSelf);
        else if (a.direct) col.set(L(a.level));
        else col.copy(cIndirect);
        mesh.setColorAt(idx, col);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [n, cell, cellSize]);

  // ── 3D scale model positions + links ──
  const hub: [number, number, number] = [0, 0, 0];
  const { posArr, l1Pts, l2Pts, boardBoxes, cabBox, spokes, uboePts } = useMemo(() => {
    const empty: [number, number, number][] = [];
    if (switched) {
      // ring of NPUs around a central switch hub (single-hop fully switched)
      const R = 1.7;
      const P: [number, number, number][] = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2 - Math.PI / 2;
        return [Math.cos(a) * R, Math.sin(a) * R, 0];
      });
      const spokes: [number, number, number][] = [];
      const uboePts: [number, number, number][] = [];
      for (const p of P) {
        spokes.push(p, hub);
        const len = Math.hypot(p[0], p[1]) || 1;
        const ux = p[0] / len, uy = p[1] / len;
        // 1–2 external ethernet uplink stubs pointing outward
        uboePts.push([p[0], p[1], 0], [p[0] + ux * 0.26, p[1] + uy * 0.26, 0]);
        uboePts.push([p[0] + ux * 0.06, p[1] + uy * 0.06, 0.05], [p[0] + ux * 0.3, p[1] + uy * 0.3, 0.05]);
      }
      return { posArr: P, l1Pts: empty, l2Pts: empty, boardBoxes: [] as { idx: number; cx: number; cy: number; w: number; h: number }[], cabBox: { cx: 0, cy: 0, w: 0, h: 0 }, spokes, uboePts };
    }
    const perBoard = dims[0], nb = dims[1];
    const bcols = nb <= 2 ? nb : (nb <= 4 ? 2 : 4);
    const lc4 = 4, npuP = 0.34, gapX = 0.6, gapY = 0.7;
    const boardW = lc4 * npuP + gapX, boardH = 2 * npuP + gapY;
    const P: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const b = Math.floor(k / perBoard), l = k % perBoard;
      const bc = b % bcols, br = Math.floor(b / bcols);
      const lcx = l % lc4, lcy = Math.floor(l / lc4);
      P.push([bc * boardW + lcx * npuP, br * boardH + lcy * npuP, 0]);
    }
    const mx = (Math.min(...P.map(p => p[0])) + Math.max(...P.map(p => p[0]))) / 2;
    const my = (Math.min(...P.map(p => p[1])) + Math.max(...P.map(p => p[1]))) / 2;
    for (const p of P) { p[0] -= mx; p[1] -= my; }
    // per-board (blade) bounding boxes
    const boardBoxes = Array.from({ length: nb }, (_, b) => {
      const pts = P.slice(b * perBoard, (b + 1) * perBoard);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      return { idx: b, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 0.28, h: y1 - y0 + 0.28 };
    });
    const ax = P.map(p => p[0]), ay = P.map(p => p[1]);
    const cabBox = { cx: 0, cy: 0, w: Math.max(...ax) - Math.min(...ax) + 0.6, h: Math.max(...ay) - Math.min(...ay) + 0.6 };
    // direct UB links by level, as point pairs for fat lines
    const l1Pts: [number, number, number][] = [], l2Pts: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = cell(i, j);
      if (!a.direct) continue;
      (a.level <= 1 ? l1Pts : l2Pts).push(P[i], P[j]);
    }
    return { posArr: P, l1Pts, l2Pts, boardBoxes, cabBox, spokes: empty, uboePts: empty };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, n, cell]);

  const boardOf = (k: number) => Math.floor(k / dims[0]);
  const localOf = (k: number) => k % dims[0];

  // model instance transforms + colours (recomputed only when highlight changes)
  useLayoutEffect(() => {
    const mesh = modelRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const base = new THREE.Color(LC.npuBody);
    for (let k = 0; k < n; k++) {
      const on = hi.npus.includes(k);
      const s = on ? 0.22 : 0.13;
      m.makeScale(s, s, s);
      m.setPosition(posArr[k][0], posArr[k][1], posArr[k][2]);
      mesh.setMatrixAt(k, m);
      if (on) {
        const lvl = hi.pair ? cell(hi.pair[0], hi.pair[1]).level : 1;
        col.set(L(lvl));
      } else col.copy(base);
      mesh.setColorAt(k, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [posArr, hi, n, cell]);

  return (
    <group>
      <Floor size={16} />

      {/* ── left: upright adjacency matrix ── */}
      <group position={MAT_POS}>
        <instancedMesh
          ref={ref}
          args={[undefined, undefined, n * n]}
          onPointerMove={(e) => {
            e.stopPropagation();
            const id = e.instanceId;
            if (id === undefined || id === lastMat.current) return;   // only on cell change
            lastMat.current = id;
            const i = Math.floor(id / n), j = id % n;
            setHoverCell([i, j]); setHoverNpu(null);
            const a = cell(i, j);
            const desc = a.hops === 0 ? '对角（自身）'
              : switched ? `单跳交换可达 · ${a.paths} 条交换通路`
              : a.direct ? `直连 · ${UB_LEVELS[a.level].id} ${UB_LEVELS[a.level].label}`
              : `多跳 ×${a.hops}（经 ${UB_LEVELS[a.level].id}）`;
            onHoverInfo(`NPU ${i} ↔ NPU ${j}：${desc}（右侧 3D 同步高亮）`);
          }}
          onPointerOut={() => { lastMat.current = -1; setHoverCell(null); onHoverInfo(null); }}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        {/* board boundary lines (mesh mode only; every dims[0] cells) */}
        {!switched && Array.from({ length: dims[1] + 1 }, (_, b) => {
          const o = -MAT_SPAN / 2 + (MAT_SPAN / dims[1]) * b;
          return (
            <group key={b}>
              <mesh position={[0, o, 0.01]}><planeGeometry args={[MAT_SPAN, 0.01]} /><meshBasicMaterial color={LC.rackEdge} transparent opacity={0.5} /></mesh>
              <mesh position={[o, 0, 0.01]}><planeGeometry args={[0.01, MAT_SPAN]} /><meshBasicMaterial color={LC.rackEdge} transparent opacity={0.5} /></mesh>
            </group>
          );
        })}
        {/* hovered row(i)+col(j) crosshair; intersection = the hovered cell */}
        {hi.rows.map((i) => <mesh key={'r' + i} position={[0, rowY(i), 0.02]}><planeGeometry args={[MAT_SPAN, cellSize]} /><meshBasicMaterial color="#4369ef" transparent opacity={0.16} /></mesh>)}
        {hi.cols.map((j) => <mesh key={'c' + j} position={[colX(j), 0, 0.02]}><planeGeometry args={[cellSize, MAT_SPAN]} /><meshBasicMaterial color="#4369ef" transparent opacity={0.16} /></mesh>)}
        {/* bright marker at the hovered cell (i,j) + i/j end labels */}
        {hi.pair && (
          <group>
            <mesh position={[colX(hi.pair[1]), rowY(hi.pair[0]), 0.03]}><planeGeometry args={[cellSize, cellSize]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.55} /></mesh>
            <Text position={[-MAT_SPAN / 2 - 0.12, rowY(hi.pair[0]), 0.03]} fontSize={0.14} color="#4369ef" anchorX="right">{`i=${hi.pair[0]}`}</Text>
            <Text position={[colX(hi.pair[1]), MAT_SPAN / 2 + 0.12, 0.03]} fontSize={0.14} color="#4369ef" anchorX="center">{`j=${hi.pair[1]}`}</Text>
          </group>
        )}
        <Text position={[0, MAT_SPAN / 2 + 0.3, 0]} fontSize={0.22} color={LC.text} anchorX="center">{`${n}×${n} NPU UB 邻接矩阵`}</Text>
        <Text position={[0, -MAT_SPAN / 2 - 0.28, 0]} fontSize={0.15} color={LC.textDim} anchorX="center">NPU j →</Text>
        <Text position={[-MAT_SPAN / 2 - 0.28, 0, 0]} rotation={[0, 0, Math.PI / 2]} fontSize={0.15} color={LC.textDim} anchorX="center">NPU i →</Text>
      </group>

      {/* ── right: 3D scale model with UB links ── */}
      <group position={MODEL_POS}>
        {/* switched (32P 一体): central switch hub + single-hop spokes + ethernet stubs */}
        {switched && (
          <group>
            <Line points={spokes} segments color={L(3)} lineWidth={hi.npus.length ? 1.2 : 2.4} transparent opacity={hi.npus.length ? 0.25 : 0.7} />
            <Line points={uboePts} segments color={L(4)} lineWidth={2} transparent opacity={0.8} />
            <mesh position={hub}><boxGeometry args={[0.5, 0.5, 0.3]} /><meshStandardMaterial color={L(3)} emissive={L(3)} emissiveIntensity={0.5} /></mesh>
            <Text position={[0, 0, 0.25]} fontSize={0.13} color="#fff" anchorX="center">交换</Text>
            <Text position={[0, -0.42, 0]} fontSize={0.12} color={L(3)} anchorX="center">{`任意两片单跳 · ×${paths} 通路`}</Text>
          </group>
        )}
        {/* cabinet enclosure (mesh mode: ≤64P all within one cabinet) */}
        {!switched && (
          <group>
            <mesh position={[cabBox.cx, cabBox.cy, -0.12]}>
              <planeGeometry args={[cabBox.w, cabBox.h]} />
              <meshBasicMaterial color={LC.substrate} transparent opacity={0.5} />
            </mesh>
            <Line points={[[cabBox.cx - cabBox.w / 2, cabBox.cy - cabBox.h / 2, -0.11], [cabBox.cx + cabBox.w / 2, cabBox.cy - cabBox.h / 2, -0.11], [cabBox.cx + cabBox.w / 2, cabBox.cy + cabBox.h / 2, -0.11], [cabBox.cx - cabBox.w / 2, cabBox.cy + cabBox.h / 2, -0.11], [cabBox.cx - cabBox.w / 2, cabBox.cy - cabBox.h / 2, -0.11]]} color={LC.rackEdge} lineWidth={1.5} />
            <Text position={[cabBox.cx - cabBox.w / 2 + 0.05, cabBox.cy + cabBox.h / 2 + 0.12, 0]} fontSize={0.13} color={LC.textDim} anchorX="left">单柜 (1 cabinet)</Text>
          </group>
        )}
        {/* per-board (blade) trays + labels */}
        {boardBoxes.map((b) => (
          <group key={b.idx}>
            <mesh position={[b.cx, b.cy, -0.07]}>
              <planeGeometry args={[b.w, b.h]} />
              <meshBasicMaterial color={LC.nodeUnit} transparent opacity={0.85} />
            </mesh>
            <Text position={[b.cx, b.cy + b.h / 2 + 0.06, 0]} fontSize={0.1} color={L(1)} anchorX="center">{`刀片 B${b.idx}`}</Text>
          </group>
        ))}
        {/* UB direct links (fat lines for visibility): blue=L1 board, purple=L2 cross-board */}
        {l1Pts.length > 0 && <Line points={l1Pts} segments color={L(1)} lineWidth={hi.npus.length ? 1.5 : 3} transparent opacity={hi.npus.length ? 0.4 : 0.95} />}
        {l2Pts.length > 0 && <Line points={l2Pts} segments color={L(2)} lineWidth={hi.npus.length ? 1.5 : 2.5} transparent opacity={hi.npus.length ? 0.35 : 0.8} />}
        {/* NPUs as a single instanced mesh (perf) */}
        <instancedMesh
          ref={modelRef}
          args={[undefined, undefined, n]}
          onPointerMove={(e) => {
            e.stopPropagation();
            const k = e.instanceId;
            if (k === undefined || k === lastModel.current) return;
            lastModel.current = k;
            setHoverNpu(k); setHoverCell(null);
            onHoverInfo(switched
              ? `NPU ${k}：经中央交换单跳可达任意 NPU（每对 ${paths} 通路）· 另有 ${spec.uboe?.[0]}-${spec.uboe?.[1]} 个外接 ${TOK.uboe} 端口`
              : `NPU ${k}（板 ${boardOf(k)} · 本地 ${localOf(k)}）：板内→L1，跨板→L2（左侧矩阵同步高亮行列）`);
          }}
          onPointerOut={() => { lastModel.current = -1; setHoverNpu(null); onHoverInfo(null); }}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial metalness={0.3} roughness={0.5} toneMapped={false} />
        </instancedMesh>
        {/* emphasised pair link + i/j tags on the two NPUs */}
        {hi.pair && hi.pair[0] !== hi.pair[1] && cell(hi.pair[0], hi.pair[1]).direct && (
          switched ? (
            <group>
              <LinkTube a={posArr[hi.pair[0]]} b={hub} color={L(3)} />
              <LinkTube a={hub} b={posArr[hi.pair[1]]} color={L(3)} />
            </group>
          ) : (
            <LinkTube a={posArr[hi.pair[0]]} b={posArr[hi.pair[1]]} color={L(cell(hi.pair[0], hi.pair[1]).level)} />
          )
        )}
        {hi.pair && hi.pair[0] !== hi.pair[1] && (
          <group>
            <Text position={[posArr[hi.pair[0]][0], posArr[hi.pair[0]][1] + 0.2, posArr[hi.pair[0]][2]]} fontSize={0.16} color="#4369ef" anchorX="center">i</Text>
            <Text position={[posArr[hi.pair[1]][0], posArr[hi.pair[1]][1] + 0.2, posArr[hi.pair[1]][2]]} fontSize={0.16} color="#4369ef" anchorX="center">j</Text>
          </group>
        )}
        <Text position={[0, 2.1, 0]} fontSize={0.22} color={LC.text} anchorX="center">{switched ? `${spec.label} · 3D 结构（${n} NPU ↔ 中央交换）` : `${spec.label} · 3D 结构（${dims[1]} 板 × ${dims[0]} NPU）`}</Text>
        <Text position={[0, -2.0, 0]} fontSize={0.14} color={LC.textDim} anchorX="center">{switched ? `单跳全交换 · 每对 ${paths} 通路（橙）· 每片 1-2 外接 ${TOK.uboe}（绿）` : `${dims.join('×')} 递归 full-mesh · 蓝=L1 板内 · 紫=L2 跨板`}</Text>
      </group>

      <Text position={[0, 0.02, 4.4]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.22} color={LC.textDim} anchorX="center">
        {`${SCALES[scale].label} 邻接矩阵 ↔ 3D 结构联动 · 悬停任一侧，另一侧同步高亮`}
      </Text>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. UB switch device (communication-cabinet switch box internals)
// ═══════════════════════════════════════════════════════════════════════════

export function UBSwitchScene({ onHoverInfo }: SceneCallbacks) {
  const LC = useLC();
  const [hov, setHov] = useState<string | null>(null);
  const S = 2.4;
  const W = 1.15 * S, H = 0.3 * S, D = 0.62 * S;
  const sw = L(3);   // Clos-level (orange)

  return (
    <group>
      <Floor size={10} />
      <pointLight position={[0, 4.2, 6]} intensity={14} color="#ffffff" />
      <group position={[0, 0.55, 0]}>
        {/* chassis tray */}
        <group onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`${TOK.ub} 交换设备机箱 · 安装于通信柜 · 冷板式液冷`); }} onPointerOut={() => onHoverInfo(null)}>
          <Slab size={[W + 0.1, 0.05, D + 0.1]} position={[0, -0.02, 0]} color={LC.rackBody} metalness={0.5} roughness={0.5} edgeColor={LC.rackEdge} />
        </group>
        {/* PCB */}
        <mesh position={[0, 0.012, 0]} onPointerOver={(e) => { e.stopPropagation(); onHoverInfo('交换主板 PCB · 承载 HRS / LRS 交换 ASIC'); }} onPointerOut={() => onHoverInfo(null)}>
          <boxGeometry args={[W, 0.022, D]} />
          <meshStandardMaterial color={LC.pcb} metalness={0.1} roughness={0.85} />
        </mesh>
        {/* HRS high-radix switch (large, centre) */}
        <group position={[0, 0.04, -0.05 * S]}
          onPointerOver={(e) => { e.stopPropagation(); setHov('hrs'); onHoverInfo('HRS 高基数交换 ASIC · Clos 顶层核心 · All-Path-Routing 全路径路由'); }}
          onPointerOut={() => { setHov(null); onHoverInfo(null); }}>
          <Slab size={[0.4 * S, 0.09, 0.34 * S]} color={sw} emissive={sw} emissiveIntensity={hov === 'hrs' ? 1.0 : 0.4} metalness={0.3} roughness={0.45} edgeColor={hov === 'hrs' ? '#fff' : sw} />
          <Text position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.1} color="#fff" anchorX="center">HRS</Text>
        </group>
        {/* LRS low-radix switches (row of 4) */}
        {Array.from({ length: 4 }, (_, i) => {
          const id = `lrs-${i}`, isH = hov === id;
          return (
            <group key={id} position={[(i - 1.5) * 0.26 * S, 0.04, 0.16 * S]}
              onPointerOver={(e) => { e.stopPropagation(); setHov(id); onHoverInfo(`LRS 低基数交换 ASIC #${i + 1} · 汇聚计算柜上行 UB 流量`); }}
              onPointerOut={() => { setHov(null); onHoverInfo(null); }}>
              <Slab size={[0.16 * S, 0.07, 0.14 * S]} color="#f6a45a" emissive="#f6a45a" emissiveIntensity={isH ? 0.9 : 0.35} metalness={0.3} roughness={0.5} edgeColor={isH ? '#fff' : '#f6a45a'} />
              <Text position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.06} color="#5a3a10" anchorX="center">{`LRS${i + 1}`}</Text>
            </group>
          );
        })}
        {/* front optical port panel: 8 banks × 16 OSFP = 128×800GE */}
        <group position={[0, H / 2, D / 2 + 0.01]}
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo('前面板全光 OSFP 端口 · 128× 800GE · 8 组 × 16 口 · 接入计算柜上行光纤'); }}
          onPointerOut={() => onHoverInfo(null)}>
          {Array.from({ length: 8 }, (_, bank) => (
            <group key={bank} position={[(bank - 3.5) * W / 9, 0, 0]}>
              {Array.from({ length: 16 }, (_, j) => (
                <Slab key={j} size={[0.024 * S, 0.024 * S, 0.006]}
                  position={[(j % 4 - 1.5) * 0.03 * S, (Math.floor(j / 4) - 1.5) * 0.03 * S, 0]}
                  color={LC.vent} emissive="#fbbf24" emissiveIntensity={0.5} />
              ))}
            </group>
          ))}
        </group>
        {/* side liquid-cooling connectors */}
        {[-1, 1].map((side) => (
          <group key={side} position={[side * (W / 2 + 0.02), H / 4, 0]}
            onPointerOver={(e) => { e.stopPropagation(); onHoverInfo('液冷快接头 ×4 · 冷板式进 / 回水 · 盲插免工具'); }}
            onPointerOut={() => onHoverInfo(null)}>
            {Array.from({ length: 4 }, (_, i) => (
              <mesh key={i} position={[0, 0, (i - 1.5) * D / 5]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.026 * S, 0.026 * S, 0.03, 14]} />
                <meshStandardMaterial color="#6b9fd4" metalness={0.7} roughness={0.3} />
              </mesh>
            ))}
          </group>
        ))}
        {/* chassis outline */}
        <Slab size={[W, H, D]} position={[0, H / 2, 0]} color={LC.rackBody} opacity={0.16} edgeColor={LC.rackEdge} />
        {/* level strip */}
        <Slab size={[W * 0.5, 0.02, 0.01]} position={[0, H + 0.02, D / 2 + 0.004]} color={sw} emissive={sw} emissiveIntensity={0.7} />
        <Text position={[0, H + 0.16, D / 2 + 0.04]} fontSize={0.11} color={LC.text} anchorX="center">
          {`${TOK.ub} 交换设备 · HRS + LRS · 128×800GE 全光 · L3 Clos 顶层`}
        </Text>
        <Text position={[0, H + 0.04, D / 2 + 0.04]} fontSize={0.08} color={LC.textDim} anchorX="center">
          {'All-Path-Routing 全路径路由 · 1:1 无阻塞 · 液冷'}
        </Text>
      </group>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Software ↔ hardware mapping (process/thread ↔ NPU/AI Core)
// ═══════════════════════════════════════════════════════════════════════════

const PROC_COLOR = '#4369ef';                 // process / rank
const THREAD_COLOR = COMM_PATTERNS[2].color;  // thread / tile (cyan)

export function MappingScene({ onHoverInfo }: SceneCallbacks) {
  const LC = useLC();
  const [focus, setFocus] = useState<number | null>(null);
  const swX = -2.8, hwX = 2.8;
  const rows: { sw: string; hw: string; key?: 'proc' | 'thread'; tag?: string; info: string }[] = [
    { sw: '作业 / 模型', hw: '集群 / 超节点', info: '整个训练作业运行在超节点 / 集群之上' },
    { sw: '并行切分\nDP · TP · EP · PP', hw: 'NPU 组（机柜 / 刀片）', tag: '进程级（rank 间 · 走 UB）', info: '并行策略决定“哪个 rank 算什么”，落到 NPU 组与 NPU 间 UB 通信（DP=Ring-AllReduce，EP=All-to-All，TP=组内，PP=stage 间）' },
    { sw: '进程 rank', hw: '1 NPU', key: 'proc', info: '一个进程(rank) 映射到一颗 NPU；rank 间集合通信走 UB 各级链路' },
    { sw: '算子 / Tile 切分', hw: 'die', tag: '线程级（rank 内 · die 上）', info: `rank 内：算子按 TileShape 切分，数据流 HBM→L1→L0→Cube（参考 TileLang/${TOK.pypto}）` },
    { sw: '线程 / Tile', hw: 'AI Core (Cube/Vector)', key: 'thread', info: '一个线程/Tile 映射到 die 内的 AI Core（Cube/Vector）+ SRAM 上的 Tile' },
  ];
  const y = (i: number) => 4.3 - i * 0.95;

  const SwBox = ({ yy, label, on }: { yy: number; label: string; on: boolean }) => (
    <group position={[swX, yy, 0]}>
      <Slab size={[2.0, 0.6, 0.06]} color={on ? LC.hoverTint : LC.nodeUnit} edgeColor={on ? PROC_COLOR : LC.rackEdge} />
      <Text position={[0, 0, 0.05]} fontSize={0.16} color={LC.text} anchorX="center" anchorY="middle" maxWidth={1.9}>{label}</Text>
    </group>
  );

  return (
    <group>
      <Floor size={14} />
      {/* column headers */}
      <Text position={[swX, y(0) + 0.7, 0]} fontSize={0.22} color={PROC_COLOR} anchorX="center">软件层级</Text>
      <Text position={[hwX, y(0) + 0.7, 0]} fontSize={0.22} color={LC.text} anchorX="center">硬件层级</Text>

      {rows.map((r, i) => {
        const yy = y(i);
        const on = focus === i;
        const lineColor = r.key === 'proc' ? PROC_COLOR : r.key === 'thread' ? THREAD_COLOR : '#9aa4b2';
        return (
          <group key={i}
            onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(r.info); }}
            onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
            onClick={(e) => { e.stopPropagation(); setFocus((f) => (f === i ? null : i)); }}
          >
            {/* software side */}
            <SwBox yy={yy} label={r.sw} on={on} />
            {/* mapping connector */}
            <Line points={[[swX + 1.0, yy, 0], [hwX - 0.9, yy, 0]]} color={on ? lineColor : (r.key ? lineColor : '#c2c9d4')} lineWidth={on ? 4 : (r.key ? 2.5 : 1)} dashed={!r.key && !on} dashScale={4} transparent opacity={on ? 1 : (focus === null ? 0.7 : 0.2)} />
            {/* hardware side — real element per row */}
            <group position={[hwX, yy, 0]}>
              {i === 0 && <CabinetBox w={0.5} h={0.5} d={0.2} kind="compute" hovered={on} />}
              {i === 1 && [-0.5, 0, 0.5].map((dx, k) => <group key={k} position={[dx, 0, 0]}><NpuChip w={0.26} h={0.16} hovered={on} /></group>)}
              {i === 2 && <NpuChip w={0.5} h={0.3} hovered={on} selected={on} logo />}
              {i === 3 && <Slab size={[0.34, 0.18, 0.34]} color={L(0)} emissive={L(0)} emissiveIntensity={on ? 0.9 : 0.5} />}
              {i === 4 && Array.from({ length: 6 }, (_, k) => <Slab key={k} size={[0.1, 0.08, 0.1]} position={[(k % 3 - 1) * 0.16, 0, (Math.floor(k / 3) - 0.5) * 0.16]} color={THREAD_COLOR} emissive={THREAD_COLOR} emissiveIntensity={on ? 0.9 : 0.5} />)}
              <Text position={[0, -0.5, 0]} fontSize={0.14} color={LC.textDim} anchorX="center" maxWidth={2.4}>{r.hw}</Text>
            </group>
            {/* level tag (process / thread boundary) */}
            {r.tag && <Text position={[0, yy - 0.42, 0]} fontSize={0.13} color={r.tag.includes('进程') ? PROC_COLOR : THREAD_COLOR} anchorX="center">{r.tag}</Text>}
          </group>
        );
      })}

      <Text position={[0, y(4) - 0.8, 0]} fontSize={0.18} color={LC.textDim} anchorX="center">
        {'作业 →(DP/PP/TP/EP 切分)→ 进程=NPU →(Tile 切分)→ 线程=AI Core · 点击某层高亮映射'}
      </Text>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Execution timeline ↔ hardware locator (thread/process by time → NPU/blade/cabinet)
// ═══════════════════════════════════════════════════════════════════════════

export interface LocateTarget { rank: number; blade: number; thread: number | null }

export function TraceScene({ onHoverInfo, onLocate, tick }: SceneCallbacks & { onLocate?: (t: LocateTarget | null) => void; tick: number | null }) {
  const LC = useLC();
  const [sel, setSel] = useState<{ p: number; t: number | null } | null>(null);
  const P = 4, T = 3;
  const bladeOf = (p: number) => Math.floor(p / 2);

  const pick = (s: { p: number; t: number | null } | null) => { setSel(s); onLocate?.(s ? { rank: s.p, blade: bladeOf(s.p), thread: s.t } : null); };

  // horizontal positions (entities spread along X), vertical layers (like UB hierarchy)
  const xP = (p: number) => (p - (P - 1) / 2) * 1.7;
  const xT = (p: number, t: number) => xP(p) + (t - (T - 1) / 2) * 0.42;
  const xB = (b: number) => (xP(2 * b) + xP(2 * b + 1)) / 2;
  const yThread = 0.7, yProc = 1.7, yNpu = 2.8, yBlade = 3.8, yCab = 4.8, ySuper = 5.7;

  const phase = tick === null ? null : TRACE_SCHED[tick];
  const computeNow = phase === 'compute', commNow = phase === 'comm';

  // selection chain flags
  const tOn = (p: number, t: number) => sel?.p === p && (sel.t === null || sel.t === t);
  const pOn = (p: number) => sel?.p === p;
  const bOn = (b: number) => sel != null && bladeOf(sel.p) === b;
  const upOn = sel != null;

  // connectors (base, thin) + highlighted path
  const seg = (a: [number, number, number], b: [number, number, number]) => [a, b] as [number, number, number][];
  const baseLines: { pts: [number, number, number][]; c: string }[] = [];
  for (let p = 0; p < P; p++) {
    for (let t = 0; t < T; t++) baseLines.push({ pts: seg([xT(p, t), yThread + 0.12, 0], [xP(p), yProc - 0.12, 0]), c: THREAD_COLOR });
    baseLines.push({ pts: seg([xP(p), yProc + 0.12, 0], [xP(p), yNpu - 0.18, 0]), c: PROC_COLOR });
    baseLines.push({ pts: seg([xP(p), yNpu + 0.18, 0], [xB(bladeOf(p)), yBlade - 0.12, 0]), c: L(1) });
  }
  for (let b = 0; b < P / 2; b++) baseLines.push({ pts: seg([xB(b), yBlade + 0.12, 0], [0, yCab - 0.2, 0]), c: L(2) });
  baseLines.push({ pts: seg([0, yCab + 0.25, 0], [0, ySuper - 0.2, 0]), c: L(3) });

  const pathLines: { pts: [number, number, number][]; c: string }[] = [];
  if (sel) {
    const p = sel.p;
    if (sel.t !== null) pathLines.push({ pts: seg([xT(p, sel.t), yThread + 0.12, 0], [xP(p), yProc - 0.12, 0]), c: THREAD_COLOR });
    else for (let t = 0; t < T; t++) pathLines.push({ pts: seg([xT(p, t), yThread + 0.12, 0], [xP(p), yProc - 0.12, 0]), c: THREAD_COLOR });
    pathLines.push({ pts: seg([xP(p), yProc + 0.12, 0], [xP(p), yNpu - 0.18, 0]), c: PROC_COLOR });
    pathLines.push({ pts: seg([xP(p), yNpu + 0.18, 0], [xB(bladeOf(p)), yBlade - 0.12, 0]), c: L(1) });
    pathLines.push({ pts: seg([xB(bladeOf(p)), yBlade + 0.12, 0], [0, yCab - 0.2, 0]), c: L(2) });
    pathLines.push({ pts: seg([0, yCab + 0.25, 0], [0, ySuper - 0.2, 0]), c: L(3) });
  }

  const rowLabel = (y: number, label: string, color: string) =>
    <Text position={[-3.8, y, 0]} fontSize={0.15} color={color} anchorX="right" anchorY="middle">{label}</Text>;

  return (
    <group>
      <Floor size={14} />

      {/* row labels (left) — hardware rows coloured by UB level, like topology */}
      {rowLabel(yThread, '线程 / Tile', THREAD_COLOR)}
      {rowLabel(yProc, '进程 rank', PROC_COLOR)}
      {rowLabel(yNpu, 'NPU', LC.text)}
      {rowLabel(yBlade, 'L1 刀片', L(1))}
      {rowLabel(yCab, 'L2 机柜', L(2))}
      {rowLabel(ySuper, 'L3 超节点', L(3))}

      {/* connectors */}
      {baseLines.map((ln, i) => <Line key={i} points={ln.pts} color={ln.c} lineWidth={1.2} transparent opacity={sel ? 0.15 : 0.4} />)}
      {pathLines.map((ln, i) => <Line key={'h' + i} points={ln.pts} color={ln.c} lineWidth={3} transparent opacity={0.95} />)}

      {/* THREAD row */}
      {Array.from({ length: P }, (_, p) => Array.from({ length: T }, (_, t) => {
        const on = tOn(p, t);
        return (
          <group key={`${p}-${t}`} position={[xT(p, t), yThread, 0]}
            onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`进程 ${p} · 线程/Tile ${t} = die 内 AI Core；点击定位 + 联动`); }}
            onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
            onClick={(e) => { e.stopPropagation(); pick(on && sel?.t === t ? null : { p, t }); }}
          >
            <Slab size={[0.22, 0.16, 0.22]} color={THREAD_COLOR} emissive={THREAD_COLOR} emissiveIntensity={on ? 0.95 : computeNow ? 0.7 : 0.3} />
          </group>
        );
      }))}
      {/* PROCESS row */}
      {Array.from({ length: P }, (_, p) => {
        const on = pOn(p);
        return (
          <group key={p} position={[xP(p), yProc, 0]}
            onPointerOver={(e) => { e.stopPropagation(); setCursor(true); onHoverInfo(`进程 rank ${p}（= NPU ${p}）· 集合通信走 UB；点击定位 + 联动`); }}
            onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
            onClick={(e) => { e.stopPropagation(); pick(on && sel?.t === null ? null : { p, t: null }); }}
          >
            <Slab size={[0.6, 0.2, 0.3]} color={on ? LC.hoverTint : LC.substrate} emissive={commNow ? COMM_PATTERNS[0].color : '#000000'} emissiveIntensity={commNow ? 0.4 : 0} edgeColor={on ? PROC_COLOR : LC.rackEdge} />
            <Text position={[0, 0, 0.18]} fontSize={0.11} color={on ? PROC_COLOR : LC.text} anchorX="center" anchorY="middle">{`rank ${p}`}</Text>
          </group>
        );
      })}
      {/* NPU row */}
      {Array.from({ length: P }, (_, p) => (
        <group key={p} position={[xP(p), yNpu, 0]}>
          <NpuChip w={0.42} h={0.24} hovered={pOn(p)} selected={pOn(p)} logo />
          <Text position={[0, 0.32, 0]} fontSize={0.09} color={LC.textDim} anchorX="center">{`NPU ${p}`}</Text>
        </group>
      ))}
      {/* BLADE row (L1) */}
      {Array.from({ length: P / 2 }, (_, b) => (
        <group key={b} position={[xB(b), yBlade, 0]}>
          <BladeTray w={0.9} d={0.5} hovered={bOn(b)} />
          <Text position={[0, 0.2, 0]} fontSize={0.11} color={L(1)} anchorX="center">{`刀片 B${b}`}</Text>
        </group>
      ))}
      {/* CABINET row (L2) */}
      <group position={[0, yCab - 0.1, 0]}>
        <CabinetBox w={0.5} h={0.5} d={0.25} kind="compute" hovered={upOn} />
        <Text position={[0, -0.18, 0]} fontSize={0.12} color={L(2)} anchorX="center">机柜 C0</Text>
      </group>
      {/* SUPERNODE row (L3) */}
      <group position={[0, ySuper, 0]}>
        <Slab size={[1.0, 0.3, 0.3]} color={L(3)} emissive={L(3)} emissiveIntensity={upOn ? 0.5 : 0.25} opacity={0.85} edgeColor={L(3)} />
        <Text position={[0, 0, 0.2]} fontSize={0.12} color={L(3)} anchorX="center" anchorY="middle">超节点</Text>
      </group>

      <Text position={[0, 0.02, 1.0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.16} color={LC.textDim} anchorX="center">
        {'线程/进程水平排布 · 硬件层级竖向（与 UB 互联一致）· 顶栏播放看时序 · 点击线程/进程定位+联动'}
      </Text>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Full-pod (multi-card) overview — every cabinet/blade/NPU + process/thread
//    rendered (no sampling), with full UB relationships + LLM-training collectives
// ═══════════════════════════════════════════════════════════════════════════

const FP_THREADS = 3;            // threads (AI-core groups) shown per NPU
const FP_CARDS_PER_BLADE = 8;   // = NPUS_PER_NODE
const FP_BLADES_PER_CAB = 8;    // = NODES_PER_CAB → 64 NPU / cabinet
const FP_CHIP_CAP = 64;         // ≤ this → individual textured NpuChip; beyond → instanced (texture-mapped)
const FP_MICRO_CAP = 1024;      // ≤ this → draw per-card thread/process fan-in lines
const FP_RING_CAP = 2048;       // ≤ this → draw the Ring-AllReduce loop
const FP_A2A_CAP = 64;          // per-supernode ≤ this → draw the All-to-All mesh (O(N²))

/** Full-pod (multi-card training) view. Lays out every card/process/thread of a
 *  small-pod (16P/32P/64P) — or the FULL super-node (gen.totalNpus, `full`) — as a
 *  nested 2-D array (card → blade → cabinet → super-node), with no overlap.
 *  Cards/processes/threads are InstancedMesh (matrices set once per layout); the
 *  hierarchy backbone is batched Lines. Dense per-card fan-in / collectives are
 *  capped so the full ~8 K-card super-node stays interactive. */
export function FullPodScene({ scale, podCount, full, gen, overlays, runMode, phase, partition, peers, status, onHoverInfo, onPick }: SceneCallbacks & {
  scale: Scale; podCount: number; full: boolean; gen: GenSpec; overlays: CommOverlays; runMode: RunMode; phase: RunPhase | null; partition: PartitionDim; peers: boolean; status: boolean; onPick?: (npuLocal: number) => void;
}) {
  const LC = useLC();
  const [hoverNpu, setHoverNpu] = useState<number | null>(null);
  const [sel, setSel] = useState<{ lv: number; i: number } | null>(null);   // selection: lv 0 card / 1 blade / 2 cabinet → highlight its up/down-stream + peer mesh
  const [focus, setFocus] = useState<number | null>(null);   // focused band index → highlight its downstream link
  const lastHov = useRef(-1);
  const cardInst = useRef<THREE.InstancedMesh>(null);
  const procRef = useRef<THREE.InstancedMesh>(null);
  const thrRef = useRef<THREE.InstancedMesh>(null);
  const bladeInst = useRef<THREE.InstancedMesh>(null);
  const cabInst = useRef<THREE.InstancedMesh>(null);
  const chipTex = useOptionalTexture(CHIP_TEX);

  const computeNow = phase?.kind === 'compute';   // AI cores / cards light up
  const commNow = phase?.kind === 'comm';         // ranks + the named collective light up
  const collective = phase?.collective ?? null;

  const G = useMemo(() => {
    const N1 = full ? gen.totalNpus : SCALES[scale].npus;   // cards per super-node
    // nested footprints (metres): card cell < blade gap < cabinet gap → no overlap
    const cpx = 0.46, cpz = 0.46;                           // card cell (card render ≈0.34 → 0.12 gap)
    const bw = 4 * cpx + 0.5, bd = 2 * cpz + 0.5;           // blade footprint (4×2 cards)
    const cw = 2 * bw + 0.9, cd = 4 * bd + 0.9;             // cabinet footprint (2×4 blades)
    const nBlades1 = Math.ceil(N1 / FP_CARDS_PER_BLADE);
    const nCabs1 = Math.ceil(nBlades1 / FP_BLADES_PER_CAB);
    const cCols = Math.ceil(Math.sqrt(nCabs1)), cRows = Math.ceil(nCabs1 / cCols);
    const superW = cCols * cw, superD = cRows * cd;
    const podPitch = superW + 2.2;
    const podX = (p: number) => (p - (podCount - 1) / 2) * podPitch;
    const cabCell = (c: number): [number, number] => [((c % cCols) - (cCols - 1) / 2) * cw, (Math.floor(c / cCols) - (cRows - 1) / 2) * cd];
    const bladeCell = (b: number): [number, number] => [((b % 2) - 0.5) * bw, (Math.floor(b / 2) - 1.5) * bd];
    const cardCell = (l: number): [number, number] => [((l % 4) - 1.5) * cpx, (Math.floor(l / 4) - 0.5) * cpz];

    const fieldW = Math.max(superW, podPitch * podCount);
    // band heights scale gently with field size so the tiers stay distinct when zoomed out
    const yStep = Math.min(1.5, 0.62 + Math.max(fieldW, superD) * 0.012);
    const yThread = 0.5, yProc = yThread + yStep, yCard = yProc + yStep;
    const yBlade = yCard + yStep, yCab = yBlade + yStep, ySuper = yCab + yStep, yCluster = ySuper + yStep;

    const cardX: number[] = [], cardZ: number[] = [], cardBlade: number[] = [];
    const bladeMX: number[] = [], bladeMZ: number[] = [], bladeCab: number[] = [];
    const cabMX: number[] = [], cabMZ: number[] = [], cabSuper: number[] = [];
    const superMX: number[] = [];
    let bIdx = -1, cIdx = -1;
    for (let p = 0; p < podCount; p++) {
      const px = podX(p);
      for (let cab = 0; cab < nCabs1; cab++) {
        const [cx, cz] = cabCell(cab);
        cIdx++; cabMX.push(px + cx); cabMZ.push(cz); cabSuper.push(p);
        for (let bl = 0; bl < FP_BLADES_PER_CAB; bl++) {
          const blade = cab * FP_BLADES_PER_CAB + bl;
          if (blade >= nBlades1) break;
          const [bx, bz] = bladeCell(bl);
          bIdx++; bladeMX.push(px + cx + bx); bladeMZ.push(cz + bz); bladeCab.push(cIdx);
          for (let l = 0; l < FP_CARDS_PER_BLADE; l++) {
            const kk = blade * FP_CARDS_PER_BLADE + l;
            if (kk >= N1) break;
            const [lx, lz] = cardCell(l);
            cardX.push(px + cx + bx + lx); cardZ.push(cz + bz + lz); cardBlade.push(bIdx);
          }
        }
      }
      superMX.push(px);
    }
    const N = cardX.length;

    // connectors (backbone always full; dense per-card / collectives capped)
    const thrPitch = 0.12;
    const drawMicro = N <= FP_MICRO_CAP;
    const t2p: [number, number, number][] = [], p2c: [number, number, number][] = [];
    const c2b: [number, number, number][] = [], b2c: [number, number, number][] = [], c2s: [number, number, number][] = [], s2cl: [number, number, number][] = [];
    for (let k = 0; k < N; k++) {
      const x = cardX[k], z = cardZ[k], b = cardBlade[k];
      c2b.push([x, yCard, z], [bladeMX[b], yBlade, bladeMZ[b]]);
      if (drawMicro) {
        for (let t = 0; t < FP_THREADS; t++) t2p.push([x + (t - (FP_THREADS - 1) / 2) * thrPitch, yThread, z], [x, yProc, z]);
        p2c.push([x, yProc, z], [x, yCard, z]);
      }
    }
    for (let b = 0; b < bladeMX.length; b++) { const c = bladeCab[b]; b2c.push([bladeMX[b], yBlade, bladeMZ[b]], [cabMX[c], yCab, cabMZ[c]]); }
    for (let c = 0; c < cabMX.length; c++) { const p = cabSuper[c]; c2s.push([cabMX[c], yCab, cabMZ[c]], [superMX[p], ySuper, 0]); }
    if (podCount > 1) for (let p = 0; p < podCount; p++) s2cl.push([superMX[p], ySuper, 0], [0, yCluster, 0]);

    const ring: [number, number, number][] = [];
    if (N <= FP_RING_CAP) for (let k = 0; k < N; k++) ring.push([cardX[k], yProc, cardZ[k]], [cardX[(k + 1) % N], yProc, cardZ[(k + 1) % N]]);
    const a2a: [number, number, number][] = [];
    if (N1 <= FP_A2A_CAP) for (let p = 0; p < podCount; p++) { const base = p * N1; for (let i = 0; i < N1; i++) for (let j = i + 1; j < N1; j++) a2a.push([cardX[base + i], yProc, cardZ[base + i]], [cardX[base + j], yProc, cardZ[base + j]]); }

    // hierarchical (marker-level) collectives — these scale to the full super-node:
    //   cabRing = inter-cabinet Ring-AllReduce (L3) · cabA2A = cabinet-level All-to-All (MoE EP)
    const cabRing: [number, number, number][] = [], cabA2A: [number, number, number][] = [];
    for (let p = 0; p < podCount; p++) {
      for (let i = 0; i < nCabs1; i++) { const c = p * nCabs1 + i, cn = p * nCabs1 + ((i + 1) % nCabs1); cabRing.push([cabMX[c], yCab, cabMZ[c]], [cabMX[cn], yCab, cabMZ[cn]]); }
      if (nCabs1 <= 200) for (let i = 0; i < nCabs1; i++) for (let j = i + 1; j < nCabs1; j++) { const a = p * nCabs1 + i, b = p * nCabs1 + j; cabA2A.push([cabMX[a], yCab, cabMZ[a]], [cabMX[b], yCab, cabMZ[b]]); }
    }

    // same-level peer links (direct card↔card / node↔node UB connections):
    //   l1mesh = L1 board mesh (the 8 NPU of a blade are directly UB-connected)
    //   l2mesh = L2 cabinet mesh (the 8 nodes of a cabinet are full-mesh at the blade level)
    const l1mesh: [number, number, number][] = [], l2mesh: [number, number, number][] = [];
    const peerL1 = N <= 16384;   // card-level mesh is dense → cap (keep node mesh beyond)
    if (peerL1) for (let bi = 0; bi < bladeMX.length; bi++) { const base = bi * FP_CARDS_PER_BLADE; for (let i = 0; i < FP_CARDS_PER_BLADE; i++) for (let j = i + 1; j < FP_CARDS_PER_BLADE; j++) { const a = base + i, b = base + j; if (b >= N) break; l1mesh.push([cardX[a], yCard, cardZ[a]], [cardX[b], yCard, cardZ[b]]); } }
    { const byCab: number[][] = Array.from({ length: cabMX.length }, () => []); for (let bi = 0; bi < bladeMX.length; bi++) byCab[bladeCab[bi]].push(bi); for (const bl of byCab) for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) { const a = bl[i], b = bl[j]; l2mesh.push([bladeMX[a], yBlade, bladeMZ[a]], [bladeMX[b], yBlade, bladeMZ[b]]); } }

    return {
      N, N1, nBlades: bladeMX.length, nCabs: cabMX.length, superMX, cluster: [0, yCluster, 0] as [number, number, number],
      cardX, cardZ, cardBlade, bladeMX, bladeMZ, bladeCab, cabMX, cabMZ, cabSuper, thrPitch, drawMicro,
      yThread, yProc, yCard, yBlade, yCab, ySuper, yCluster,
      t2p, p2c, c2b, b2c, c2s, s2cl, ring, a2a, cabRing, cabA2A, l1mesh, l2mesh, peerL1, fieldW, fieldD: superD, superW, cw, cd,
    };
  }, [scale, podCount, full, gen.totalNpus]);

  const podOf = (k: number) => Math.floor(k / G.N1);
  const useChip = G.N <= FP_CHIP_CAP;   // textured NpuChip per card at small counts; else instanced
  const cardW = 0.34, cardH = 0.075;

  // model-parallel decomposition mapped onto the physical hierarchy (TP=blade, PP/DP=replicas, EP=cabinet)
  const part = useMemo(() => {
    const nB1 = Math.max(1, Math.round(G.nBlades / podCount));   // blades per super-node
    const TP = FP_CARDS_PER_BLADE, PP = Math.min(16, nB1), DP = Math.max(1, Math.round(nB1 / PP));
    const groupOf = (k: number): number => {
      const b = Math.floor(k / FP_CARDS_PER_BLADE);   // global blade index = TP group
      const lb = b % nB1;                             // blade within its super-node
      switch (partition) {
        case 'tp': return k % FP_CARDS_PER_BLADE;     // tensor slice (tp rank 0–7) within the node
        case 'pp': return lb % PP;                    // pipeline stage within a model replica
        case 'dp': return Math.floor(lb / PP);        // data-parallel replica
        case 'ep': return G.bladeCab[b];              // experts grouped per cabinet (All-to-All domain)
        default:   return 0;
      }
    };
    return { TP, PP, DP, groupOf, cfg: `TP${TP}×PP${PP}×DP${DP}` };
  }, [G, podCount, partition]);

  // matrices + base colours (set once per layout — NOT per hover/phase)
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), col = new THREE.Color();
    const nm = cardInst.current;
    if (nm && !useChip) { col.set(chipTex ? '#ffffff' : LC.npuTop); for (let k = 0; k < G.N; k++) { m.makeScale(cardW, cardH, cardW); m.setPosition(G.cardX[k], G.yCard, G.cardZ[k]); nm.setMatrixAt(k, m); nm.setColorAt(k, col); } nm.count = G.N; nm.instanceMatrix.needsUpdate = true; if (nm.instanceColor) nm.instanceColor.needsUpdate = true; }
    const pm = procRef.current;
    if (pm) { col.set(PROC_COLOR); for (let k = 0; k < G.N; k++) { m.makeScale(0.14, 0.14, 0.14); m.setPosition(G.cardX[k], G.yProc, G.cardZ[k]); pm.setMatrixAt(k, m); pm.setColorAt(k, col); } pm.count = G.N; pm.instanceMatrix.needsUpdate = true; if (pm.instanceColor) pm.instanceColor.needsUpdate = true; }
    const tm = thrRef.current;
    if (tm) { col.set(THREAD_COLOR); for (let k = 0; k < G.N; k++) for (let t = 0; t < FP_THREADS; t++) { const idx = k * FP_THREADS + t; m.makeScale(0.045, 0.045, 0.045); m.setPosition(G.cardX[k] + (t - (FP_THREADS - 1) / 2) * G.thrPitch, G.yThread, G.cardZ[k]); tm.setMatrixAt(idx, m); tm.setColorAt(idx, col); } tm.count = G.N * FP_THREADS; tm.instanceMatrix.needsUpdate = true; if (tm.instanceColor) tm.instanceColor.needsUpdate = true; }
    const bm = bladeInst.current;
    if (bm) { col.set(LC.bladeBase); for (let b = 0; b < G.nBlades; b++) { m.makeScale(0.42, 0.08, 0.3); m.setPosition(G.bladeMX[b], G.yBlade, G.bladeMZ[b]); bm.setMatrixAt(b, m); bm.setColorAt(b, col); } bm.count = G.nBlades; bm.instanceMatrix.needsUpdate = true; if (bm.instanceColor) bm.instanceColor.needsUpdate = true; }
    const cm = cabInst.current;
    if (cm) { col.set(LC.cabBase); for (let c = 0; c < G.nCabs; c++) { m.makeScale(Math.min(2.2, G.cw * 0.5), 0.1, Math.min(2.2, G.cd * 0.4)); m.setPosition(G.cabMX[c], G.yCab, G.cabMZ[c]); cm.setMatrixAt(c, m); cm.setColorAt(c, col); } cm.count = G.nCabs; cm.instanceMatrix.needsUpdate = true; if (cm.instanceColor) cm.instanceColor.needsUpdate = true; }
  }, [G, useChip, chipTex]);

  // phase wash + selection highlight: compute → AI cores / cards heat; comm → ranks pulse;
  // partition → group colour on card/rank/thread; selection → the actual chain objects glow amber.
  useLayoutEffect(() => {
    const col = new THREE.Color(), procBase = new THREE.Color(PROC_COLOR), thrBase = new THREE.Color(THREAD_COLOR), hl = new THREE.Color('#ffb020');
    const tint = phase ? new THREE.Color(phase.color) : null;
    const cardBase = chipTex ? '#ffffff' : LC.npuTop;
    const pm = procRef.current, tm = thrRef.current, nm = cardInst.current, bm = bladeInst.current, cm = cabInst.current;
    const onPart = partition !== 'none';
    const pcol = (g: number) => PARTITION_PALETTE[g % PARTITION_PALETTE.length];
    // live status colours (priority over partition): card = current activity, rank = comm, thread = compute
    const sCard = phase ? STATUS_COLORS[phase.kind] : STATUS_COLORS.idle;
    const sProc = commNow ? STATUS_COLORS.comm : STATUS_COLORS.idle;
    const sThr = computeNow ? STATUS_COLORS.compute : STATUS_COLORS.idle;
    if (pm) for (let k = 0; k < G.N; k++) { if (status) col.set(sProc); else if (onPart) col.set(pcol(part.groupOf(k))); else { col.copy(procBase); if (commNow && tint) col.lerp(tint, 0.7); } pm.setColorAt(k, col); }
    if (tm) for (let i = 0; i < G.N * FP_THREADS; i++) { if (status) col.set(sThr); else if (onPart) col.set(pcol(part.groupOf(Math.floor(i / FP_THREADS)))); else { col.copy(thrBase); if (computeNow && tint) col.lerp(tint, 0.7); } tm.setColorAt(i, col); }
    if (nm && !useChip) for (let k = 0; k < G.N; k++) { if (k === lastHov.current) continue; if (status) col.set(sCard); else if (onPart) col.set(pcol(part.groupOf(k))); else { col.set(cardBase); if (computeNow && tint) col.lerp(tint, 0.34); } nm.setColorAt(k, col); }
    if (bm) for (let b = 0; b < G.nBlades; b++) { if (onPart && partition !== 'tp') col.set(pcol(part.groupOf(b * FP_CARDS_PER_BLADE))); else col.set(LC.bladeBase); bm.setColorAt(b, col); }
    if (cm) for (let c = 0; c < G.nCabs; c++) cm.setColorAt(c, col.set(LC.cabBase));
    // selection → light up the actual objects on the chain (cards + ranks + threads + blade/cabinet markers)
    if (sel) {
      const cardsH: number[] = [], bladesH: number[] = [], cabsH: number[] = [];
      const addBlade = (b: number) => { bladesH.push(b); for (let i = 0; i < FP_CARDS_PER_BLADE; i++) { const k = b * FP_CARDS_PER_BLADE + i; if (k < G.N) cardsH.push(k); } };
      if (sel.lv === 0 && sel.i < G.N) { const k = sel.i, b = G.cardBlade[k]; cardsH.push(k); bladesH.push(b); cabsH.push(G.bladeCab[b]); }
      else if (sel.lv === 1 && sel.i < G.nBlades) { addBlade(sel.i); cabsH.push(G.bladeCab[sel.i]); }
      else if (sel.lv === 2 && sel.i < G.nCabs) { cabsH.push(sel.i); for (let b = 0; b < G.nBlades; b++) if (G.bladeCab[b] === sel.i) addBlade(b); }
      if (nm && !useChip) for (const k of cardsH) nm.setColorAt(k, hl);
      if (pm) for (const k of cardsH) pm.setColorAt(k, hl);
      if (tm) for (const k of cardsH) for (let t = 0; t < FP_THREADS; t++) tm.setColorAt(k * FP_THREADS + t, hl);
      if (bm) for (const b of bladesH) bm.setColorAt(b, hl);
      if (cm) for (const c of cabsH) cm.setColorAt(c, hl);
    }
    if (pm?.instanceColor) pm.instanceColor.needsUpdate = true;
    if (tm?.instanceColor) tm.instanceColor.needsUpdate = true;
    if (nm?.instanceColor) nm.instanceColor.needsUpdate = true;
    if (bm?.instanceColor) bm.instanceColor.needsUpdate = true;
    if (cm?.instanceColor) cm.instanceColor.needsUpdate = true;
  }, [G, phase, computeNow, commNow, useChip, chipTex, partition, part, sel, status]);

  // imperative single-instance hover for the instanced-card path (avoids 8 K-loop per move)
  const hoverCard = (k: number | null) => {
    const nm = cardInst.current; if (!nm || useChip) return;
    const m = new THREE.Matrix4(), col = new THREE.Color(), prev = lastHov.current;
    const put = (i: number, on: boolean) => { m.makeScale(on ? cardW * 1.5 : cardW, on ? cardH * 1.8 : cardH, on ? cardW * 1.5 : cardW); m.setPosition(G.cardX[i], G.yCard, G.cardZ[i]); nm.setMatrixAt(i, m); nm.setColorAt(i, col.set(on ? '#bdf0cf' : chipTex ? '#ffffff' : LC.npuTop)); };
    if (prev >= 0 && prev !== k && prev < G.N) put(prev, false);
    if (k !== null) put(k, true);
    lastHov.current = k ?? -1;
    nm.instanceMatrix.needsUpdate = true; if (nm.instanceColor) nm.instanceColor.needsUpdate = true;
  };

  const toggleSel = (lv: number, i: number) => setSel((s) => (s && s.lv === lv && s.i === i ? null : { lv, i }));   // single-click select at a level
  useEffect(() => { setSel(null); }, [G]);   // drop stale selection when the layout changes

  // trace the selection's up/down-stream chain (vertical) + its same-level peer mesh (horizontal).
  // lv 0 = card · lv 1 = blade (board) · lv 2 = cabinet (node mesh).
  const selPath = useMemo(() => {
    if (!sel) return null;
    const cPos = (k: number): [number, number, number] => [G.cardX[k], G.yCard, G.cardZ[k]];
    const pPos = (k: number): [number, number, number] => [G.cardX[k], G.yProc, G.cardZ[k]];
    const bPos = (b: number): [number, number, number] => [G.bladeMX[b], G.yBlade, G.bladeMZ[b]];
    const caPos = (c: number): [number, number, number] => [G.cabMX[c], G.yCab, G.cabMZ[c]];
    const sPos = (p: number): [number, number, number] => [G.superMX[p], G.ySuper, 0];
    const vSegs: [number, number, number][] = [], pSegs: [number, number, number][] = [], cards: number[] = [];
    const bladeCards = (b: number): number[] => { const base = b * FP_CARDS_PER_BLADE, r: number[] = []; for (let i = 0; i < FP_CARDS_PER_BLADE; i++) if (base + i < G.N) r.push(base + i); return r; };
    const down = (k: number) => { for (let t = 0; t < FP_THREADS; t++) vSegs.push([G.cardX[k] + (t - (FP_THREADS - 1) / 2) * G.thrPitch, G.yThread, G.cardZ[k]], pPos(k)); vSegs.push(pPos(k), cPos(k)); cards.push(k); };
    const meshPairs = (xs: number[], f: (x: number) => [number, number, number]) => { for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) pSegs.push(f(xs[i]), f(xs[j])); };
    let dieK: number | null = null, label = '', labelPos: [number, number, number] = [0, 0, 0], superP = 0;
    const upFromCab = (c: number) => { superP = G.cabSuper[c]; vSegs.push(caPos(c), sPos(superP)); if (podCount > 1) vSegs.push(sPos(superP), G.cluster); };

    if (sel.lv === 0) {
      const k = sel.i; if (k >= G.N) return null;
      const b = G.cardBlade[k], c = G.bladeCab[b];
      down(k); vSegs.push(cPos(k), bPos(b), bPos(b), caPos(c)); upFromCab(c);
      meshPairs([k, ...bladeCards(b).filter((j) => j !== k)], cPos);   // card k ↔ its blade-mates (L1 board mesh)
      dieK = k; label = `NPU ${k}`; labelPos = cPos(k);
    } else if (sel.lv === 1) {
      const b = sel.i; if (b >= G.nBlades) return null;
      const c = G.bladeCab[b], ks = bladeCards(b);
      for (const k of ks) { down(k); vSegs.push(cPos(k), bPos(b)); }
      vSegs.push(bPos(b), caPos(c)); upFromCab(c);
      meshPairs(ks, cPos);   // L1 board mesh: all 8 cards card↔card
      label = `刀片 B${b} · ${ks.length}×NPU`; labelPos = bPos(b);
    } else {
      const c = sel.i; if (c >= G.nCabs) return null;
      const blades: number[] = [];
      for (let b = 0; b < G.nBlades; b++) if (G.bladeCab[b] === c) blades.push(b);
      for (const b of blades) { const ks = bladeCards(b); for (const k of ks) { down(k); vSegs.push(cPos(k), bPos(b)); } vSegs.push(bPos(b), caPos(c)); meshPairs(ks, cPos); }
      meshPairs(blades, bPos);   // L2 node mesh: blade↔blade within the cabinet
      upFromCab(c); label = `机柜 C${c} · ${blades.length} 刀片`; labelPos = caPos(c);
    }
    return { vSegs, pSegs, cards, superP, dieK, label, labelPos };
  }, [sel, G, podCount]);

  // die-inset callout placement: left of the field, scaled to the field size so it stays readable
  const dieS = Math.min(4, Math.max(1.1, G.fieldW * 0.05));
  const dieInsetPos: [number, number, number] = [-G.fieldW / 2 - DIE.w * 0.55 * dieS - 1.2, G.yCard + 1.8 * dieS, -G.fieldD / 2 - 0.5];

  // status overlay: which band's links carry the current phase's traffic + the status colour
  const statKind = phase?.kind ?? null;
  const statCol = statKind ? STATUS_COLORS[statKind] : STATUS_COLORS.idle;
  const linkActive = (band: number): boolean => {
    if (!statKind) return false;
    if (statKind === 'compute') return band <= 3;                                   // thread→proc→card→blade compute fan
    if (statKind === 'comm') return collective === 'a2a' ? band === 4 || band === 5 : band === 5 || band === 6;
    return band === 2;                                                              // load/store/mem → memory access
  };
  // connector. status mode → colour by link state, thickness ∝ bandwidth (bw) with a flow surge on active links.
  const conn = (pts: [number, number, number][], color: string, upper: number, base = 1.2, bw = base) => pts.length > 0 && (
    status
      ? <Line points={pts} segments color={linkActive(upper) ? statCol : '#cbd2dc'} lineWidth={linkActive(upper) ? bw * 1.8 : bw * 0.7} transparent opacity={linkActive(upper) ? 0.95 : 0.22} />
      : <Line points={pts} segments color={color} lineWidth={focus === upper ? 3 : focus === null ? base : 0.5} transparent opacity={focus === upper ? 0.95 : focus === null ? 0.4 : 0.1} />
  );
  const xL = -G.fieldW / 2 - 0.9;
  const lblSize = Math.min(0.5, 0.16 + G.fieldW * 0.004);
  const bands: [number, number, string, string][] = [
    [0, G.yThread, '线程', THREAD_COLOR], [1, G.yProc, '进程 rank', PROC_COLOR], [2, G.yCard, 'L0 卡', L(0)],
    [3, G.yBlade, 'L1 节点', L(1)], [4, G.yCab, 'L2 机柜', L(2)], [5, G.ySuper, `L3 ${TOK.supernode}`, L(3)], [6, G.yCluster, 'L4 超节点间', L(4)],
  ];

  return (
    <group>
      <Floor size={Math.max(18, G.fieldW + 6, G.fieldD + 6)} />
      {/* clickable band labels (focus → highlight that band's downstream connector) */}
      {bands.map(([i, y, t, c]) => (
        (i < 6 || podCount > 1) && (
          <Text key={i} position={[xL, y, -G.fieldD / 2]} fontSize={lblSize} color={focus === i ? c : LC.textDim} anchorX="right" anchorY="middle"
            onClick={(e) => { e.stopPropagation(); setFocus((f) => (f === i ? null : i)); }}
            onPointerOver={() => setCursor(true)} onPointerOut={() => setCursor(false)}>{t}</Text>
        )
      ))}

      {/* hierarchy backbone (downstream of band f is highlighted when focus===f) */}
      {/* bw (5th arg) = relative bandwidth → thickness in status mode: intra-node fattest, scale-out thinnest */}
      {conn(G.t2p, THREAD_COLOR, 1, 0.7, 0.8)}
      {conn(G.p2c, PROC_COLOR, 2, 0.9, 1.1)}
      {conn(G.c2b, L(1), 3, 0.8, 2.4)}
      {conn(G.b2c, L(2), 4, commNow ? 2 : 1.1, 1.8)}
      {conn(G.c2s, L(3), 5, commNow ? 3 : 1.4, 1.3)}
      {conn(G.s2cl, L(4), 6, commNow ? 3.6 : 2.4, 0.9)}

      {/* same-level peer mesh — direct UB links: L1 card↔card (board) + L2 node↔node (cabinet).
          These are physically small (within a blade / cabinet) — click a card/blade/cabinet to light its local mesh. */}
      {peers && G.l1mesh.length > 0 && <Line points={G.l1mesh} segments color={status ? (computeNow ? statCol : '#cbd2dc') : L(1)} lineWidth={status ? (computeNow ? 2.6 : 1.1) : 1.4} transparent opacity={status ? (computeNow ? 0.85 : 0.28) : (focus === null ? 0.62 : 0.16)} />}
      {peers && G.l2mesh.length > 0 && <Line points={G.l2mesh} segments color={status ? (commNow && collective === 'a2a' ? statCol : '#cbd2dc') : L(2)} lineWidth={status ? (commNow && collective === 'a2a' ? 2.2 : 1.1) : 1.4} transparent opacity={status ? (commNow && collective === 'a2a' ? 0.85 : 0.3) : (focus === null ? 0.6 : 0.2)} />}

      {/* L1 blade + L2 cabinet markers (instanced) — clickable to highlight their up/down-stream + peer mesh */}
      <instancedMesh ref={bladeInst} args={[undefined, undefined, Math.max(1, G.nBlades)]}
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); }}
        onPointerMove={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) onHoverInfo(`刀片 B${e.instanceId}（L1 节点） · ${FP_CARDS_PER_BLADE}×NPU · 单击高亮板载卡↔卡 mesh + 上下游`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) toggleSel(1, e.instanceId); }}>
        <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial metalness={0.3} roughness={0.55} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={cabInst} args={[undefined, undefined, Math.max(1, G.nCabs)]}
        onPointerOver={(e) => { e.stopPropagation(); setCursor(true); }}
        onPointerMove={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) onHoverInfo(`机柜 C${e.instanceId}（L2 机柜） · 单击高亮柜内节点↔节点 mesh + 上下游`); }}
        onPointerOut={() => { setCursor(false); onHoverInfo(null); }}
        onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) toggleSel(2, e.instanceId); }}>
        <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial metalness={0.3} roughness={0.55} toneMapped={false} />
      </instancedMesh>
      {/* L3 super-node + L4 cluster markers */}
      {G.superMX.map((sx, p) => {
        const on = selPath !== null && selPath.superP === p;
        return (
          <group key={p}>
            <Slab size={[Math.min(2.6, G.superW * 0.5), 0.22, 0.3]} position={[sx, G.ySuper, 0]} color={on ? '#ffb020' : L(3)} emissive={on ? '#ffb020' : L(3)} emissiveIntensity={on ? 0.9 : 0.5} />
            <Text position={[sx, G.ySuper + 0.32, 0]} fontSize={lblSize} color={on ? '#b45309' : L(3)} anchorX="center">{`${TOK.supernode} P${p}`}</Text>
          </group>
        );
      })}
      {podCount > 1 && <Slab size={[Math.min(3.4, G.fieldW * 0.4), 0.2, 0.3]} position={G.cluster} color={L(4)} emissive={L(4)} emissiveIntensity={0.4} opacity={0.85} edgeColor={L(4)} />}

      {/* L0 cards — individual textured NpuChip (≤cap) else instanced (texture-mapped) */}
      {useChip
        ? G.cardX.map((x, k) => (
          <group key={k} position={[x, G.yCard, G.cardZ[k]]}
            onPointerOver={(e) => { e.stopPropagation(); if (k === lastHov.current) return; lastHov.current = k; setHoverNpu(k); setCursor(true); onHoverInfo(`NPU ${k} · ${TOK.supernode} P${podOf(k)} · rank ${k} · 单击高亮链路+die实况 · 双击进入节点`); }}
            onPointerOut={() => { lastHov.current = -1; setHoverNpu(null); setCursor(false); onHoverInfo(null); }}
            onClick={(e) => { e.stopPropagation(); toggleSel(0, k); }}
            onDoubleClick={(e) => { e.stopPropagation(); onPick?.(k % 8); }}>
            <NpuChip w={0.34} h={0.18} hovered={hoverNpu === k} selected={hoverNpu === k || (selPath !== null && selPath.cards.includes(k))} logo />
          </group>
        ))
        : (
          <instancedMesh ref={cardInst} args={[undefined, undefined, Math.max(1, G.N)]}
            onPointerMove={(e) => { e.stopPropagation(); const k = e.instanceId; if (k === undefined || k === lastHov.current) return; hoverCard(k); setHoverNpu(k); onHoverInfo(`NPU ${k} · ${TOK.supernode} P${podOf(k)} · rank ${k} · 单击高亮链路+die实况 · 双击进入节点`); }}
            onPointerOut={() => { hoverCard(null); setHoverNpu(null); setCursor(false); onHoverInfo(null); }}
            onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) toggleSel(0, e.instanceId); }}
            onDoubleClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) onPick?.(e.instanceId % 8); }}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial map={chipTex ?? undefined} color={chipTex ? '#ffffff' : LC.npuTop} metalness={0.45} roughness={0.4} toneMapped={false} />
          </instancedMesh>
        )}

      {/* selection → peer mesh (cyan, same-level card↔card / node↔node) + up/down-stream chain (amber) + die inset (card only) */}
      {selPath && (
        <group>
          {/* the chain objects themselves glow amber (recoloured in the effect); here just the route + peer mesh */}
          {selPath.pSegs.length > 0 && <Line points={selPath.pSegs} segments color="#22d3ee" lineWidth={2.6} transparent opacity={0.95} />}
          {selPath.vSegs.length > 0 && <Line points={selPath.vSegs} segments color="#ffb020" lineWidth={3} transparent opacity={0.92} />}
          {selPath.dieK !== null ? (
            <group>
              {/* die-operator inset for a selected card (reuses DieDetail), with a leader line */}
              <Line points={[[G.cardX[selPath.dieK], G.yCard, G.cardZ[selPath.dieK]], dieInsetPos]} color="#ffb020" lineWidth={1.6} transparent opacity={0.6} />
              <group position={dieInsetPos} scale={dieS}>
                <group position={[-DIE.pos[0], -DIE.pos[1], -DIE.pos[2]]}>
                  <DieDetail npuIdx={selPath.dieK % 8} overlays={overlays} onHoverInfo={onHoverInfo} />
                </group>
              </group>
              <Text position={[dieInsetPos[0], dieInsetPos[1] + DIE.d * 0.62 * dieS + 0.25, dieInsetPos[2]]} fontSize={Math.min(0.5, 0.12 * dieS)} color="#b45309" anchorX="center">
                {`NPU ${selPath.dieK} · ${runMode === 'train' ? '训练' : '推理'}${phase ? '·' + phase.name.split(' ')[0] : ''} · die 算子实况`}
              </Text>
            </group>
          ) : (
            <Text position={[selPath.labelPos[0], selPath.labelPos[1] + 0.5, selPath.labelPos[2]]} fontSize={lblSize} color="#b45309" anchorX="center" anchorY="bottom">{selPath.label}</Text>
          )}
        </group>
      )}

      {/* process + thread (instanced, shared colours) */}
      <instancedMesh ref={procRef} args={[undefined, undefined, Math.max(1, G.N)]}>
        <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial metalness={0.3} roughness={0.5} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={thrRef} args={[undefined, undefined, Math.max(1, G.N * FP_THREADS)]}>
        <sphereGeometry args={[1, 8, 8]} /><meshStandardMaterial metalness={0.2} roughness={0.5} toneMapped={false} />
      </instancedMesh>

      {/* collectives: hierarchical marker-level flows (scale-independent) + rank-level (small N).
          Toggle-driven, or auto-driven by the current comm phase's collective. */}
      {(overlays.ring || (commNow && collective === 'ring')) && (
        <group>
          {G.cabRing.length > 0 && <FlowLine points={G.cabRing} color={COMM_PATTERNS[0].color} width={commNow ? 3.2 : 2} speed={commNow ? 2.6 : 1.2} />}
          {commNow && G.c2s.length > 0 && <FlowLine points={G.c2s} color={COMM_PATTERNS[0].color} width={1.8} speed={2.2} opacity={0.8} />}
          {G.ring.length > 0 && <FlowLine points={G.ring} color={COMM_PATTERNS[0].color} width={commNow ? 3.6 : 2.4} speed={commNow ? 3 : 1.2} />}
        </group>
      )}
      {(overlays.a2a || (commNow && collective === 'a2a')) && (
        <group>
          {G.cabA2A.length > 0 && <Line points={G.cabA2A} segments color={COMM_PATTERNS[1].color} lineWidth={1} transparent opacity={commNow ? 0.4 : 0.16} />}
          {G.a2a.length > 0 && <Line points={G.a2a} segments color={COMM_PATTERNS[1].color} lineWidth={1} transparent opacity={commNow ? 0.5 : 0.2} />}
        </group>
      )}

      <Text position={[0, 0.04, G.fieldD / 2 + 1.4]} rotation={[-Math.PI / 2, 0, 0]} fontSize={Math.min(0.6, 0.2 + G.fieldW * 0.003)} color={LC.textDim} anchorX="center">
        {`${full ? `全量${TOK.supernode}` : SCALES[scale].label} × ${podCount} · ${G.N.toLocaleString()} NPU · ${G.nBlades.toLocaleString()} 刀片 · ${G.nCabs.toLocaleString()} 机柜 · 单击卡高亮上下游 · 双击进入节点${peers && !G.peerL1 ? ' · L1卡间mesh过密(暂隐)' : ''}${partition !== 'none' ? ` · 切分 ${part.cfg}（按 ${partition.toUpperCase()} 上色）` : ''}${phase ? ` · ${runMode === 'train' ? '训练' : '推理'}：${phase.name}` : ' · ▶ 运行'}`}
      </Text>
    </group>
  );
}
