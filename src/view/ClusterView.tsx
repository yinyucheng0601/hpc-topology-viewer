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
import { useCallback, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  INFO, SOURCES, CHANGES, GENERATIONS, DEFAULT_GEN, UB_LEVELS, COMM_PATTERNS,
  SCALES, DEFAULT_SCALE,
  type Gen, type RackKind, type ViewMode, type Scale,
} from '../scene/data';
import { TOK, FOOTNOTE } from '../content';
import {
  OverviewScene, RackScene, NodeScene, TopologyScene, AdjacencyScene, type CommOverlays,
} from '../scene/scenes';

const CAMERA: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [9, 10, 15], target: [0, 0.5, 0] },
  rack:     { pos: [4.6, 4.4, 8.6], target: [0, 2.8, 0] },
  node:     { pos: [3.8, 3.2, 4.6], target: [0.8, 0.6, 0] },
  topology: { pos: [0, 4.2, 13], target: [0, 2.9, 0] },
  matrix:   { pos: [0, 9, 7.5], target: [0, 0, 0] },
};

const MODE_TABS: { id: ViewMode; label: string }[] = [
  { id: 'overview', label: '全景总览' },
  { id: 'rack',     label: '机柜视图' },
  { id: 'node',     label: '节点视图' },
  { id: 'topology', label: 'UB 互联层级' },
  { id: 'matrix',   label: '邻接矩阵' },
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
  const [nodeSlot, setNodeSlot] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [scale, setScale] = useState<Scale>(DEFAULT_SCALE);
  const [overlays, setOverlays] = useState<CommOverlays>({ ring: false, a2a: false, tile: true, cores: true });

  const spec = GENERATIONS[gen];
  const onHoverInfo = useCallback((t: string | null) => setHoverInfo(t), []);
  const rackLabel = rackKind === 'compute' ? '计算柜' : '通信柜';

  const infoKey =
    mode === 'overview' ? 'overview' :
    mode === 'rack' ? (rackKind === 'compute' ? 'computeRack' : 'switchRack') :
    mode === 'node' ? 'node' :
    mode === 'matrix' ? 'matrix' : 'topology';
  const info = INFO[infoKey];

  const breadcrumb = useMemo(() => {
    const bc: { label: string; onClick?: () => void }[] = [
      { label: spec.name, onClick: mode !== 'overview' ? () => setMode('overview') : undefined },
    ];
    if (mode === 'rack' || mode === 'node') bc.push({ label: rackLabel, onClick: mode === 'node' ? () => setMode('rack') : undefined });
    if (mode === 'node') bc.push({ label: `节点 ${nodeSlot + 1}` });
    return bc;
  }, [mode, rackLabel, nodeSlot, spec.name]);

  const cam = CAMERA[mode];

  const specRows: [string, string][] = [
    ['代际 / 形态', `${spec.code} · ${spec.name}`],
    ['NPU 总数', `${spec.totalNpus.toLocaleString()}× ${spec.npuLabel}`],
    ['算力 FP8 / FP4', `${spec.fp8EF} / ${spec.fp4EF} EFLOPS`],
    ['HBM 总量', `${spec.memTB.toLocaleString()} TB · ${spec.hbm}`],
    ['单卡 HBM 带宽', `${spec.memPerChipTBs} TB/s`],
    ['单卡 UB 带宽', `${spec.chipUbTBs} TB/s`],
    ['总互联带宽', `${spec.interconnectPBs} PB/s`],
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
        {(mode === 'topology' || mode === 'node') && (
          <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid rgba(0,0,0,0.12)', paddingLeft: 12 }}>
            {(mode === 'topology' ? TOPO_OVERLAYS : NODE_OVERLAYS).map((t) => {
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
            key={`${mode}-${gen}-${scale}`}
            camera={{ position: cam.pos, fov: 42 }}
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
            onCreated={({ gl }) => { gl.shadowMap.type = THREE.PCFSoftShadowMap; }}
          >
            <color attach="background" args={['#f5f5f5']} />
            <fog attach="fog" args={['#f5f5f5', 26, 60]} />
            <ambientLight intensity={1.1} />
            <directionalLight
              position={[8, 14, 6]} intensity={1.2} castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-camera-left={-16} shadow-camera-right={16}
              shadow-camera-top={16} shadow-camera-bottom={-16}
            />
            <pointLight position={[0, 10, 0]} intensity={1.0} color="#e8f0ff" />

            {mode === 'overview' && (
              <OverviewScene gen={spec} onHoverInfo={onHoverInfo} onSelectRack={(k) => { setRackKind(k); setMode('rack'); }} />
            )}
            {mode === 'rack' && (
              <RackScene rackKind={rackKind} label={rackLabel} onHoverInfo={onHoverInfo} onSelectNode={(slot) => { setNodeSlot(slot); setMode('node'); }} />
            )}
            {mode === 'node' && <NodeScene onHoverInfo={onHoverInfo} overlays={overlays} />}
            {mode === 'topology' && <TopologyScene gen={spec} overlays={overlays} onHoverInfo={onHoverInfo} />}
            {mode === 'matrix' && <AdjacencyScene scale={scale} onHoverInfo={onHoverInfo} />}

            <OrbitControls
              target={cam.target}
              enableDamping dampingFactor={0.08}
              minPolarAngle={0.1} maxPolarAngle={Math.PI / 2 - 0.04}
              minDistance={1.2} maxDistance={60}
            />
          </Canvas>

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
            <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,0.75)' }}>{`${TOK.ub} UB 互联层级（颜色 = 级别）`}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {UB_LEVELS.map((lv) => (
                <span key={lv.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 3, background: lv.color, display: 'inline-block', borderRadius: 1 }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>{`${lv.id} ${lv.label}`}</span>
                </span>
              ))}
            </div>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(0,0,0,0.6)' }}>单元格</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 8, background: '#3a4256', display: 'inline-block', borderRadius: 1 }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>对角（自身）</span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 8, background: '#dfe3ea', display: 'inline-block', borderRadius: 1 }} />
                  <span style={{ color: 'rgba(0,0,0,0.6)' }}>多跳（非直连）</span>
                </span>
                <span style={{ color: 'rgba(0,0,0,0.5)', fontSize: 10 }}>其余=按 UB 级别着色（直连）</span>
              </div>
            )}
            {mode === 'node' && (
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
