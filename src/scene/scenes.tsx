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
import { Suspense, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { Text as DreiText, Edges } from '@react-three/drei';
import * as THREE from 'three';
import {
  RACK_DIM, COMPUTE_RACK_UNITS, SWITCH_RACK_UNITS,
  NODE_DIM, NODE_PARTS, DIES_PER_NPU, NPUS_PER_NODE,
  UB_LEVELS, COMM_PATTERNS, RACK_COLORS,
  buildHall, CAB_W, CAB_H, CAB_D,
  type RackKind, type RackUnit, type NodePart, type GenSpec, type CabinetCell,
} from './data';
import { TOK } from '../content';

// ─── Light-theme palette ─────────────────────────────────────────────────────
const LC = {
  primary:     '#4369ef',
  rackBody:    '#e8ebf1',
  rackDoor:    '#dde1e9',
  rackEdge:    '#aab4c4',
  rackEdgeHov: '#4369ef',
  text:        '#1c2433',
  textDim:     '#6b7890',
  nodeUnit:    '#f2f4f8',
  powerUnit:   '#e9edf3',
  mgmtUnit:    '#e6eaf1',
  switchUnit:  '#edf0f5',
  cduUnit:     '#e2e7ee',
  pcb:         '#bcd2c4',
  npuBody:     '#e4e8ef',
  npuTop:      '#aeb8c6',
  cpuBody:     '#e1e7ea',
  cpuTop:      '#b2c6c0',
  ubBody:      '#e8ebf1',
  dpuBody:     '#e3e8f2',
  opticalBody: '#dde3ec',
  dimmBody:    '#e0e5ee',
  metal:       '#c4cad4',
  vent:        '#9aa4b2',
} as const;

const L = (i: number) => UB_LEVELS[i].color;       // UB level colour shortcut

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
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#f0f1f4" roughness={0.95} metalness={0.05} />
      </mesh>
      <gridHelper args={[size, size * 2, '#d0d5dd', '#e1e4ea']} position={[0, 0.001, 0]} />
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Overview: data-hall floor (compute grid + comms block)
// ═══════════════════════════════════════════════════════════════════════════

function HallCabinet({ cell, hovered, onClick, onHover }: {
  cell: CabinetCell; hovered: boolean; onClick: () => void; onHover: (h: boolean) => void;
}) {
  const isCompute = cell.kind === 'compute';
  const glow = isCompute ? RACK_COLORS.computeGlow : RACK_COLORS.switchGlow;
  return (
    <group
      position={cell.pos}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); setCursor(true); }}
      onPointerOut={() => { onHover(false); setCursor(false); }}
    >
      <Slab
        size={[CAB_W, CAB_H, CAB_D]} position={[0, CAB_H / 2, 0]}
        color={hovered ? '#dbe4fb' : LC.rackBody} metalness={0.5} roughness={0.5}
        edgeColor={hovered ? LC.rackEdgeHov : LC.rackEdge}
      />
      {/* top status strip = cabinet kind */}
      <Slab
        size={[CAB_W * 0.78, 0.03, CAB_D * 0.7]} position={[0, CAB_H + 0.02, 0]}
        color={glow} emissive={glow} emissiveIntensity={hovered ? 1.1 : 0.5}
      />
    </group>
  );
}

/** Schematic UB optical spine: arcs from compute block to comms block. */
function HallSpine({ cells }: { cells: CabinetCell[] }) {
  const geo = useMemo(() => {
    const compute = cells.filter((c) => c.kind === 'compute');
    const comms = cells.filter((c) => c.kind === 'switch');
    if (!compute.length || !comms.length) return [];
    const cFrontZ = Math.max(...compute.map((c) => c.pos[2]));   // compute rear edge
    const sFrontZ = Math.min(...comms.map((c) => c.pos[2]));     // comms front edge
    const out: THREE.TubeGeometry[] = [];
    const cols = 16;
    for (let i = 0; i < cols; i++) {
      const x = (i - (cols - 1) / 2) * (CAB_W + 0.12);
      const a = new THREE.Vector3(x, CAB_H + 0.05, cFrontZ);
      const b = new THREE.Vector3(x, CAB_H + 0.05, sFrontZ);
      const mid = new THREE.Vector3(x, CAB_H + 0.9, (cFrontZ + sFrontZ) / 2);
      out.push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 20, 0.01, 5));
    }
    return out;
  }, [cells]);
  return (
    <group>
      {geo.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshBasicMaterial color={L(3)} transparent opacity={0.4} />
        </mesh>
      ))}
    </group>
  );
}

export function OverviewScene({ gen, onHoverInfo, onSelectRack }: SceneCallbacks & {
  gen: GenSpec; onSelectRack: (kind: RackKind) => void;
}) {
  const cells = useMemo(() => buildHall(gen), [gen]);
  const [hoverId, setHoverId] = useState<string | null>(null);
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
          hovered={hoverId === cell.id}
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
      <HallSpine cells={cells} />
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

export function RackScene({ rackKind, label, onHoverInfo, onSelectNode }: SceneCallbacks & {
  rackKind: RackKind; label: string; onSelectNode: (slot: number) => void;
}) {
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
        {units.map((u) => (
          <RackUnitMesh
            key={u.id}
            unit={u}
            rackKind={rackKind}
            hovered={hoverId === u.id}
            clickable={u.type === 'node'}
            onClick={u.type === 'node' ? () => onSelectNode(u.nodeSlot!) : undefined}
            onHover={(h) => {
              setHoverId(h ? u.id : null);
              onHoverInfo(h ? `${u.label}${u.type === 'node' ? '（点击下钻查看刀片 + die/进程/线程级互联）' : ''}` : null);
            }}
          />
        ))}
      </group>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Compute node (blade) — static structure (die-level detail)
// ═══════════════════════════════════════════════════════════════════════════

const S_NODE = 3.2;   // node view scale

function NodePartMesh({ part, hovered, onHover }: {
  part: NodePart; hovered: boolean; onHover: (h: boolean) => void;
}) {
  const S = S_NODE;
  const [px, py, pz] = part.pos;
  const [sx, sy, sz] = part.size;

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
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); }}
      onPointerOut={() => onHover(false)}
    >
      <Slab size={[sx * S, sy * S, sz * S]} color={v.body} metalness={0.35} roughness={0.6} edgeColor={hovered ? v.edge : LC.rackEdge} />
      {/* NPU: render dies on top (L0 die-level) */}
      {part.type === 'npu' && (
        <group>
          {Array.from({ length: DIES_PER_NPU }, (_, d) => (
            <Slab
              key={d}
              size={[sx * S * 0.4, sy * S * 0.55, sz * S * 0.8]}
              position={[(d - (DIES_PER_NPU - 1) / 2) * sx * S * 0.46, sy * S * 0.6, 0]}
              color={L(0)}
              emissive={L(0)} emissiveIntensity={hovered ? 0.9 : 0.5}
              metalness={0.5} roughness={0.4}
            />
          ))}
          {/* die-to-die UB seam (L0) */}
          <Slab size={[0.006 * S, sy * S * 0.6, sz * S * 0.82]} position={[0, sy * S * 0.62, 0]} color={L(0)} emissive={L(0)} emissiveIntensity={0.9} />
        </group>
      )}
      {v.top && part.type !== 'npu' && (
        <Slab size={[sx * S * 0.82, sy * S * 0.5, sz * S * 0.82]} position={[0, sy * S * 0.62, 0]}
          color={v.top} metalness={part.type === 'ub-fabric' ? 0.3 : 0.85} roughness={part.type === 'ub-fabric' ? 0.5 : 0.3}
          emissive={part.type === 'ub-fabric' ? v.top : '#000000'} emissiveIntensity={part.type === 'ub-fabric' ? (hovered ? 0.9 : 0.4) : 0} />
      )}
      {part.type === 'optical' && (
        <group>
          {Array.from({ length: 14 }, (_, i) => (
            <Slab key={i} size={[0.028 * S, sy * S * 0.6, 0.008 * S]} position={[(i - 6.5) * 0.044 * S, 0, sz * S * 0.7]}
              color={LC.vent} emissive="#fbbf24" emissiveIntensity={hovered ? 0.8 : 0.3} />
          ))}
        </group>
      )}
      {(part.type === 'npu' || part.type === 'cpu') && (
        <Text position={[0, sy * S * 1.0, 0]} rotation={[-Math.PI / 2, 0, 0]} fontSize={part.type === 'npu' ? 0.06 : 0.045} color="#5a6478" anchorX="center" anchorY="middle">
          {part.type === 'npu' ? `${TOK.ascendEn} ${TOK.n950dt}` : `${TOK.kunpengEn} ${TOK.n950}`}
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

/** Process(rank) / thread-level comm overlays — rendered in the UB hierarchy view. */
export interface CommOverlays { ring: boolean; a2a: boolean; thread: boolean; }

export function NodeScene({ onHoverInfo }: SceneCallbacks) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const S = S_NODE;
  const w = NODE_DIM.w * S, h = NODE_DIM.h * S, d = NODE_DIM.d * S;

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
            onHover={(hv) => {
              setHoverId(hv ? p.id : null);
              onHoverInfo(hv ? p.label : null);
            }}
          />
        ))}
      </group>
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

export function TopologyScene({ gen, overlays, onHoverInfo }: SceneCallbacks & { gen: GenSpec; overlays: CommOverlays }) {
  const [hov, setHov] = useState<number | null>(null);

  // node-tier sample positions (8 NPU dots) for L0/L1 illustration
  const dieX = (i: number) => (i / 7 - 0.5) * 2.2;
  // rank dots at the L1 tier (one process / rank per NPU)
  const rankX = (i: number) => (i / 7 - 0.5) * 2.6;

  // ── process(rank) + thread comm overlays ──
  const ringGeo = useMemo(() => {
    const seg: number[] = [];
    const order = [0, 1, 2, 3, 7, 6, 5, 4];   // snake ring over the 2×4 rank grid
    const y = HT.y[1] + 0.18;
    for (let k = 0; k < order.length; k++) {
      const a = order[k], b = order[(k + 1) % order.length];
      seg.push(rankX(a), y, 0.16, rankX(b), y, 0.16);
    }
    return segGeo(seg);
  }, []);

  const a2aGeo = useMemo(() => {
    const seg: number[] = [];
    const y = HT.y[1] + 0.18;
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) seg.push(rankX(i), y, -0.16, rankX(j), y, -0.16);
    return segGeo(seg);
  }, []);

  const threadGeo = useMemo(() => {
    const seg: number[] = [];
    // per die at L0: small fan of AI-core / thread lines rising from the die
    for (let i = 0; i < 8; i++) {
      for (let d = 0; d < DIES_PER_NPU; d++) {
        const x = dieX(i) + (d - (DIES_PER_NPU - 1) / 2) * 0.11;
        for (let t = -2; t <= 2; t++) seg.push(x, HT.y[0] + 0.05, 0, x + t * 0.02, HT.y[0] + 0.32, 0.05 * (t % 2));
      }
    }
    return segGeo(seg);
  }, []);

  // counts text per level
  const levelInfo = (lvl: number): string => {
    switch (lvl) {
      case 0: return `L0 片内：${TOK.ascend} ${gen.npuShort} 封装内 ${DIES_PER_NPU} die · die 间 UB/SIO 直连 · ${UB_LEVELS[0].detail}`;
      case 1: return `L1 节点内：${NPUS_PER_NODE}× NPU 板载 UB 2D-Mesh 直连 · 单 NPU ${gen.chipUbTBs} TB/s`;
      case 2: return `L2 机柜内：8 节点 / 64 NPU 跨节点 ${TOK.fullmesh} 总线级直连`;
      case 3: return `L3 ${TOK.supernode}内：${gen.computeCabs} 计算柜 + ${gen.commCabs} 通信柜 Clos · ${gen.totalNpus} NPU 全互联 · ${gen.interconnectPBs} PB/s`;
      case 4: return `L4 ${TOK.supernode}间：${TOK.supercluster} scale-out · ${gen.superclusterNpu}卡（全光 UBoE）`;
      default: return '';
    }
  };

  // connecting lines between adjacent tiers, coloured by upper level
  const linkGeo = useMemo(() => {
    const seg: number[] = [];
    // L0→L1: 8 dies up to node bar
    for (let i = 0; i < 8; i++) seg.push(dieX(i), HT.y[0] + 0.1, 0, dieX(i), HT.y[1] - 0.05, 0);
    return segGeo(seg);
  }, []);

  const Tier = ({ lvl, children }: { lvl: number; children?: ReactNode }) => {
    const isH = hov === lvl;
    return (
      <group
        position={[0, HT.y[lvl], 0]}
        onPointerOver={(e) => { e.stopPropagation(); setHov(lvl); setCursor(true); onHoverInfo(levelInfo(lvl)); }}
        onPointerOut={() => { setHov(null); setCursor(false); onHoverInfo(null); }}
      >
        {children}
        <Text position={[-HT.xSpan / 2 - 0.3, 0, 0]} fontSize={0.2} color={isH ? L(lvl) : LC.textDim} anchorX="right" anchorY="middle" maxWidth={3}>
          {`${UB_LEVELS[lvl].id} ${UB_LEVELS[lvl].label}`}
        </Text>
        <Text position={[HT.xSpan / 2 + 0.3, 0, 0]} fontSize={0.16} color={isH ? L(lvl) : LC.textDim} anchorX="left" anchorY="middle" maxWidth={5}>
          {lvl === 3 ? `${gen.totalNpus} NPU · ${gen.interconnectPBs} PB/s` : lvl === 4 ? `${gen.superclusterNpu}卡` : lvl === 0 ? `${DIES_PER_NPU} die/pkg` : lvl === 1 ? `${NPUS_PER_NODE}× NPU` : '64 NPU/柜'}
        </Text>
      </group>
    );
  };

  return (
    <group>
      <Floor size={16} />

      {/* L0 — dies (8 NPU × dies) */}
      <Tier lvl={0}>
        {Array.from({ length: 8 }, (_, i) => (
          <group key={i} position={[dieX(i), 0, 0]}>
            {Array.from({ length: DIES_PER_NPU }, (_, dd) => (
              <Slab key={dd} size={[0.09, 0.09, 0.12]} position={[(dd - (DIES_PER_NPU - 1) / 2) * 0.11, 0, 0]} color={L(0)} emissive={L(0)} emissiveIntensity={hov === 0 ? 0.8 : 0.4} />
            ))}
          </group>
        ))}
      </Tier>
      <lineSegments geometry={linkGeo}><lineBasicMaterial color={L(1)} transparent opacity={0.5} /></lineSegments>

      {/* L1 — node bar with 8 NPU + 2D-mesh */}
      <Tier lvl={1}>
        <Slab size={[3.0, 0.14, 0.5]} color={'#e8ebf1'} edgeColor={hov === 1 ? L(1) : LC.rackEdge} />
        {Array.from({ length: 8 }, (_, i) => (
          <Slab key={i} size={[0.12, 0.16, 0.16]} position={[(i / 7 - 0.5) * 2.6, 0.05, 0]} color={L(1)} emissive={L(1)} emissiveIntensity={hov === 1 ? 0.8 : 0.4} />
        ))}
      </Tier>

      {/* L2 — rack-level full mesh: 8 node bars + all-pairs lines */}
      <Tier lvl={2}>
        {(() => {
          const N = 8, xs = Array.from({ length: N }, (_, i) => (i / (N - 1) - 0.5) * HT.xSpan * 0.78);
          const seg: number[] = [];
          for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) seg.push(xs[i], 0.02, 0.18, xs[j], 0.02, 0.18);
          return (
            <group>
              {xs.map((x, i) => (
                <Slab key={i} size={[0.5, 0.16, 0.34]} position={[x, 0, 0.18]} color={'#efe7fb'} edgeColor={hov === 2 ? L(2) : LC.rackEdge} />
              ))}
              <lineSegments geometry={segGeo(seg)}><lineBasicMaterial color={L(2)} transparent opacity={hov === 2 ? 0.85 : 0.4} /></lineSegments>
            </group>
          );
        })()}
      </Tier>

      {/* L3 — pod-level Clos: compute block + comms switch bar */}
      <Tier lvl={3}>
        <Slab size={[HT.xSpan * 0.9, 0.18, 0.55]} color={L(3)} opacity={hov === 3 ? 0.7 : 0.4} emissive={L(3)} emissiveIntensity={hov === 3 ? 0.4 : 0.18} />
        {Array.from({ length: 16 }, (_, i) => (
          <Slab key={i} size={[0.22, 0.3, 0.62]} position={[(i - 7.5) * (HT.xSpan * 0.9 / 16.5), 0, 0]} color={L(3)} emissive={L(3)} emissiveIntensity={hov === 3 ? 0.6 : 0.3} />
        ))}
      </Tier>

      {/* L4 — cluster scale-out */}
      <Tier lvl={4}>
        <Slab size={[HT.xSpan * 0.72, 0.14, 0.5]} color={L(4)} opacity={hov === 4 ? 0.7 : 0.38} emissive={L(4)} emissiveIntensity={hov === 4 ? 0.4 : 0.16} />
      </Tier>

      {/* tier-to-tier vertical connectors (L1..L4) */}
      {[1, 2, 3].map((lvl) => (
        <mesh key={lvl} position={[0, (HT.y[lvl] + HT.y[lvl + 1]) / 2, 0]}>
          <boxGeometry args={[0.04, HT.y[lvl + 1] - HT.y[lvl] - 0.3, 0.04]} />
          <meshBasicMaterial color={L(lvl + 1)} transparent opacity={0.5} />
        </mesh>
      ))}

      {/* ── process(rank) / thread comm overlays (toggled in toolbar) ── */}
      {overlays.thread && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`线程级：die 内 AI Core / 线程并行计算流（L0 片内）`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <lineSegments geometry={threadGeo}><lineBasicMaterial color={COMM_PATTERNS[2].color} transparent opacity={0.8} /></lineSegments>
          <Text position={[dieX(7) + 0.5, HT.y[0] + 0.3, 0]} fontSize={0.14} color={COMM_PATTERNS[2].color} anchorX="left">{COMM_PATTERNS[2].label}</Text>
        </group>
      )}
      {overlays.a2a && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`进程级 All-to-All（MoE 专家并行）：rank 间全互联，经 L1/L2 UB 直连 + L3 Clos`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <lineSegments geometry={a2aGeo}><lineBasicMaterial color={COMM_PATTERNS[1].color} transparent opacity={0.4} /></lineSegments>
          <Text position={[rankX(7) + 0.4, HT.y[1] + 0.18, -0.16]} fontSize={0.14} color={COMM_PATTERNS[1].color} anchorX="left">All-to-All</Text>
        </group>
      )}
      {overlays.ring && (
        <group
          onPointerOver={(e) => { e.stopPropagation(); onHoverInfo(`进程级 Ring-AllReduce（数据并行梯度规约）：rank 环形通信，沿 UB 2D-Mesh`); }}
          onPointerOut={() => onHoverInfo(null)}
        >
          <lineSegments geometry={ringGeo}><lineBasicMaterial color={COMM_PATTERNS[0].color} transparent opacity={0.9} /></lineSegments>
          <Text position={[rankX(7) + 0.4, HT.y[1] + 0.18, 0.16]} fontSize={0.14} color={COMM_PATTERNS[0].color} anchorX="left">Ring AllReduce</Text>
        </group>
      )}

      <Text position={[0, 0.04, 2.4]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.2} color={LC.textDim} anchorX="center">
        {`${TOK.ubmesh} 互联层级 · ${gen.code} ${gen.name} · 悬停查看各级带宽 · 顶栏开关叠加进程/线程级通信`}
      </Text>
    </group>
  );
}
