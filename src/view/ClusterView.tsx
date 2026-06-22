/**
 * ClusterView — interactive 3D model of a large-scale HPC pod (A5 / A6).
 *
 * Generation switch (A5 / A6) drives all specs. Drill-down: data-hall overview →
 * cabinet view → compute node, plus a UB interconnect-hierarchy view
 * (L0 die → L4 cluster scale-out). The node view can overlay die /
 * process(rank) / thread-level UB communication lines.
 *
 * Fully procedural modeling (no GLB). Display text with product/brand terms is
 * sourced from ../content (decoded at runtime); this file carries no plaintext
 * product names.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewcube } from '@react-three/drei';
import * as THREE from 'three';
import {
  INFO, SOURCES, CHANGES, GENERATIONS, DEFAULT_GEN, UB_LEVELS, COMM_PATTERNS, ENTITY_COLORS,
  SCALES, DEFAULT_SCALE, TRACE_SCHED, PHASE_META, RUN_SCHED, PARTITION_META, PARTITION_PALETTE, PARALLEL_COLORS, STATUS_META, STATUS_COLORS,
  memLayers,
  type Gen, type RackKind, type ViewMode, type Scale, type RunMode, type PartitionDim,
} from '../scene/data';
import { TOK, FOOTNOTE } from '../content';
import {
  OverviewScene, RackScene, NodeScene, TopologyScene, AdjacencyScene, UBSwitchScene, MappingScene, TraceScene, FullPodScene, SceneTheme, scenePalette,
  type CommOverlays, type LocateTarget, type UbJump,
} from '../scene/scenes';
import { PlaneView } from './PlaneView';

/** Imperatively reposition camera + controls when the view changes, without
 *  remounting the Canvas (remounting creates a new WebGL context each time and
 *  exhausts the browser's context limit → blank canvas needing refresh). */
function CameraController({ poseKey, pos, target, worldH, iso, controls }: {
  poseKey: string; pos: [number, number, number]; target: [number, number, number]; worldH: number; iso?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controls: React.MutableRefObject<any>;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const tgt = new THREE.Vector3(target[0], target[1], target[2]);
    const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
    // default spatial views to the 2.5-D axonometric angle (preserve the preset's distance)
    if (iso) p.copy(tgt).addScaledVector(ISO_DIR, new THREE.Vector3(pos[0], pos[1], pos[2]).distanceTo(tgt));
    camera.up.set(0, 1, 0);
    camera.position.copy(p);
    // orthographic: derive zoom from viewport so the view frames `worldH` units tall
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      (camera as THREE.OrthographicCamera).zoom = size.height / worldH;
    }
    camera.updateProjectionMatrix();
    if (controls.current) { controls.current.target.copy(tgt); controls.current.update(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poseKey]);
  return null;
}

// Snap the orbit camera to a standard projection direction (true ortho views +
// a 2.5-D / axonometric angle), preserving the current distance and zoom.
type CamPreset = 'top' | 'front' | 'side' | 'iso';
const DEFAULT_CAM_POS: [number, number, number] = [9, 10, 15];   // stable initial; CameraController drives the rest
function ViewSnap({ preset, onDone, controls }: {
  preset: CamPreset | null; onDone: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controls: React.MutableRefObject<any>;
}) {
  const { camera } = useThree();
  useEffect(() => {
    if (!preset || !controls.current) return;
    const tgt: THREE.Vector3 = controls.current.target.clone();
    const dist = camera.position.distanceTo(tgt) || 12;
    const dirs: Record<CamPreset, [number, number, number]> = {
      top: [0, 1, 0], front: [0, 0, 1], side: [1, 0, 0], iso: [1, 0.82, 1],
    };
    const v = new THREE.Vector3(...dirs[preset]).normalize();
    camera.up.set(0, preset === 'top' ? 0 : 1, preset === 'top' ? -1 : 0);
    camera.position.copy(tgt).addScaledVector(v, dist);
    camera.lookAt(tgt);
    camera.updateProjectionMatrix();
    controls.current.update();
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);
  return null;
}

// worldH = the vertical world extent the orthographic frustum should frame
// (zoom is derived from canvas-height / worldH, so framing is resolution-stable).
// iso = open at the 2.5-D axonometric angle (spatial views); the flat diagram
// views (matrix / mapping / trace) stay front-on so their labels read straight.
const CAMERA: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; worldH: number; iso?: boolean }> = {
  overview: { pos: [9, 10, 15], target: [0, 0.5, 0], worldH: 17, iso: true },
  rack:     { pos: [4.6, 4.4, 8.6], target: [0, 2.8, 0], worldH: 7.5, iso: true },
  node:     { pos: [0, 3.8, 6.6], target: [0, 0.7, 0], worldH: 3.6, iso: true },
  topology: { pos: [0, 4.2, 13], target: [0, 2.9, 0], worldH: 10.5, iso: true },
  matrix:   { pos: [0, 3.4, 13.5], target: [0, 2, 0], worldH: 10 },
  mapping:  { pos: [0, 2.3, 11.5], target: [0, 2.3, 0], worldH: 8.5 },
  trace:    { pos: [0, 3.2, 13.5], target: [0, 3.1, 0], worldH: 10.5 },
  fullpod:  { pos: [0, 7, 13], target: [0, 0.6, 0], worldH: 18, iso: true },
  plane:    { pos: [0, 7, 13], target: [0, 0.6, 0], worldH: 18 },   // 2-D overlay; 3-D camera unused
};
const ISO_DIR = new THREE.Vector3(1, 0.82, 1).normalize();   // 2.5-D axonometric direction

const MODE_TABS: { id: ViewMode; label: string }[] = [
  { id: 'overview', label: '全景总览' },
  { id: 'rack',     label: '机柜视图' },
  { id: 'node',     label: '节点视图' },
  { id: 'topology', label: 'UB 互联层级' },
  { id: 'matrix',   label: '邻接矩阵' },
  { id: 'mapping',  label: '软硬件映射' },
  { id: 'trace',    label: '执行时序/定位' },
  { id: 'fullpod',  label: '整列全景(多卡)' },
  { id: 'plane',    label: '平面视图' },
];

// compact legend row: a swatch (line / square / dot) + label
function LgRow({ color, label, shape = 'line' }: { color: string; label: string; shape?: 'line' | 'sq' | 'dot' }) {
  const sw = shape === 'line' ? { width: 12, height: 3, borderRadius: 1 } : shape === 'dot' ? { width: 9, height: 9, borderRadius: '50%' } : { width: 10, height: 10, borderRadius: 2 };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ ...sw, background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ color: 'var(--tx2)', fontSize: 11 }}>{label}</span>
    </span>
  );
}
const lgHdr: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--tx2)', borderTop: '1px solid var(--bd)', paddingTop: 4, marginTop: 2 };
const lgNote: React.CSSProperties = { color: 'var(--tx3)', fontSize: 10 };

// per-mode overlay toggles
const TOPO_OVERLAYS: { id: keyof CommOverlays; label: string; color: string }[] = [
  { id: 'ring', label: COMM_PATTERNS[0].label, color: COMM_PATTERNS[0].color },
  { id: 'a2a',  label: COMM_PATTERNS[1].label, color: COMM_PATTERNS[1].color },
];
const NODE_OVERLAYS: { id: keyof CommOverlays; label: string; color: string }[] = [
  { id: 'tile',  label: 'Tile 数据流', color: '#f59e0b' },
  { id: 'cores', label: 'AI Core 阵列', color: COMM_PATTERNS[2].color },
];

export function ClusterView() {
  const [gen, setGen] = useState<Gen>(DEFAULT_GEN);
  const [mode, setMode] = useState<ViewMode>('overview');
  const [rackKind, setRackKind] = useState<RackKind>('compute');
  const [nodeKind, setNodeKind] = useState<'compute' | 'ubswitch'>('compute');
  const [nodeSlot, setNodeSlot] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);   // info panel collapsed by default (small-screen friendly)
  const [scale, setScale] = useState<Scale>(DEFAULT_SCALE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);
  const [overlays, setOverlays] = useState<CommOverlays>({ ring: false, a2a: false, tile: true, cores: true });
  const [locate, setLocate] = useState<LocateTarget | null>(null);   // from trace view
  const [hl, setHl] = useState<{ npu: number; blade: number; cabinet: number } | null>(null);
  const [traceTick, setTraceTick] = useState<number | null>(null);
  const [tracePlaying, setTracePlaying] = useState(false);
  const [ubFocus, setUbFocus] = useState<'ccu' | 'onchip' | 'ub' | null>(null);   // from IO-die inset jump
  const onUbJump = useCallback((t: UbJump) => { setUbFocus(t.focus); setMode(t.view); }, []);
  const [podCount, setPodCount] = useState(1);   // full-pod view: number of super-nodes
  const [fpFull, setFpFull] = useState(false);   // full-pod view: show the full super-node (gen.totalNpus)
  const [runMode, setRunMode] = useState<RunMode>('train');   // full-pod run view: train / infer
  const [runTick, setRunTick] = useState<number | null>(null);   // current phase index in RUN_SCHED[runMode]
  const [runPlaying, setRunPlaying] = useState(false);
  const [runStep, setRunStep] = useState(0);     // completed iterations / decode steps
  const [fpPart, setFpPart] = useState<PartitionDim>('none');   // full-pod: colour cards by parallel dim
  const [fpPeers, setFpPeers] = useState(true);   // full-pod: draw same-level peer mesh (L1 card / L2 node)
  const [fpStatus, setFpStatus] = useState(false);   // full-pod: live status / flow overlay
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const narrow = vw < 1440;   // 13" laptops (~1280–1440) → compact toolbar + overlay panel
  const [ctxOpen, setCtxOpen] = useState(true);   // floating on-canvas control panel open/collapsed
  const [dark, setDark] = useState(true);   // dark / light theme (dark by default)
  const [camPreset, setCamPreset] = useState<CamPreset | null>(null);   // pending camera-angle snap
  const [memOpen, setMemOpen] = useState(true);   // per-card memory occupancy panel (node view)
  const [swimOpen, setSwimOpen] = useState(true);   // full-pod swimlane timeline panel
  const [pendingNpu, setPendingNpu] = useState<number | undefined>(undefined);   // preselect NPU's die on node drill

  useEffect(() => {
    if (!tracePlaying) return;
    const id = setInterval(() => setTraceTick((t) => ((t ?? -1) + 1) % TRACE_SCHED.length), 750);
    return () => clearInterval(id);
  }, [tracePlaying]);

  // full-pod "running" loop: advance the train/infer schedule, bump the iteration counter on wrap
  useEffect(() => {
    if (!runPlaying) return;
    const len = RUN_SCHED[runMode].length;
    const id = setInterval(() => setRunTick((t) => {
      const next = ((t ?? -1) + 1) % len;
      if (next === 0) setRunStep((s) => s + 1);
      return next;
    }), 800);
    return () => clearInterval(id);
  }, [runPlaying, runMode]);
  const runPhase = runTick === null ? null : RUN_SCHED[runMode][runTick % RUN_SCHED[runMode].length];

  const spec = GENERATIONS[gen];
  const pal = scenePalette(dark);   // theme-aware neutrals, so legend swatches match the scene
  const onHoverInfo = useCallback((t: string | null) => setHoverInfo(t), []);
  const rackLabel = rackKind === 'compute' ? '计算柜' : '通信柜';

  const infoKey =
    mode === 'overview' ? 'overview' :
    mode === 'rack' ? (rackKind === 'compute' ? 'computeRack' : 'switchRack') :
    mode === 'node' ? (nodeKind === 'ubswitch' ? 'ubswitch' : 'node') :
    mode === 'matrix' ? 'matrix' :
    mode === 'mapping' ? 'mapping' :
    mode === 'trace' ? 'trace' :
    mode === 'fullpod' || mode === 'plane' ? 'fullpod' : 'topology';
  const info = INFO[infoKey];

  const breadcrumb = useMemo(() => {
    const bc: { label: string; onClick?: () => void }[] = [
      { label: spec.name, onClick: mode !== 'overview' ? () => setMode('overview') : undefined },
    ];
    if (mode === 'rack' || mode === 'node') bc.push({ label: rackLabel, onClick: mode === 'node' ? () => setMode('rack') : undefined });
    if (mode === 'node') bc.push({ label: nodeKind === 'ubswitch' ? 'UB 交换设备' : `节点 ${nodeSlot + 1}` });
    return bc;
  }, [mode, rackLabel, nodeSlot, nodeKind, spec.name]);

  // full-pod field grows with the card count → pull the camera back / raise the angle to fit
  const fpReach = useMemo(() => {
    const n = (fpFull ? spec.totalNpus : 64) * podCount;   // full super-node, else single 64P cabinet
    return Math.sqrt(n) * 1.3 + 12;
  }, [fpFull, podCount, spec.totalNpus]);
  // parallel decomposition shown in the partition legend (mirrors FullPodScene's `part`)
  const fpCfg = useMemo(() => {
    const n1 = fpFull ? spec.totalNpus : 64, nB1 = Math.max(1, Math.round(n1 / 8));
    const TP = 8, PP = Math.min(16, nB1), DP = Math.max(1, Math.round(nB1 / PP));
    return `TP${TP}×PP${PP}×DP${DP}`;
  }, [fpFull, spec.totalNpus]);
  const cam = mode === 'node' && nodeKind === 'ubswitch'
    ? { pos: [2.9, 2.5, 3.6] as [number, number, number], target: [0, 0.7, 0] as [number, number, number], worldH: 4.5, iso: true }
    : mode === 'fullpod'
    ? { pos: [0, fpReach * 0.62, fpReach * 1.02] as [number, number, number], target: [0, Math.min(6, fpReach * 0.1), 0] as [number, number, number], worldH: Math.max(14, fpReach * 1.5), iso: true }
    : CAMERA[mode];

  const specRows: [string, string][] = [
    ['代际 / 形态', `${spec.code} · ${spec.name}`],
    ['NPU 总数', `${spec.totalNpus.toLocaleString()}× ${spec.npuLabel}`],
    ['算力 FP8 / FP4', `${spec.fp8EF} / ${spec.fp4EF} EFLOPS`],
    ['单卡算力', spec.fp4Tflops ? `MXFP4 ${spec.fp4Tflops} / FP8 ${spec.fp8Tflops} TFLOPS${spec.estimated ? '*' : ''}` : '—'],
    ['单卡显存', `${spec.memGB} GB · ${spec.memPerChipTBs} TB/s · ${spec.hbm}`],
    ['HBM 总量', `${spec.memTB.toLocaleString()} TB`],
    ['单卡 UB 带宽', `${spec.ubGBs.toLocaleString()} GB/s（${spec.chipUbTBs} TB/s 级）`],
    ['总互联带宽', `${spec.interconnectPBs} PB/s`],
    ['L2 / AI 子系统', `${spec.l2MB ? spec.l2MB + ' MB' : '—'} · ${spec.aiSubsys ? spec.aiSubsys + '×(Cube+2Vector)' : '—'}`],
    ['小超节点', `16P / 32P / 64P(单柜) · 64 卡步长`],
    ['机柜', `${spec.totalCabs}（${spec.computeCabs} 计算 + ${spec.commCabs} 通信）`],
    ['占地', `${spec.footprintM2.toLocaleString()} m²`],
    ['训练 / 推理', `${spec.trainTokps} / ${spec.inferTokps}`],
    [TOK.supercluster, `${spec.superclusterNpu}卡`],
    ['上市', spec.release],
    ['散热', TOK.cooling],
  ];

  return (
    <div data-theme={dark ? 'dark' : 'light'} style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', color: 'var(--tx)',
      fontFamily: 'Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      '--bg': dark ? '#101010' : '#f5f5f5',
      '--bg2': dark ? '#0d0d0d' : '#f3f4f7',
      '--panel': dark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.96)',
      '--panel-solid': dark ? '#181818' : '#ffffff',
      '--tx': dark ? 'rgba(255,255,255,0.90)' : 'rgba(0,0,0,0.88)',
      '--tx2': dark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.58)',
      '--tx3': dark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.45)',
      '--bd': dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)',
      '--bd2': dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)',
      '--shadow': dark ? '0 10px 30px rgba(0,0,0,0.55)' : '0 10px 28px rgba(17,24,39,0.12)',
      '--shadow-sm': dark ? '0 4px 14px rgba(0,0,0,0.45)' : '0 4px 14px rgba(17,24,39,0.09)',
    } as React.CSSProperties}>
      {/* ── toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? 6 : 12, padding: narrow ? '5px 8px' : '8px 14px', borderBottom: '1px solid var(--bd)', flexWrap: 'wrap', background: 'var(--panel-solid)' }}>
        {/* generation switch */}
        <div style={{ display: 'flex', gap: 4, borderRight: '1px solid var(--bd)', paddingRight: narrow ? 6 : 12 }}>
          {(Object.keys(GENERATIONS) as Gen[]).map((g) => (
            <button
              key={g}
              onClick={() => setGen(g)}
              title={GENERATIONS[g].name}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${gen === g ? '#4369ef' : 'var(--bd)'}`,
                background: gen === g ? 'rgba(67,105,239,0.10)' : 'transparent',
                color: gen === g ? '#4369ef' : 'var(--tx2)',
              }}
            >
              {g}
            </button>
          ))}
        </div>
        {/* mode tabs (dropdown on small screens to save toolbar width) */}
        {narrow ? (
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ViewMode)}
            style={{ padding: '5px 8px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: '1px solid #4369ef', background: 'rgba(67,105,239,0.10)', color: '#4369ef' }}
          >
            {MODE_TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        ) : (
          <div style={{ display: 'flex', gap: 4 }}>
            {MODE_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setMode(t.id)}
                style={{
                  padding: '5px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${mode === t.id ? '#4369ef' : 'var(--bd)'}`,
                  background: mode === t.id ? 'rgba(67,105,239,0.10)' : 'transparent',
                  color: mode === t.id ? '#4369ef' : 'var(--tx2)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {/* view-specific controls live in the floating panel on the canvas (see ctxControls) */}
        {/* breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
          {breadcrumb.map((b, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span style={{ color: 'var(--tx3)' }}>›</span>}
              <span onClick={b.onClick} style={b.onClick ? { cursor: 'pointer', color: '#4369ef' } : { color: 'var(--tx)' }}>{b.label}</span>
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {!narrow && <span style={{ fontSize: 11, color: 'var(--tx2)' }}>{`${spec.name} · ${spec.totalNpus.toLocaleString()}× ${spec.npuShort} · ${TOK.ub} UB 全互联`}</span>}
        {/* view-angle presets — orthographic 三视图 + a 2.5-D (axonometric) angle */}
        {mode !== 'plane' && (
          <div style={{ display: 'flex', gap: 3, borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
            {([['top', '俯视'], ['front', '正视'], ['side', '侧视'], ['iso', '2.5D']] as [CamPreset, string][]).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setCamPreset(id)}
                title={`${label}视角（正交投影）`}
                style={{ padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}
              >{label}</button>
            ))}
          </div>
        )}
        <button
          onClick={() => setDark((v) => !v)}
          title="黑 / 白 主题切换"
          style={{ padding: '4px 10px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}
        >{dark ? '☀' : '◐'}</button>
        <button
          onClick={() => setPanelOpen((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}
        >
          {panelOpen ? '收起信息 ▸' : '◂ 信息面板'}
        </button>
      </div>

      {/* ── main: Canvas + info panel ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <Canvas
            shadows
            dpr={[1, 2]}
            orthographic
            camera={{ position: DEFAULT_CAM_POS, zoom: 60, near: 0.1, far: 4000 }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1, powerPreference: 'high-performance' }}
            onCreated={({ gl }) => {
              gl.shadowMap.type = THREE.PCFSoftShadowMap;
              // allow the browser to auto-restore a lost context instead of going blank
              gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
            }}
          >
            {/* orthographic projection — no perspective foreshortening, so the
                front/top/side snaps read as true engineering views (三视图). R3F's
                built-in ortho camera preserves zoom across resizes (drei's component
                would reset it). CameraController drives position/zoom imperatively. */}
            <CameraController poseKey={`${mode}-${gen}-${scale}-${nodeKind}-${podCount}-${fpFull}`} pos={cam.pos} target={cam.target} worldH={cam.worldH} iso={cam.iso} controls={controlsRef} />
            <ViewSnap preset={camPreset} onDone={() => setCamPreset(null)} controls={controlsRef} />
            <color attach="background" args={[dark ? '#101010' : '#f5f5f5']} />
            <fog attach="fog" args={[dark ? '#101010' : '#f5f5f5', mode === 'fullpod' ? 90 : 26, mode === 'fullpod' ? 420 : 60]} />
            <ambientLight intensity={dark ? 1.35 : 1.05} />
            <directionalLight
              position={[8, 14, 6]} intensity={dark ? 0.95 : 1.2} castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-camera-left={-16} shadow-camera-right={16}
              shadow-camera-top={16} shadow-camera-bottom={-16}
            />
            <pointLight position={[0, 10, 0]} intensity={dark ? 0.7 : 1.0} color={dark ? '#7e93cf' : '#e8f0ff'} />

            <SceneTheme.Provider value={dark}>
            {mode === 'overview' && (
              <OverviewScene gen={spec} highlightCabinet={hl ? hl.cabinet : null} onHoverInfo={onHoverInfo} onSelectRack={(k) => { setRackKind(k); setMode('rack'); }} />
            )}
            {mode === 'rack' && (
              <RackScene
                rackKind={rackKind} label={rackLabel} onHoverInfo={onHoverInfo}
                onSelectNode={(slot) => { setNodeSlot(slot); setNodeKind('compute'); setMode('node'); }}
                onSelectSwitch={() => { setNodeKind('ubswitch'); setMode('node'); }}
              />
            )}
            {mode === 'node' && (nodeKind === 'ubswitch'
              ? <UBSwitchScene onHoverInfo={onHoverInfo} />
              : <NodeScene onHoverInfo={onHoverInfo} overlays={overlays} onJump={onUbJump} initialSelected={pendingNpu} />)}
            {mode === 'topology' && <TopologyScene gen={spec} overlays={overlays} highlight={hl ? { npu: hl.npu, blade: hl.blade } : null} subFocus={ubFocus} onHoverInfo={onHoverInfo} />}
            {mode === 'matrix' && <AdjacencyScene scale={scale} onHoverInfo={onHoverInfo} />}
            {mode === 'mapping' && <MappingScene onHoverInfo={onHoverInfo} />}
            {mode === 'trace' && <TraceScene onHoverInfo={onHoverInfo} onLocate={setLocate} tick={traceTick} />}
            {mode === 'fullpod' && <FullPodScene scale="64P" podCount={podCount} full={fpFull} gen={spec} overlays={overlays} runMode={runMode} phase={runPhase} partition={fpPart} peers={fpPeers} status={fpStatus} onHoverInfo={onHoverInfo} onPick={(loc) => { setRackKind('compute'); setNodeKind('compute'); setPendingNpu(loc); setMode('node'); }} />}
            </SceneTheme.Provider>

            <OrbitControls
              ref={controlsRef}
              makeDefault
              enableDamping dampingFactor={0.08}
              minPolarAngle={0} maxPolarAngle={Math.PI / 2}
              minDistance={1.2} maxDistance={mode === 'fullpod' ? 360 : 60}
              // middle-button drag pans (not dolly); wheel still zooms
              mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
            />
            {/* ViewCube navigation gizmo — click a face/edge/corner for a standard view (front/top/side/iso).
                Latin face labels (the default webfont has no CJK glyphs). */}
            <GizmoHelper alignment="bottom-left" margin={[64, 64]}>
              <GizmoViewcube
                faces={['Right', 'Left', 'Top', 'Bottom', 'Front', 'Back']}
                color={dark ? '#2a2e36' : '#eef1f6'} hoverColor="#4369ef"
                textColor={dark ? '#e6e6e6' : '#1c2433'} strokeColor={dark ? '#4a5160' : '#aab4c4'} opacity={0.95}
              />
            </GizmoHelper>
          </Canvas>

          {/* 2-D planar view — flat tiled diagram of the full super-node (overlays the 3-D canvas) */}
          {mode === 'plane' && <PlaneView gen={gen} dark={dark} />}

          {/* floating on-canvas control panel — per-view controls (collapsible) */}
          {(mode === 'topology' || (mode === 'node' && nodeKind === 'compute') || mode === 'matrix' || mode === 'fullpod') && (
            <div style={{
              position: 'absolute', top: 12, left: 12, zIndex: 5, maxWidth: 'calc(100% - 24px)',
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: narrow ? 5 : 8, padding: '6px 10px',
              background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <button onClick={() => setCtxOpen((v) => !v)} title="视图控制" style={{ padding: '3px 9px', fontSize: 11.5, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'rgba(67,105,239,0.08)', color: '#4369ef' }}>{ctxOpen ? '控制 ▾' : '控制 ▸'}</button>
              {ctxOpen && (
                <>
                  {/* per-mode overlay toggles: process(rank) in UB view, tile/cores in node view */}
                  {(mode === 'topology' || mode === 'fullpod' || (mode === 'node' && nodeKind === 'compute')) && (
                    <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      {(mode === 'node' ? NODE_OVERLAYS : TOPO_OVERLAYS).map((t) => {
                        const on = overlays[t.id];
                        return (
                          <button key={t.id} onClick={() => setOverlays((o) => ({ ...o, [t.id]: !o[t.id] }))} title={t.label}
                            style={{ padding: '4px 10px', fontSize: 11, borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${on ? t.color : 'var(--bd)'}`, background: on ? `${t.color}22` : 'transparent', color: on ? 'var(--tx)' : 'var(--tx3)' }}>
                            <span style={{ width: 9, height: 3, background: t.color, display: 'inline-block', borderRadius: 1, opacity: on ? 1 : 0.4 }} />
                            {narrow ? t.label.split(' ')[0] : t.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* scale selector (adjacency-matrix view) */}
                  {mode === 'matrix' && (
                    <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      {(Object.keys(SCALES) as Scale[]).map((s) => (
                        <button key={s} onClick={() => setScale(s)} style={{ padding: '4px 12px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${scale === s ? '#4369ef' : 'var(--bd)'}`, background: scale === s ? 'rgba(67,105,239,0.10)' : 'transparent', color: scale === s ? '#4369ef' : 'var(--tx2)' }}>{SCALES[s].label}</button>
                      ))}
                    </div>
                  )}
                  {/* full-pod scale — 64P cabinet ↔ full super-node */}
                  {mode === 'fullpod' && (
                    <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      {([[false, '64P 单柜'], [true, `全量超节点(${spec.totalNpus >= 1000 ? Math.round(spec.totalNpus / 1000) + 'K' : spec.totalNpus})`]] as [boolean, string][]).map(([v, label]) => (
                        <button key={label} onClick={() => setFpFull(v)} title={v ? `渲染整座超节点全部 ${spec.totalNpus.toLocaleString()} 张卡（阵列）` : '单柜 64 卡（8 刀片 × 8 卡）'}
                          style={{ padding: '4px 12px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${fpFull === v ? '#4369ef' : 'var(--bd)'}`, background: fpFull === v ? 'rgba(67,105,239,0.10)' : 'transparent', color: fpFull === v ? '#4369ef' : 'var(--tx2)' }}>{label}</button>
                      ))}
                    </div>
                  )}
                  {/* super-node count */}
                  {mode === 'fullpod' && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      <span style={{ fontSize: 11, color: 'var(--tx3)' }}>超节点</span>
                      {[1, 2, 4].map((c) => (
                        <button key={c} onClick={() => setPodCount(c)} style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${podCount === c ? '#4369ef' : 'var(--bd)'}`, background: podCount === c ? 'rgba(67,105,239,0.10)' : 'transparent', color: podCount === c ? '#4369ef' : 'var(--tx2)' }}>{`×${c}`}</button>
                      ))}
                    </div>
                  )}
                  {/* run mode: train / infer */}
                  {mode === 'fullpod' && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      <span style={{ fontSize: 11, color: 'var(--tx3)' }}>运行</span>
                      {([['train', '训练'], ['infer', '推理']] as [RunMode, string][]).map(([m, label]) => (
                        <button key={m} onClick={() => { setRunMode(m); setRunTick((t) => (t === null ? t : 0)); setRunStep(0); }} style={{ padding: '4px 12px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${runMode === m ? '#4369ef' : 'var(--bd)'}`, background: runMode === m ? 'rgba(67,105,239,0.10)' : 'transparent', color: runMode === m ? '#4369ef' : 'var(--tx2)' }}>{label}</button>
                      ))}
                    </div>
                  )}
                  {/* parallel partition (TP/PP/DP/EP) */}
                  {mode === 'fullpod' && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      <span style={{ fontSize: 11, color: 'var(--tx3)' }}>切分</span>
                      {(['tp', 'pp', 'dp', 'ep'] as Exclude<PartitionDim, 'none'>[]).map((d) => {
                        const on = fpPart === d; const sig = PARALLEL_COLORS[d];
                        return (
                          <button key={d} onClick={() => setFpPart((p) => (p === d ? 'none' : d))} title={`${PARTITION_META[d].label} · ${PARTITION_META[d].level}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${on ? sig : 'var(--bd)'}`, background: on ? `${sig}1f` : 'transparent', color: on ? sig : 'var(--tx2)' }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: sig, display: 'inline-block', opacity: on ? 1 : 0.55 }} />{d.toUpperCase()}</button>
                        );
                      })}
                    </div>
                  )}
                  {/* same-level peer mesh + status/flow toggles */}
                  {mode === 'fullpod' && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', borderLeft: '1px solid var(--bd)', paddingLeft: narrow ? 6 : 10 }}>
                      <button onClick={() => setFpPeers((v) => !v)} title="层内直连：L1 板载卡↔卡 + L2 机柜内节点↔节点 UB 直连 mesh"
                        style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${fpPeers ? UB_LEVELS[1].color : 'var(--bd)'}`, background: fpPeers ? `${UB_LEVELS[1].color}22` : 'transparent', color: fpPeers ? 'var(--tx)' : 'var(--tx3)' }}>
                        <span style={{ width: 9, height: 3, background: UB_LEVELS[1].color, display: 'inline-block', borderRadius: 1, opacity: fpPeers ? 1 : 0.4 }} />
                        {narrow ? '直连' : '层内直连'}
                      </button>
                      <button onClick={() => setFpStatus((v) => !v)} title="状态/流量：节点按当前活动上色（计算/通信/访存…），连线粗细表示带宽，当前相位的活跃链路加粗发亮（状态色优先于切分色）"
                        style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${fpStatus ? '#22c55e' : 'var(--bd)'}`, background: fpStatus ? 'rgba(34,197,94,0.12)' : 'transparent', color: fpStatus ? 'var(--tx)' : 'var(--tx3)' }}>
                        <span style={{ width: 9, height: 9, background: '#22c55e', display: 'inline-block', borderRadius: '50%', opacity: fpStatus ? 1 : 0.4 }} />
                        {narrow ? '状态' : '状态/流量'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* trace → jump-to-view controls */}
          {mode === 'trace' && locate && (
            <div style={{
              position: 'absolute', left: 14, top: 14, display: 'flex', gap: 8, alignItems: 'center',
              padding: '7px 12px', fontSize: 12, background: 'var(--panel)',
              border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <span style={{ color: 'var(--tx)' }}>{`已选 rank ${locate.rank}（刀片 B${locate.blade}）：`}</span>
              <button
                onClick={() => { setHl({ npu: locate.rank, blade: locate.blade, cabinet: 0 }); setMode('topology'); }}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid #4369ef', background: 'rgba(67,105,239,0.10)', color: '#4369ef' }}
              >→ UB 互联高亮</button>
              <button
                onClick={() => { setHl({ npu: locate.rank, blade: locate.blade, cabinet: 0 }); setMode('overview'); }}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid #4369ef', background: 'rgba(67,105,239,0.10)', color: '#4369ef' }}
              >→ 全景高亮机柜</button>
              {hl && (
                <button
                  onClick={() => setHl(null)}
                  style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}
                >清除高亮</button>
              )}
            </div>
          )}

          {/* IO-die → UB linkage banner */}
          {ubFocus && (mode === 'topology' || mode === 'matrix') && (
            <div style={{
              position: 'absolute', left: 14, top: 58, display: 'flex', gap: 8, alignItems: 'center',
              padding: '6px 11px', fontSize: 12, background: 'var(--panel)',
              border: '1px solid #4369ef', borderRadius: 10, color: '#4369ef', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <span>{`来自 IO Die：${ubFocus === 'ccu' ? `高亮 ${TOK.ccu} 集合通信` : ubFocus === 'onchip' ? `高亮 ${TOK.onchip} 转发` : '该端口实现的 NPU↔NPU UB 互联（邻接矩阵）'}`}</span>
              <button onClick={() => { setUbFocus(null); setMode('node'); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>← 回节点</button>
              <button onClick={() => setUbFocus(null)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>清除</button>
            </div>
          )}

          {/* active highlight banner in topology/overview */}
          {hl && (mode === 'topology' || mode === 'overview') && (
            <div style={{
              position: 'absolute', left: 14, top: 58, display: 'flex', gap: 8, alignItems: 'center',
              padding: '6px 11px', fontSize: 12, background: 'var(--panel)',
              border: '1px solid #4369ef', borderRadius: 10, color: '#4369ef', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <span>{`定位高亮：rank ${hl.npu} · 刀片 B${hl.blade} · 机柜 C${hl.cabinet}`}</span>
              <button onClick={() => { setHl(null); setMode('trace'); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>← 回时序</button>
              <button onClick={() => setHl(null)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>清除</button>
            </div>
          )}

          {/* trace timeline media control (HTML overlay, not a 3D object) */}
          {mode === 'trace' && (
            <div style={{
              position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 14,
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <button
                onClick={() => { setTracePlaying((v) => !v); if (traceTick === null) setTraceTick(0); }}
                style={{ width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', border: '1px solid #4369ef', background: tracePlaying ? '#4369ef' : 'var(--panel-solid)', color: tracePlaying ? '#fff' : '#4369ef', fontSize: 13 }}
              >{tracePlaying ? '⏸' : '▶'}</button>
              {/* phase scrubber */}
              <div style={{ display: 'flex', gap: 2 }}>
                {TRACE_SCHED.map((ph, k) => (
                  <button
                    key={k}
                    title={PHASE_META[ph].name}
                    onClick={() => { setTracePlaying(false); setTraceTick(k); }}
                    style={{
                      width: 26, height: 18, cursor: 'pointer', borderRadius: 6,
                      border: traceTick === k ? '2px solid var(--tx)' : '1px solid var(--bd)',
                      background: PHASE_META[ph].color, opacity: traceTick === null || traceTick === k ? 1 : 0.55,
                      fontSize: 8, color: '#33405a',
                    }}
                  >{`t${k}`}</button>
                ))}
              </div>
              <span style={{ fontSize: 12, color: '#4369ef', minWidth: 96 }}>
                {traceTick === null ? '示意时序（点块/播放）' : `t${traceTick} · ${PHASE_META[TRACE_SCHED[traceTick]].name}`}
              </span>
              {traceTick !== null && (
                <button onClick={() => { setTracePlaying(false); setTraceTick(null); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx3)' }}>复位</button>
              )}
            </div>
          )}

          {/* full-pod run HUD + swimlane timeline (merged): the play driver, the per-
              role swimlane (rows = TP/PP/DP/EP, columns = phases), and readouts in one
              bottom panel. Click a phase column to seek the 3-D playback. */}
          {mode === 'fullpod' && (() => {
            const phases = RUN_SCHED[runMode];
            const lanes: Exclude<PartitionDim, 'none'>[] = ['tp', 'pp', 'dp', 'ep'];
            const cw = narrow ? 56 : 78;
            const col = (w: number) => ({ width: w, minWidth: w, textAlign: 'center' as const });
            return (
              <div style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 14, zIndex: 5,
                display: 'flex', flexDirection: 'column', gap: 7, padding: '8px 12px', maxWidth: 'calc(100% - 24px)',
                background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              }}>
                {/* swimlane grid (collapsible) */}
                {swimOpen && (
                  <div style={{ display: 'block', fontSize: 10.5, overflowX: 'auto', maxWidth: '100%' }}>
                    <div style={{ display: 'inline-block' }}>
                      {/* phase header — clickable = seek */}
                      <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                        <div style={col(40)} />
                        {phases.map((ph, k) => (
                          <button key={ph.id} title={ph.note}
                            onClick={() => { setRunPlaying(false); setRunTick(k); }}
                            style={{ ...col(cw), padding: '3px 4px', cursor: 'pointer', borderRadius: 6, fontSize: 10, fontWeight: 600,
                              border: runTick === k ? `1px solid ${ph.color}` : '1px solid var(--bd)',
                              background: runTick === k ? `${ph.color}26` : 'transparent', color: runTick === k ? 'var(--tx)' : 'var(--tx2)' }}>
                            {ph.name.split(' ')[0]}
                          </button>
                        ))}
                      </div>
                      {/* role lanes */}
                      {lanes.map((ln) => (
                        <div key={ln} style={{ display: 'flex', gap: 3, marginBottom: 3, alignItems: 'center' }}>
                          <div style={{ ...col(40), display: 'inline-flex', alignItems: 'center', gap: 3, justifyContent: 'flex-start' }}>
                            <span style={{ width: 7, height: 7, borderRadius: 2, background: PARALLEL_COLORS[ln] }} />
                            <span style={{ color: 'var(--tx2)', fontWeight: 600 }}>{ln.toUpperCase()}</span>
                          </div>
                          {phases.map((ph, k) => {
                            const active = (ph.parallel ?? '').toUpperCase().includes(ln.toUpperCase());
                            const cur = runTick === k;
                            return <div key={ph.id} style={{ ...col(cw), height: 13, borderRadius: 4,
                              background: active ? PARALLEL_COLORS[ln] : 'var(--bd)',
                              opacity: active ? (cur ? 1 : 0.62) : (cur ? 0.5 : 0.22),
                              outline: cur ? `1px solid ${ph.color}` : 'none' }} />;
                          })}
                        </div>
                      ))}
                      {/* comm marker row */}
                      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                        <div style={{ ...col(40), color: 'var(--tx3)', textAlign: 'left' }}>通信</div>
                        {phases.map((ph) => (
                          <div key={ph.id} style={{ ...col(cw), textAlign: 'center', color: ph.kind === 'comm' ? (ph.collective === 'ring' ? COMM_PATTERNS[0].color : COMM_PATTERNS[1].color) : 'var(--tx3)' }}>
                            {ph.kind === 'comm' ? (ph.collective === 'ring' ? 'AllReduce' : 'All-to-All') : '·'}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {/* control row: play + (compact scrubber when collapsed) + readouts + toggles */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setRunPlaying((v) => !v); if (runTick === null) setRunTick(0); }}
                    style={{ width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', border: '1px solid #4369ef', background: runPlaying ? '#4369ef' : 'var(--panel-solid)', color: runPlaying ? '#fff' : '#4369ef', fontSize: 13 }}
                  >{runPlaying ? '⏸' : '▶'}</button>
                  {!swimOpen && (
                    <div style={{ display: 'flex', gap: 2 }}>
                      {phases.map((ph, k) => (
                        <button key={ph.id} title={ph.note}
                          onClick={() => { setRunPlaying(false); setRunTick(k); }}
                          style={{ height: 22, padding: '0 8px', cursor: 'pointer', borderRadius: 6,
                            border: runTick === k ? '2px solid var(--tx)' : '1px solid var(--bd)',
                            background: ph.color, opacity: runTick === null || runTick === k ? 1 : 0.5, fontSize: 10, color: '#1c2433', fontWeight: 600 }}
                        >{ph.name.split(' ')[0]}</button>
                      ))}
                    </div>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--tx)', minWidth: 140 }}>
                    {runPhase ? `${runPhase.name} · ${runPhase.parallel ?? '—'}` : (runMode === 'train' ? '训练循环（点相位 / ▶）' : '推理循环（点相位 / ▶）')}
                  </span>
                  <span style={{ fontSize: 11.5, color: '#4369ef' }}>
                    {`${runMode === 'train' ? '迭代' : '步'} #${runStep} · ${runMode === 'train' ? spec.trainTokps : spec.inferTokps}`}
                  </span>
                  <div style={{ flex: 1 }} />
                  {runTick !== null && (
                    <button onClick={() => { setRunPlaying(false); setRunTick(null); setRunStep(0); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx3)' }}>复位</button>
                  )}
                  <button onClick={() => setSwimOpen((v) => !v)} title="展开 / 收起时序泳道"
                    style={{ padding: '3px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>{swimOpen ? '泳道 ▾' : '泳道 ▸'}</button>
                </div>
                {runPhase && swimOpen && <div style={{ fontSize: 10.5, color: 'var(--tx2)' }}>{runPhase.note}</div>}
              </div>
            );
          })()}

          {/* hover info bar */}
          {hoverInfo && (
            <div style={{
              position: 'absolute', left: 150, bottom: 14, maxWidth: 'calc(70% - 150px)',
              padding: '7px 12px', fontSize: 12.5, lineHeight: 1.5,
              background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              color: 'var(--tx)', pointerEvents: 'none',
            }}>{hoverInfo}</div>
          )}

          {/* per-card memory occupancy — bridges topology → on-chip (where a rank's bytes live) */}
          {mode === 'node' && nodeKind === 'compute' && (
            <div style={{
              position: 'absolute', right: 14, top: 14, width: 232, padding: '9px 12px', fontSize: 11.5,
              background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'var(--tx2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: memOpen ? 7 : 0 }}>
                <span style={{ fontWeight: 600, color: 'var(--tx)' }}>单卡内存占用 · 1 NPU</span>
                <button onClick={() => setMemOpen((v) => !v)} style={{ padding: '1px 7px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx2)' }}>{memOpen ? '▾' : '▸'}</button>
              </div>
              {memOpen && memLayers(spec).map((m) => (
                <div key={m.id} title={m.note} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 2 }}>
                    <span style={{ color: 'var(--tx)' }}>{m.name}</span>
                    <span style={{ color: 'var(--tx3)' }}>{`${m.cap} · ${Math.round(m.util * 100)}%`}</span>
                  </div>
                  {/* PTO 14%-fill / 34%-stroke track + util fill */}
                  <div style={{ position: 'relative', height: 7, borderRadius: 4, background: `${m.color}24`, border: `1px solid ${m.color}57`, overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', inset: 0, width: `${Math.round(m.util * 100)}%`, background: m.color, opacity: 0.82 }} />
                  </div>
                </div>
              ))}
              {memOpen && <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 2 }}>示意占用 · 越贴近算力越易成瓶颈</div>}
            </div>
          )}

          {/* legend: UB hierarchy levels (+ comm overlays in node view) */}
          <div style={{
            position: 'absolute', right: 14, bottom: 14, padding: '8px 12px', fontSize: 11.5,
            background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 250,
            pointerEvents: mode === 'fullpod' ? 'auto' : 'none',
            maxHeight: mode === 'fullpod' ? 'calc(100vh - 140px)' : undefined,
            overflowY: mode === 'fullpod' ? 'auto' : 'visible',
          }}>
            {mode === 'mapping' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>软硬件映射</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: ENTITY_COLORS.rank, display: 'inline-block' }} />
                  <span style={{ color: 'var(--tx2)' }}>软件 rank ↔ device（1:1 锚点）</span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: ENTITY_COLORS.cube, display: 'inline-block' }} />
                  <span style={{ color: 'var(--tx2)' }}>设备内 线程/Tile ↔ AI Core</span>
                </span>
                <span style={{ color: 'var(--tx3)', fontSize: 10 }}>灰线 = 其他层级映射 · 点击高亮</span>
              </>
            )}
            {mode === 'trace' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>时序 / 定位</div>
                {([['计算（设备内线程）', COMM_PATTERNS[2].color], ['通信 AllReduce（rank）', COMM_PATTERNS[0].color], ['加载 / 存储', '#c2c9d4']] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 8, background: c, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'var(--tx2)' }}>{t}</span>
                  </span>
                ))}
                <span style={{ color: 'var(--tx3)', fontSize: 10 }}>点击 线程/rank → 顶部定位 device/刀片/机柜</span>
              </>
            )}
            {mode !== 'matrix' && mode !== 'mapping' && mode !== 'trace' && mode !== 'fullpod' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>{`${TOK.ub} UB 互联层级（颜色 = 级别）`}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {UB_LEVELS.map((lv) => (
                    <span key={lv.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 12, height: 3, background: lv.color, display: 'inline-block', borderRadius: 1 }} />
                      <span style={{ color: 'var(--tx2)' }}>{`${lv.id} ${lv.label}`}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
            {mode === 'topology' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--bd)', paddingTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx2)' }}>进程级通信（顶栏开关）</div>
                {COMM_PATTERNS.slice(0, 2).map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c.color, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'var(--tx2)' }}>{c.label}</span>
                  </span>
                ))}
              </div>
            )}
            {mode === 'matrix' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>图例</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tx2)' }}>矩阵格子（行 i × 列 j = 两颗 NPU）</div>
                {([['L1 直连·板内', UB_LEVELS[1].color], ['L2 直连·跨板', UB_LEVELS[2].color], ['L3 直连·跨柜（更大规模）', UB_LEVELS[3].color], ['多跳·非直连', pal.matIndirect], ['对角·自身', pal.matSelf]] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 8, background: c, display: 'inline-block', borderRadius: 1, border: '1px solid var(--bd)' }} />
                    <span style={{ color: 'var(--tx2)' }}>{t}</span>
                  </span>
                ))}
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tx2)', marginTop: 2 }}>右侧 3D 结构</div>
                {([['UB 直连 L1（板内）', UB_LEVELS[1].color], ['UB 直连 L2（跨板）', UB_LEVELS[2].color]] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'var(--tx2)' }}>{t}</span>
                  </span>
                ))}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 10, background: pal.substrate, display: 'inline-block', borderRadius: 1, border: '1px solid var(--bd2)' }} />
                  <span style={{ color: 'var(--tx2)' }}>刀片(板)框 · 外框 = 单柜</span>
                </span>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tx2)', marginTop: 2 }}>联动高亮</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: '#4369ef', display: 'inline-block' }} />
                  <span style={{ color: 'var(--tx2)' }}>十字 = 行 i / 列 j；i·j = 对应两颗 NPU</span>
                </span>
              </div>
            )}
            {mode === 'fullpod' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>全量超节点 · 图例</div>
                {/* layer elements — same canonical colour per concept as the layered/top views */}
                <LgRow shape="dot" color={ENTITY_COLORS.cube} label="AI Core（设备内 · block）" />
                <LgRow shape="dot" color={ENTITY_COLORS.rank} label="rank（软件 · 1:1 绑定 device）" />
                <LgRow shape="sq" color={ENTITY_COLORS.card} label="L0 卡 / device（4 Die）" />
                <LgRow shape="sq" color={ENTITY_COLORS.node} label="L1 刀片 / 节点" />
                <LgRow shape="sq" color={ENTITY_COLORS.cab} label="L2 机柜" />
                <LgRow shape="sq" color={ENTITY_COLORS.super} label={`L3 ${TOK.supernode}`} />
                {podCount > 1 && <LgRow shape="sq" color={UB_LEVELS[4].color} label="L4 超节点间" />}
                {/* connections */}
                <div style={lgHdr}>连接</div>
                <LgRow color={UB_LEVELS[1].color} label="层内直连 L1 卡↔卡（板载）" />
                <LgRow color={UB_LEVELS[2].color} label="层内直连 L2 节点↔节点（柜内）" />
                <span style={lgNote}>竖向骨干按 UB 级别同色（L1→L4）</span>
                <LgRow color={COMM_PATTERNS[0].color} label="Ring-AllReduce（环）" />
                <LgRow color={COMM_PATTERNS[1].color} label="All-to-All（MoE）" />
                {/* selection highlight */}
                <div style={lgHdr}>选中高亮</div>
                <LgRow color="#ffb020" label="上下游链路（竖向）" />
                <LgRow color="#22d3ee" label="同级 peer mesh（卡/节点）" />
                <span style={lgNote}>单击 卡 / 刀片 / 机柜高亮 · 双击进卡</span>
                {/* run phases (phase-wash colours) */}
                <div style={lgHdr}>{`运行相位 · ${runMode === 'train' ? '训练' : '推理'}`}</div>
                {RUN_SCHED[runMode].map((ph) => <LgRow key={ph.id} shape="sq" color={ph.color} label={ph.name} />)}
                {/* live status / flow */}
                {fpStatus && (
                  <>
                    <div style={lgHdr}>状态 / 流量（节点活动）</div>
                    {STATUS_META.map((s) => <LgRow key={s.id} shape="dot" color={STATUS_COLORS[s.id]} label={s.label} />)}
                    <span style={lgNote}>连线粗细 = 带宽（节点内 L1 最粗 → scale-out 最细）</span>
                    <span style={lgNote}>当前相位活跃链路加粗发亮 = 流量 · 状态色优先于切分色</span>
                  </>
                )}
                {/* parallel partition palette */}
                {fpPart !== 'none' && (
                  <>
                    <div style={lgHdr}>{`并行切分 · ${PARTITION_META[fpPart].label}`}</div>
                    <span style={lgNote}>{`${PARTITION_META[fpPart].level} · ${fpCfg}`}</span>
                    <span style={lgNote}>{`通信：${PARTITION_META[fpPart].comm}`}</span>
                    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginTop: 2 }}>
                      {PARTITION_PALETTE.map((c, i) => <span key={i} title={`组 ${i}`} style={{ width: 14, height: 9, background: c, borderRadius: 1, display: 'inline-block' }} />)}
                    </div>
                    <span style={lgNote}>{PARTITION_META[fpPart].same}</span>
                    <span style={lgNote}>卡(device) / rank(软件) / 线程 同步上色</span>
                  </>
                )}
              </>
            )}
            {mode === 'node' && nodeKind === 'compute' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--bd)', paddingTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx2)' }}>节点内（顶栏开关）</div>
                {NODE_OVERLAYS.map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c.color, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'var(--tx2)' }}>{c.label}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── right info panel (floating overlay so it never compresses the canvas) ── */}
        {panelOpen && (
          <div style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 6,
            width: narrow ? 270 : 300, borderLeft: '1px solid var(--bd)', padding: '14px 16px',
            overflowY: 'auto', fontSize: 12.5, lineHeight: 1.65, flexShrink: 0,
            background: 'var(--panel)', color: 'var(--tx)', boxShadow: '-3px 0 12px var(--bd)',
          }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#4369ef', marginBottom: 8 }}>{info.title}</div>
            <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--tx)' }}>
              {info.lines.map((l, i) => (<li key={i} style={{ marginBottom: 5 }}>{l}</li>))}
            </ul>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>{`关键规格 · ${spec.code}`}</div>
            <table style={{ width: '100%', fontSize: 11.5, color: 'var(--tx)', borderCollapse: 'collapse' }}>
              <tbody>
                {specRows.map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '1px solid var(--bd)' }}>
                    <td style={{ padding: '3px 0', color: 'var(--tx2)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                    <td style={{ padding: '3px 0 3px 10px', color: 'var(--tx)' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>相比 A3 的演进</div>
            <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--tx)', fontSize: 11.5, lineHeight: 1.6 }}>
              {CHANGES.map((c, i) => (<li key={i} style={{ marginBottom: 4 }}>{c}</li>))}
            </ul>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>数据来源</div>
            <div style={{ fontSize: 10.5, color: 'var(--tx2)', lineHeight: 1.7 }}>
              {SOURCES.map((s, i) => (<div key={i}>{s}</div>))}
            </div>
            <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--tx2)', fontStyle: 'italic' }}>{FOOTNOTE}</div>
          </div>
        )}
      </div>
    </div>
  );
}
