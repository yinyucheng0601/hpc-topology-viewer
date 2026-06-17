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
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  INFO, SOURCES, CHANGES, GENERATIONS, DEFAULT_GEN, UB_LEVELS, COMM_PATTERNS,
  SCALES, DEFAULT_SCALE, TRACE_SCHED, PHASE_META,
  type Gen, type RackKind, type ViewMode, type Scale,
} from '../scene/data';
import { TOK, FOOTNOTE } from '../content';
import {
  OverviewScene, RackScene, NodeScene, TopologyScene, AdjacencyScene, UBSwitchScene, MappingScene, TraceScene, FullPodScene,
  type CommOverlays, type LocateTarget, type UbJump,
} from '../scene/scenes';

/** Imperatively reposition camera + controls when the view changes, without
 *  remounting the Canvas (remounting creates a new WebGL context each time and
 *  exhausts the browser's context limit → blank canvas needing refresh). */
function CameraController({ poseKey, pos, target, controls }: {
  poseKey: string; pos: [number, number, number]; target: [number, number, number];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controls: React.MutableRefObject<any>;
}) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.updateProjectionMatrix();
    if (controls.current) { controls.current.target.set(target[0], target[1], target[2]); controls.current.update(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poseKey]);
  return null;
}

const CAMERA: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [9, 10, 15], target: [0, 0.5, 0] },
  rack:     { pos: [4.6, 4.4, 8.6], target: [0, 2.8, 0] },
  node:     { pos: [0, 3.8, 6.6], target: [0, 0.7, 0] },
  topology: { pos: [0, 4.2, 13], target: [0, 2.9, 0] },
  matrix:   { pos: [0, 3.4, 13.5], target: [0, 2, 0] },
  mapping:  { pos: [0, 2.3, 11.5], target: [0, 2.3, 0] },
  trace:    { pos: [0, 3.2, 13.5], target: [0, 3.1, 0] },
  fullpod:  { pos: [0, 7, 13], target: [0, 0.6, 0] },
};

const MODE_TABS: { id: ViewMode; label: string }[] = [
  { id: 'overview', label: '全景总览' },
  { id: 'rack',     label: '机柜视图' },
  { id: 'node',     label: '节点视图' },
  { id: 'topology', label: 'UB 互联层级' },
  { id: 'matrix',   label: '邻接矩阵' },
  { id: 'mapping',  label: '软硬件映射' },
  { id: 'trace',    label: '线程时序' },
  { id: 'fullpod',  label: '整列全景(多卡)' },
];

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
  const [panelOpen, setPanelOpen] = useState(true);
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
  const [pendingNpu, setPendingNpu] = useState<number | undefined>(undefined);   // preselect NPU's die on node drill

  useEffect(() => {
    if (!tracePlaying) return;
    const id = setInterval(() => setTraceTick((t) => ((t ?? -1) + 1) % TRACE_SCHED.length), 750);
    return () => clearInterval(id);
  }, [tracePlaying]);

  const spec = GENERATIONS[gen];
  const onHoverInfo = useCallback((t: string | null) => setHoverInfo(t), []);
  const rackLabel = rackKind === 'compute' ? '计算柜' : '通信柜';

  const infoKey =
    mode === 'overview' ? 'overview' :
    mode === 'rack' ? (rackKind === 'compute' ? 'computeRack' : 'switchRack') :
    mode === 'node' ? (nodeKind === 'ubswitch' ? 'ubswitch' : 'node') :
    mode === 'matrix' ? 'matrix' :
    mode === 'mapping' ? 'mapping' :
    mode === 'trace' ? 'trace' :
    mode === 'fullpod' ? 'fullpod' : 'topology';
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
  const cam = mode === 'node' && nodeKind === 'ubswitch'
    ? { pos: [2.9, 2.5, 3.6] as [number, number, number], target: [0, 0.7, 0] as [number, number, number] }
    : mode === 'fullpod'
    ? { pos: [0, fpReach * 0.62, fpReach * 1.02] as [number, number, number], target: [0, Math.min(6, fpReach * 0.1), 0] as [number, number, number] }
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
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#f5f5f5', color: 'rgba(0,0,0,0.90)' }}>
      {/* ── toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid rgba(0,0,0,0.12)', flexWrap: 'wrap', background: 'white' }}>
        {/* generation switch */}
        <div style={{ display: 'flex', gap: 4, borderRight: '1px solid rgba(0,0,0,0.12)', paddingRight: 12 }}>
          {(Object.keys(GENERATIONS) as Gen[]).map((g) => (
            <button
              key={g}
              onClick={() => setGen(g)}
              title={GENERATIONS[g].name}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${gen === g ? '#4369ef' : 'rgba(0,0,0,0.12)'}`,
                background: gen === g ? 'rgba(67,105,239,0.10)' : 'transparent',
                color: gen === g ? '#4369ef' : 'rgba(0,0,0,0.55)',
              }}
            >
              {g}
            </button>
          ))}
        </div>
        {/* mode tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {MODE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              style={{
                padding: '5px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${mode === t.id ? '#4369ef' : 'rgba(0,0,0,0.12)'}`,
                background: mode === t.id ? 'rgba(67,105,239,0.10)' : 'transparent',
                color: mode === t.id ? '#4369ef' : 'rgba(0,0,0,0.55)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* per-mode overlay toggles: process(rank) in UB view, tile/cores in node view */}
        {(mode === 'topology' || mode === 'fullpod' || (mode === 'node' && nodeKind === 'compute')) && (
          <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid rgba(0,0,0,0.12)', paddingLeft: 12 }}>
            {(mode === 'node' ? NODE_OVERLAYS : TOPO_OVERLAYS).map((t) => {
              const on = overlays[t.id];
              return (
                <button
                  key={t.id}
                  onClick={() => setOverlays((o) => ({ ...o, [t.id]: !o[t.id] }))}
                  style={{
                    padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    border: `1px solid ${on ? t.color : 'rgba(0,0,0,0.12)'}`,
                    background: on ? `${t.color}22` : 'transparent',
                    color: on ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.5)',
                  }}
                >
                  <span style={{ width: 9, height: 3, background: t.color, display: 'inline-block', borderRadius: 1, opacity: on ? 1 : 0.4 }} />
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
        {/* scale selector (adjacency-matrix view) */}
        {mode === 'matrix' && (
          <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid rgba(0,0,0,0.12)', paddingLeft: 12 }}>
            {(Object.keys(SCALES) as Scale[]).map((s) => (
              <button
                key={s}
                onClick={() => setScale(s)}
                style={{
                  padding: '4px 12px', fontSize: 11.5, borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${scale === s ? '#4369ef' : 'rgba(0,0,0,0.12)'}`,
                  background: scale === s ? 'rgba(67,105,239,0.10)' : 'transparent',
                  color: scale === s ? '#4369ef' : 'rgba(0,0,0,0.55)',
                }}
              >{SCALES[s].label}</button>
            ))}
          </div>
        )}
        {/* full-pod scale — only two, side by side: 64P single cabinet ↔ full super-node */}
        {mode === 'fullpod' && (
          <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid rgba(0,0,0,0.12)', paddingLeft: 12 }}>
            {([[false, '64P 单柜'], [true, `全量超节点(${spec.totalNpus >= 1000 ? Math.round(spec.totalNpus / 1000) + 'K' : spec.totalNpus})`]] as [boolean, string][]).map(([v, label]) => (
              <button
                key={label}
                onClick={() => setFpFull(v)}
                title={v ? `渲染整座超节点全部 ${spec.totalNpus.toLocaleString()} 张卡（阵列）` : '单柜 64 卡（8 刀片 × 8 卡）'}
                style={{
                  padding: '4px 12px', fontSize: 11.5, borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${fpFull === v ? '#4369ef' : 'rgba(0,0,0,0.12)'}`,
                  background: fpFull === v ? 'rgba(67,105,239,0.10)' : 'transparent',
                  color: fpFull === v ? '#4369ef' : 'rgba(0,0,0,0.55)',
                }}
              >{label}</button>
            ))}
          </div>
        )}
        {/* super-node count (full-pod view) */}
        {mode === 'fullpod' && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', borderLeft: '1px solid rgba(0,0,0,0.12)', paddingLeft: 12 }}>
            <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.5)' }}>超节点</span>
            {[1, 2, 4].map((c) => (
              <button
                key={c}
                onClick={() => setPodCount(c)}
                style={{
                  padding: '4px 10px', fontSize: 11.5, borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${podCount === c ? '#4369ef' : 'rgba(0,0,0,0.12)'}`,
                  background: podCount === c ? 'rgba(67,105,239,0.10)' : 'transparent',
                  color: podCount === c ? '#4369ef' : 'rgba(0,0,0,0.55)',
                }}
              >{`×${c}`}</button>
            ))}
          </div>
        )}
        {/* breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
          {breadcrumb.map((b, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span style={{ color: 'rgba(0,0,0,0.42)' }}>›</span>}
              <span onClick={b.onClick} style={b.onClick ? { cursor: 'pointer', color: '#4369ef' } : { color: 'rgba(0,0,0,0.75)' }}>{b.label}</span>
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.55)' }}>{`${spec.name} · ${spec.totalNpus.toLocaleString()}× ${spec.npuShort} · ${TOK.ub} UB 全互联`}</span>
        <button
          onClick={() => setPanelOpen((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}
        >
          {panelOpen ? '收起信息 ▸' : '◂ 信息面板'}
        </button>
      </div>

      {/* ── main: Canvas + info panel ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <Canvas
            camera={{ position: cam.pos, fov: 42 }}
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1, powerPreference: 'high-performance' }}
            onCreated={({ gl }) => {
              gl.shadowMap.type = THREE.PCFSoftShadowMap;
              // allow the browser to auto-restore a lost context instead of going blank
              gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
            }}
          >
            <CameraController poseKey={`${mode}-${gen}-${scale}-${nodeKind}-${podCount}-${fpFull}`} pos={cam.pos} target={cam.target} controls={controlsRef} />
            <color attach="background" args={['#f5f5f5']} />
            <fog attach="fog" args={['#f5f5f5', mode === 'fullpod' ? 90 : 26, mode === 'fullpod' ? 420 : 60]} />
            <ambientLight intensity={1.1} />
            <directionalLight
              position={[8, 14, 6]} intensity={1.2} castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-camera-left={-16} shadow-camera-right={16}
              shadow-camera-top={16} shadow-camera-bottom={-16}
            />
            <pointLight position={[0, 10, 0]} intensity={1.0} color="#e8f0ff" />

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
            {mode === 'fullpod' && <FullPodScene scale="64P" podCount={podCount} full={fpFull} gen={spec} overlays={overlays} tick={traceTick} onHoverInfo={onHoverInfo} onPick={(loc) => { setRackKind('compute'); setNodeKind('compute'); setPendingNpu(loc); setMode('node'); }} />}

            <OrbitControls
              ref={controlsRef}
              enableDamping dampingFactor={0.08}
              minPolarAngle={0.1} maxPolarAngle={Math.PI / 2 - 0.04}
              minDistance={1.2} maxDistance={mode === 'fullpod' ? 360 : 60}
            />
          </Canvas>

          {/* trace → jump-to-view controls */}
          {mode === 'trace' && locate && (
            <div style={{
              position: 'absolute', left: 14, top: 14, display: 'flex', gap: 8, alignItems: 'center',
              padding: '7px 12px', fontSize: 12, background: 'rgba(255,255,255,0.96)',
              border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6,
            }}>
              <span style={{ color: 'rgba(0,0,0,0.7)' }}>{`已选 rank ${locate.rank}（刀片 B${locate.blade}）：`}</span>
              <button
                onClick={() => { setHl({ npu: locate.rank, blade: locate.blade, cabinet: 0 }); setMode('topology'); }}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid #4369ef', background: 'rgba(67,105,239,0.10)', color: '#4369ef' }}
              >→ UB 互联高亮</button>
              <button
                onClick={() => { setHl({ npu: locate.rank, blade: locate.blade, cabinet: 0 }); setMode('overview'); }}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid #4369ef', background: 'rgba(67,105,239,0.10)', color: '#4369ef' }}
              >→ 全景高亮机柜</button>
              {hl && (
                <button
                  onClick={() => setHl(null)}
                  style={{ padding: '4px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}
                >清除高亮</button>
              )}
            </div>
          )}

          {/* IO-die → UB linkage banner */}
          {ubFocus && (mode === 'topology' || mode === 'matrix') && (
            <div style={{
              position: 'absolute', left: 14, top: 14, display: 'flex', gap: 8, alignItems: 'center',
              padding: '6px 11px', fontSize: 12, background: 'rgba(255,255,255,0.96)',
              border: '1px solid #4369ef', borderRadius: 6, color: '#4369ef',
            }}>
              <span>{`来自 IO Die：${ubFocus === 'ccu' ? `高亮 ${TOK.ccu} 集合通信` : ubFocus === 'onchip' ? `高亮 ${TOK.onchip} 转发` : '该端口实现的 NPU↔NPU UB 互联（邻接矩阵）'}`}</span>
              <button onClick={() => { setUbFocus(null); setMode('node'); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}>← 回节点</button>
              <button onClick={() => setUbFocus(null)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}>清除</button>
            </div>
          )}

          {/* active highlight banner in topology/overview */}
          {hl && (mode === 'topology' || mode === 'overview') && (
            <div style={{
              position: 'absolute', left: 14, top: 14, display: 'flex', gap: 8, alignItems: 'center',
              padding: '6px 11px', fontSize: 12, background: 'rgba(255,255,255,0.96)',
              border: '1px solid #4369ef', borderRadius: 6, color: '#4369ef',
            }}>
              <span>{`定位高亮：rank ${hl.npu} · 刀片 B${hl.blade} · 机柜 C${hl.cabinet}`}</span>
              <button onClick={() => { setHl(null); setMode('trace'); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}>← 回时序</button>
              <button onClick={() => setHl(null)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.55)' }}>清除</button>
            </div>
          )}

          {/* trace timeline media control (HTML overlay, not a 3D object) */}
          {(mode === 'trace' || mode === 'fullpod') && (
            <div style={{
              position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 14,
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              background: 'rgba(255,255,255,0.96)', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8,
            }}>
              <button
                onClick={() => { setTracePlaying((v) => !v); if (traceTick === null) setTraceTick(0); }}
                style={{ width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', border: '1px solid #4369ef', background: tracePlaying ? '#4369ef' : 'white', color: tracePlaying ? 'white' : '#4369ef', fontSize: 13 }}
              >{tracePlaying ? '⏸' : '▶'}</button>
              {/* phase scrubber */}
              <div style={{ display: 'flex', gap: 2 }}>
                {TRACE_SCHED.map((ph, k) => (
                  <button
                    key={k}
                    title={PHASE_META[ph].name}
                    onClick={() => { setTracePlaying(false); setTraceTick(k); }}
                    style={{
                      width: 26, height: 18, cursor: 'pointer', borderRadius: 3,
                      border: traceTick === k ? '2px solid #1c2433' : '1px solid rgba(0,0,0,0.12)',
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
                <button onClick={() => { setTracePlaying(false); setTraceTick(null); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'rgba(0,0,0,0.5)' }}>复位</button>
              )}
            </div>
          )}

          {/* hover info bar */}
          {hoverInfo && (
            <div style={{
              position: 'absolute', left: 14, bottom: 14, maxWidth: '70%',
              padding: '7px 12px', fontSize: 12.5, lineHeight: 1.5,
              background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6,
              color: 'rgba(0,0,0,0.90)', pointerEvents: 'none',
            }}>{hoverInfo}</div>
          )}

          {/* legend: UB hierarchy levels (+ comm overlays in node view) */}
          <div style={{
            position: 'absolute', right: 14, bottom: 14, padding: '8px 12px', fontSize: 11.5,
            background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6,
            display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none', maxWidth: 240,
          }}>
            {mode === 'mapping' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>软硬件映射</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: '#4369ef', display: 'inline-block' }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>进程 rank ↔ NPU</span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: COMM_PATTERNS[2].color, display: 'inline-block' }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>线程 / Tile ↔ AI Core</span>
                </span>
                <span style={{ color: 'rgba(0,0,0,0.5)', fontSize: 10 }}>灰线 = 其他层级映射 · 点击高亮</span>
              </>
            )}
            {mode === 'trace' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>时序 / 定位</div>
                {([['计算（线程）', COMM_PATTERNS[2].color], ['通信 AllReduce（进程）', COMM_PATTERNS[0].color], ['加载 / 存储', '#c2c9d4']] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 8, background: c, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'rgba(0,0,0,0.6)' }}>{t}</span>
                  </span>
                ))}
                <span style={{ color: 'rgba(0,0,0,0.5)', fontSize: 10 }}>点击线程/进程 → 顶部定位 NPU/刀片/机柜</span>
              </>
            )}
            {mode !== 'matrix' && mode !== 'mapping' && mode !== 'trace' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>{`${TOK.ub} UB 互联层级（颜色 = 级别）`}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {UB_LEVELS.map((lv) => (
                    <span key={lv.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 12, height: 3, background: lv.color, display: 'inline-block', borderRadius: 1 }} />
                      <span style={{ color: 'rgba(0,0,0,0.6)' }}>{`${lv.id} ${lv.label}`}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
            {mode === 'topology' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(0,0,0,0.6)' }}>进程级通信（顶栏开关）</div>
                {COMM_PATTERNS.slice(0, 2).map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c.color, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'rgba(0,0,0,0.6)' }}>{c.label}</span>
                  </span>
                ))}
              </div>
            )}
            {mode === 'matrix' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>图例</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(0,0,0,0.55)' }}>矩阵格子（行 i × 列 j = 两颗 NPU）</div>
                {([['L1 直连·板内', UB_LEVELS[1].color], ['L2 直连·跨板', UB_LEVELS[2].color], ['L3 直连·跨柜（更大规模）', UB_LEVELS[3].color], ['多跳·非直连', '#dfe3ea'], ['对角·自身', '#3a4256']] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 8, background: c, display: 'inline-block', borderRadius: 1, border: '1px solid rgba(0,0,0,0.08)' }} />
                    <span style={{ color: 'rgba(0,0,0,0.6)' }}>{t}</span>
                  </span>
                ))}
                <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(0,0,0,0.55)', marginTop: 2 }}>右侧 3D 结构</div>
                {([['UB 直连 L1（板内）', UB_LEVELS[1].color], ['UB 直连 L2（跨板）', UB_LEVELS[2].color]] as [string, string][]).map(([t, c]) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'rgba(0,0,0,0.6)' }}>{t}</span>
                  </span>
                ))}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 10, background: '#f2f4f8', display: 'inline-block', borderRadius: 1, border: '1px solid rgba(0,0,0,0.15)' }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>刀片(板)框 · 外框 = 单柜</span>
                </span>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(0,0,0,0.55)', marginTop: 2 }}>联动高亮</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: '#4369ef', display: 'inline-block' }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>十字 = 行 i / 列 j；i·j = 对应两颗 NPU</span>
                </span>
              </div>
            )}
            {mode === 'node' && nodeKind === 'compute' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(0,0,0,0.6)' }}>节点内（顶栏开关）</div>
                {NODE_OVERLAYS.map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 3, background: c.color, display: 'inline-block', borderRadius: 1 }} />
                    <span style={{ color: 'rgba(0,0,0,0.6)' }}>{c.label}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── right info panel ── */}
        {panelOpen && (
          <div style={{
            width: 300, borderLeft: '1px solid rgba(0,0,0,0.12)', padding: '14px 16px',
            overflowY: 'auto', fontSize: 12.5, lineHeight: 1.65, flexShrink: 0,
            background: 'white', color: 'rgba(0,0,0,0.90)',
          }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#4369ef', marginBottom: 8 }}>{info.title}</div>
            <ul style={{ margin: 0, paddingLeft: 16, color: 'rgba(0,0,0,0.75)' }}>
              {info.lines.map((l, i) => (<li key={i} style={{ marginBottom: 5 }}>{l}</li>))}
            </ul>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>{`关键规格 · ${spec.code}`}</div>
            <table style={{ width: '100%', fontSize: 11.5, color: 'rgba(0,0,0,0.75)', borderCollapse: 'collapse' }}>
              <tbody>
                {specRows.map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                    <td style={{ padding: '3px 0', color: 'rgba(0,0,0,0.55)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                    <td style={{ padding: '3px 0 3px 10px', color: 'rgba(0,0,0,0.90)' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>相比 A3 的演进</div>
            <ul style={{ margin: 0, paddingLeft: 16, color: 'rgba(0,0,0,0.7)', fontSize: 11.5, lineHeight: 1.6 }}>
              {CHANGES.map((c, i) => (<li key={i} style={{ marginBottom: 4 }}>{c}</li>))}
            </ul>

            <div style={{ margin: '14px 0 6px', fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>数据来源</div>
            <div style={{ fontSize: 10.5, color: 'rgba(0,0,0,0.55)', lineHeight: 1.7 }}>
              {SOURCES.map((s, i) => (<div key={i}>{s}</div>))}
            </div>
            <div style={{ marginTop: 10, fontSize: 10.5, color: 'rgba(0,0,0,0.55)', fontStyle: 'italic' }}>{FOOTNOTE}</div>
          </div>
        )}
      </div>
    </div>
  );
}
