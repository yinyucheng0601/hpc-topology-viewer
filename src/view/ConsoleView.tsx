/**
 * ConsoleView — 联动控制台. One linked module fusing the three existing views per the reference
 * Smartscape (Dynatrace-style) interaction:
 *   · LEFT  = 平面视图「层级图」改造成 Smartscape 层级 (集群→超节点→机柜→节点→卡 + 卡内 Die/Core/Tile)，
 *             作为控制：点一个实体只展开/高亮它的「链路」(祖先+后代，按方向过滤)。
 *   · RIGHT = 阵列全景 (FullPodScene, 全量超节点) 作为主视图：scopeOnly 模式只显示左侧链路的内容
 *             (链路内按状态/负载上色，链路外全部压暗)。
 *   · 运行状态 = 分析仪表 (集群 KPI · 实体辅助指标 · DAVIS 根因)。
 *
 * 所有样式/图元/状态/连接/上下层级与层内关系都用既有方案：FullPodScene 组件 + 同一套 data.ts
 * 色彩/状态/负载函数 (loadColor / loadState / stateColor / nodeLoad / isHot / ENTITY_COLORS / PLANES)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  GENERATIONS, ENTITY_COLORS, PARALLEL_COLORS, PARTITION_META, PLANES, LEVEL_PHYS,
  loadColor, loadState, stateColor, STATE_LABELS, nodeLoad, isHot,
  type Gen, type PartitionDim, type RunPhase, type RunMode,
} from '../scene/data';
import { TOK } from '../content';
import { FullPodScene, SceneTheme, type CommOverlays } from '../scene/scenes';

// ── hierarchy fan-out (8×8 schematic shared with FullPodScene full=true): 8 卡/刀片 · 8 刀片/柜 →
//    64 卡/柜. A global card index `k` maps the SAME way in the left 层级 and the right 3D array. ──
const CPB = 8, BPC = 8, PER_CAB = CPB * BPC;
const STEP_MAX = 60, EVT_LO = 34, EVT_HI = 46, EVT_CAB = 1;   // injected 过热 window on cabinet C1

type Workload = 'pretrain' | 'prefill' | 'decode';
type Metric = 'util' | 'strag' | 'fault';
type Lens = 'heat' | 'flow' | 'domain' | 'phys';
type Dir = 'all' | 'up' | 'down';
type Level = 'cluster' | 'super' | 'cab' | 'node' | 'card' | 'die' | 'core' | 'tile';
type Focus = { level: Level; card: number; die?: number; core?: number } | null;

const WL: Record<Workload, { label: string; kind: RunPhase['kind'] }> = {
  pretrain: { label: '预训练', kind: 'compute' },
  prefill: { label: 'Prefill', kind: 'compute' },
  decode: { label: 'Decode', kind: 'comm' },
};
const M_LABEL: Record<Metric, string> = { util: '利用率', strag: '掉队率', fault: '故障度' };
const LENS_LABEL: Record<Lens, string> = { heat: '状态热力', flow: '机柜流量', domain: '通信域', phys: '物理链路' };
const LEVEL_NAME: Record<string, string> = { cluster: '集群', super: '超节点', cab: '机柜', node: '节点', card: '卡 rank', die: '计算 Die', core: 'AI Core', tile: 'Tile' };

// ── metric model (deterministic, mirrors 运行状态) ──
const rnd = (s: number) => { const x = Math.sin(s * 99.13) * 43758.5453; return x - Math.floor(x); };
function cardLoad(k: number, wlKind: string, step: number): number {
  let v = nodeLoad(k, wlKind) + (rnd(k * 0.91 + step * 0.07) - 0.5) * 0.06;
  if (step >= EVT_LO && step <= EVT_HI && Math.floor(k / PER_CAB) === EVT_CAB) v += 0.22 * Math.sin((step - EVT_LO) / (EVT_HI - EVT_LO) * Math.PI);
  return Math.max(0, Math.min(1, v));
}
function isStrag(k: number, step: number): boolean {
  let thr = 0.93;
  if (step >= EVT_LO && step <= EVT_HI && Math.floor(k / PER_CAB) === EVT_CAB) thr = 0.55;
  return rnd(k * 1.7 + step * 0.05) > thr;
}
function isFault(k: number, step: number): boolean {
  const inEvt = step >= EVT_LO && step <= EVT_HI && Math.floor(k / PER_CAB) === EVT_CAB && Math.floor(k / CPB) % BPC === 1;
  return inEvt ? rnd(k * 0.7) > 0.25 : rnd(k * 0.7 + 13) > 0.985;
}
function cardMetric(k: number, metric: Metric, wlKind: string, step: number): number {
  if (metric === 'fault') return isFault(k, step) ? 0.95 : 0.1;
  if (metric === 'strag') return isStrag(k, step) ? 0.88 : Math.max(0, cardLoad(k, wlKind, step) - 0.5) * 0.4;
  return cardLoad(k, wlKind, step);
}

// ── hierarchy navigation / scope (matches the reference HTML scopeOf/isHi) ──
const levelIdx = (lv: Level): number => (lv === 'cluster' ? 0 : lv === 'super' ? 1 : lv === 'cab' ? 2 : lv === 'node' ? 3 : 4);
function scopeRange(f: Focus, N: number): [number, number] {
  if (!f || f.level === 'cluster' || f.level === 'super') return [0, N];
  if (f.level === 'cab') { const c = Math.floor(f.card / PER_CAB); return [c * PER_CAB, Math.min(N, (c + 1) * PER_CAB)]; }
  if (f.level === 'node') { const n = Math.floor(f.card / CPB); return [n * CPB, Math.min(N, (n + 1) * CPB)]; }
  return [f.card, f.card + 1];
}
// which entity indices of tier Le are on the focus's chain (ancestor / self / descendant), dir-filtered.
// returns null = "no focus → overview (show all, capped)".
function tierInScope(Le: number, focus: Focus, dir: Dir, N: number, nCabs: number, nBlades: number): number[] | null {
  if (!focus || focus.level === 'cluster') return null;
  const Lf = levelIdx(focus.level);
  const counts = [1, 1, nCabs, nBlades, N];
  const div = [N, N, PER_CAB, CPB, 1][Le];
  const [flo, fhi] = scopeRange(focus, N);
  const range = (a: number, b: number) => { const o: number[] = []; for (let i = a; i < b; i++) o.push(i); return o; };
  const cabMates = () => { const cab = Math.floor(flo / PER_CAB); return range(cab * BPC, Math.min(nBlades, (cab + 1) * BPC)); };   // 同柜 8 节点 (UB mesh, 同低保真 node-tier 特例)
  if (Le < Lf) {                          // ancestor
    if (dir === 'down') return [];
    if (dir === 'all' && Le === 3 && Lf >= 3) return cabMates();
    return [Math.floor(flo / div)];
  }
  if (Le === Lf) {                        // focus tier (node tier expands to same-cab UB mates on 全链)
    if (dir === 'all' && Le === 3) return cabMates();
    return [Math.floor(flo / div)];
  }
  if (dir === 'up') return [];            // descendant
  return range(Math.floor(flo / div), Math.min(counts[Le], Math.floor((fhi - 1) / div) + 1));
}
function entityToFocus(Le: number, idx: number): Focus {
  if (Le === 0) return null;                                  // cluster = clear (whole)
  if (Le === 1) return { level: 'super', card: 0 };
  if (Le === 2) return { level: 'cab', card: idx * PER_CAB };
  if (Le === 3) return { level: 'node', card: idx * CPB };
  return { level: 'card', card: idx };
}
function focusToSel(f: Focus): { lv: number; i: number } | null {
  if (!f || f.level === 'cluster' || f.level === 'super') return null;
  if (f.level === 'cab') return { lv: 2, i: Math.floor(f.card / PER_CAB) };
  if (f.level === 'node') return { lv: 1, i: Math.floor(f.card / CPB) };
  return { lv: 0, i: f.card };
}
function selToFocus(s: { lv: number; i: number } | null): Focus {
  if (!s) return null;
  if (s.lv === 2) return { level: 'cab', card: s.i * PER_CAB };
  if (s.lv === 1) return { level: 'node', card: s.i * CPB };
  return { level: 'card', card: s.i };
}
function focusName(f: Focus): string {
  if (!f || f.level === 'cluster' || f.level === 'super') return '全量超节点';
  const k = f.card;
  if (f.level === 'cab') return `机柜 C${Math.floor(k / PER_CAB)}`;
  if (f.level === 'node') return `节点 B${Math.floor(k / CPB)}`;
  if (f.level === 'card') return `卡 r${k}（device）`;
  if (f.level === 'die') return `卡 ${k} · 计算 Die ${f.die ?? 0}`;
  if (f.level === 'core') return `卡 ${k} · AI Core #${f.core ?? 0}`;
  return `卡 ${k} · Tile`;
}

// ── shared button language ──
const ACCENT = '#4369ef';
const SECONDARY: React.CSSProperties = { border: '1px solid var(--button-secondary-border)', background: 'var(--button-secondary-bg)', color: 'var(--foreground-muted)' };
function ink(hex: string): string { const h = hex.replace('#', ''); if (h.length < 6) return '#fff'; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#10131a' : '#fff'; }
function navBtn(on: boolean): React.CSSProperties { return on ? { border: '1px solid var(--primary)', background: 'var(--primary)', color: 'var(--primary-foreground)', fontWeight: 600, transform: 'translateY(-1px)', boxShadow: '0 1px 3px rgba(67,105,239,0.40)' } : { ...SECONDARY }; }
function toggleBtn(on: boolean, c: string): React.CSSProperties { return on ? { border: `1px solid ${c}`, background: c, color: ink(c), fontWeight: 600 } : { ...SECONDARY }; }
const GLAB: React.CSSProperties = { fontSize: 11, fontWeight: 500, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--tx3)', alignSelf: 'center' };
const TNUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const btnBase: React.CSSProperties = { padding: '4px 10px', fontSize: 11.5, borderRadius: 8, cursor: 'pointer' };
const OVERLAYS: CommOverlays = { ring: false, a2a: false, tile: true, cores: true };

// Frame the orthographic camera on the focused scope (pan target + zoom); with no focus it settles
// on the whole-field overview. Animates on focus CHANGE then releases, so the user can still orbit/zoom.
function FrameCamera({ bounds, reach, controls }: { bounds: { cx: number; cy: number; cz: number; r: number } | null; reach: number; controls: React.MutableRefObject<{ target: THREE.Vector3; update: () => void } | null> }) {
  const { camera, size } = useThree();
  const init = useRef(false);
  const settling = useRef(true);
  const tgt = useMemo(() => (bounds
    ? { pos: new THREE.Vector3(bounds.cx, bounds.cy, bounds.cz), worldH: bounds.r * 2.4 }
    : { pos: new THREE.Vector3(0, Math.min(6, reach * 0.1), 0), worldH: Math.max(14, reach * 1.5) }), [bounds, reach]);
  useEffect(() => { settling.current = true; }, [tgt]);   // re-animate whenever the scope changes
  useEffect(() => {                                        // set the 2.5-D iso direction + distance once
    if (init.current || size.height < 10) return; init.current = true;
    camera.position.copy(tgt.pos).addScaledVector(new THREE.Vector3(1, 0.82, 1).normalize(), reach * 1.3);
    camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, reach, size.height]);
  useFrame(() => {
    if (!controls.current || !settling.current || size.height < 10) return;
    controls.current.target.lerp(tgt.pos, 0.14);
    const oc = camera as THREE.OrthographicCamera, want = size.height / tgt.worldH;
    if (oc.isOrthographicCamera) { oc.zoom += (want - oc.zoom) * 0.14; oc.updateProjectionMatrix(); }
    controls.current.update();
    if (controls.current.target.distanceTo(tgt.pos) < 0.08 && Math.abs((oc.zoom ?? want) - want) < 0.06) settling.current = false;
  });
  return null;
}

// ── stats (per-tier distributions + KPI) computed in one pass over all cards ──
interface Stats {
  kpi: { util: number; hot: number; strag: number; faultDom: number };
  clusterMean: number; cabVals: number[]; ndVals: number[]; cardVals: number[];
  agg: Record<'cluster' | 'cab' | 'node' | 'card', { p50: number; p95: number; red: number }>;
}

// ── LEFT: Smartscape 层级 (改造自平面视图层级图) — 图元/配色与「层级图」「选中链路·层级图」统一：
//    超节点=玫紫 pill · 机柜=紫 · 节点/刀片=天蓝 · 卡=teal 卡图元(2×2 Die 点) · Die/Core/Tile=网格。
//    结构用图元+位置区分(不抢状态色)；播放时叠加 红黄绿 负载色，空闲时显层级色 (同低保真层级图)。从 L5 起，无集群层。 ──
const SVG_W = 600, SVG_H = 680, X0 = 118, X1 = 586, BUDGET = 26;
const TIERS = [
  { Le: 1, key: 'super', y: 46, h: 22, maxW: 168, tag: 'L5', label: '超节点', col: ENTITY_COLORS.super },
  { Le: 2, key: 'cab', y: 116, h: 17, maxW: 56, tag: '', label: '机柜', col: ENTITY_COLORS.cab },
  { Le: 3, key: 'node', y: 188, h: 15, maxW: 52, tag: 'L4', label: '节点/刀片', col: ENTITY_COLORS.node },
  { Le: 4, key: 'card', y: 268, h: 17, maxW: 20, tag: 'L3', label: '卡 rank', col: ENTITY_COLORS.card },
] as const;
const SUBTIERS = [
  { key: 'die', lvl: 'die' as Level, y: 346, cols: 4, cell: 30, gap: 10, n: 4, seed: 131, tag: 'L2', label: '计算 Die', col: (i: number) => (i < 2 ? ENTITY_COLORS.computeDie : ENTITY_COLORS.ioDie) },
  { key: 'core', lvl: 'core' as Level, y: 432, cols: 16, cell: 14, gap: 3, n: 32, seed: 517, tag: 'L1', label: 'AI Core', col: (i: number) => (i % 8 === 7 ? ENTITY_COLORS.vector : ENTITY_COLORS.cube) },
  { key: 'tile', lvl: 'tile' as Level, y: 532, cols: 16, cell: 11, gap: 3, n: 48, seed: 911, tag: 'L0', label: 'Tile', col: () => ENTITY_COLORS.vector },
] as const;

function Smartscape({ N, nCabs, nBlades, focus, setFocus, metric, wlKind, step, dir, planeOn, playing, stats, dark }: {
  N: number; nCabs: number; nBlades: number; focus: Focus; setFocus: (f: Focus) => void;
  metric: Metric; wlKind: string; step: number; dir: Dir; planeOn: { ub: boolean; rdma: boolean; vpc: boolean }; playing: boolean; stats: Stats; dark: boolean;
}) {
  const P = dark
    ? { ink: '#e6ebf2', ink2: '#9aa6b4', ink3: '#5f6b79', line: '#2a323d', pill: '#1b212b', pillBd: '#2a323d', die: 'rgba(9,13,20,0.55)' }
    : { ink: '#1c2433', ink2: '#5b6573', ink3: '#9099a8', line: '#d6dbe4', pill: '#eef1f6', pillBd: '#d2d8e2', die: 'rgba(255,255,255,0.55)' };
  const total = (Le: number) => [1, 1, nCabs, nBlades, N][Le];
  const metricOf = (Le: number, idx: number): number =>
    Le <= 1 ? stats.clusterMean : Le === 2 ? (stats.cabVals[idx] ?? 0) : Le === 3 ? (stats.ndVals[idx] ?? 0) : cardMetric(idx, metric, wlKind, step);
  const aggOf = (Le: number) => (Le <= 1 ? stats.agg.cluster : Le === 2 ? stats.agg.cab : Le === 3 ? stats.agg.node : stats.agg.card);
  const selLe = !focus || focus.level === 'cluster' ? -1 : focus.level === 'super' ? 1 : focus.level === 'cab' ? 2 : focus.level === 'node' ? 3 : 4;
  const selIdx = selLe < 0 ? -1 : selLe === 1 ? 0 : selLe === 2 ? Math.floor(focus!.card / PER_CAB) : selLe === 3 ? Math.floor(focus!.card / CPB) : focus!.card;
  const focusCard = focus && selLe === 4 ? focus.card : null;
  const ringC = dark ? '#fff' : '#10131a';
  // structure = glyph + position; state = 红黄绿 (only when playing) — else hierarchy colour (同层级图)
  const fillOf = (Le: number, idx: number, base: string) => (playing ? loadColor(metricOf(Le, idx)) : base);

  // build per-tier shown lists + positions
  const pos: Record<number, Record<number, { x: number; y: number }>> = {};
  const rows = TIERS.map((t) => {
    const sc = tierInScope(t.Le, focus, dir, N, nCabs, nBlades);
    const full = sc === null;
    const baseList = full ? Array.from({ length: Math.min(total(t.Le), BUDGET) }, (_, i) => i) : sc;
    const shownIdx = baseList.slice(0, BUDGET);
    const inCount = full ? total(t.Le) : sc.length;
    const fold = inCount - shownIdx.length;
    const slots = shownIdx.length + (fold > 0 ? 1 : 0);
    const slotW = (X1 - X0) / Math.max(1, slots);
    pos[t.Le] = {};
    const shown = shownIdx.map((idx, i) => { const x = X0 + (X1 - X0) * (i + 0.5) / Math.max(1, slots); pos[t.Le][idx] = { x, y: t.y }; return { idx, x }; });
    const foldX = fold > 0 ? X0 + (X1 - X0) * (slots - 0.5) / Math.max(1, slots) : null;
    return { t, shown, fold, foldX, inCount, slotW };
  });

  const parentOf = (Le: number, idx: number): { Le: number; idx: number } | null =>
    Le === 2 ? { Le: 1, idx: 0 } : Le === 3 ? { Le: 2, idx: Math.floor(idx / BPC) } : Le === 4 ? { Le: 3, idx: Math.floor(idx / CPB) } : null;

  const els: React.ReactNode[] = [];
  // connector language mirrors 平面视图「选中链路·层级图」(SelHierPanel): a solid SEL line +
  // connector dots (色环 + 白芯) at the junctions + 运行时沿线流动的白色彗星 (SMIL marching-ants).
  const tierH = (Le: number) => (TIERS.find((tt) => tt.Le === Le)?.h ?? 16);
  const cdot = (x: number, y: number, c: string, k: string, r = 2.4) => (
    <g key={k}><circle cx={x} cy={y} r={r} fill={c} /><circle cx={x} cy={y} r={r * 0.42} fill="#fff" /></g>
  );
  const cflow = (x1: number, y1: number, x2: number, y2: number, k: string) => (playing ? (
    <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeDasharray="3 12" opacity={0.82}>
      <animate attributeName="stroke-dashoffset" from="15" to="0" dur="0.6s" repeatCount="indefinite" />
    </line>
  ) : null);
  // 1) containment connectors (edge-to-edge) + connector dots (focus only) — 上下层级关系
  if (focus) {
    const parentDots = new Map<string, [number, number]>();
    rows.forEach(({ t, shown }) => {
      shown.forEach(({ idx, x }) => {
        const par = parentOf(t.Le, idx); if (!par) return;
        const pp = pos[par.Le]?.[par.idx]; if (!pp) return;
        const cTop = t.y - t.h / 2, pBot = pp.y + tierH(par.Le) / 2;
        els.push(<line key={`c-${t.Le}-${idx}`} x1={x} y1={cTop} x2={pp.x} y2={pBot} stroke={ACCENT} strokeWidth={1.3} strokeOpacity={0.55} />);
        els.push(cflow(pp.x, pBot, x, cTop, `cf-${t.Le}-${idx}`));
        els.push(cdot(x, cTop, ACCENT, `cd-${t.Le}-${idx}`, 2.2));
        parentDots.set(`${par.Le}-${par.idx}`, [pp.x, pBot]);
      });
    });
    parentDots.forEach(([px, py], k) => els.push(cdot(px, py, ACCENT, `pd-${k}`)));
    // 2) UB plane mesh between node-tier siblings (横向同级关系)
    if (planeOn.ub) {
      const nr = rows.find((r) => r.t.Le === 3); const ny = TIERS[2].y;
      if (nr) for (let i = 0; i < nr.shown.length - 1; i++) { const a = nr.shown[i], b = nr.shown[i + 1], mx = (a.x + b.x) / 2; els.push(<path key={`ub-${i}`} d={`M${a.x} ${ny} Q ${mx} ${ny - 15} ${b.x} ${ny}`} fill="none" stroke={PLANES[0].color} strokeWidth={1} strokeOpacity={0.55} />); }
    }
  }
  // 3) tier glyphs — pill (super) / block (cab·node) / card-glyph(2×2 Die) (card)
  rows.forEach(({ t, shown, fold, foldX, slotW }) => {
    shown.forEach(({ idx, x }) => {
      const isSel = t.Le === selLe && idx === selIdx, fill = fillOf(t.Le, idx, t.col);
      const strag = t.Le === 4 && isStrag(idx, step);
      const cy = t.y, click = (e: React.MouseEvent) => { e.stopPropagation(); setFocus(isSel ? null : entityToFocus(t.Le, idx)); };
      if (t.Le === 4) {           // card glyph: rounded square + 2×2 Die dots
        const s = Math.max(9, Math.min(t.maxW, slotW * 0.82)), gx = x - s / 2, gy = cy - s / 2, ins = s * 0.17, gp = s * 0.08, dw = (s - ins * 2 - gp) / 2;
        els.push(
          <g key={`g-4-${idx}`} style={{ cursor: 'pointer' }} onClick={click}>
            {(isSel || strag) && <rect x={gx - 3} y={gy - 3} width={s + 6} height={s + 6} rx={s * 0.34} fill="none" stroke={isSel ? ringC : '#b07bff'} strokeWidth={1.8} />}
            <rect x={gx} y={gy} width={s} height={s} rx={s * 0.24} fill={fill} />
            {s >= 12 && [0, 1, 2, 3].map((q) => <rect key={q} x={gx + ins + (q % 2) * (dw + gp)} y={gy + ins + Math.floor(q / 2) * (dw + gp)} width={dw} height={dw} rx={dw * 0.3} fill={P.die} />)}
          </g>,
        );
      } else {                    // super / cab / node : rounded pill (+ id label when wide)
        const w = Math.max(11, Math.min(t.maxW, slotW * 0.82)), h = t.h, gx = x - w / 2, gy = cy - h / 2;
        const lbl = t.Le === 1 ? '超节点' : w >= 30 ? (t.Le === 2 ? `C${idx}` : `B${idx}`) : '';
        els.push(
          <g key={`g-${t.Le}-${idx}`} style={{ cursor: 'pointer' }} onClick={click}>
            {isSel && <rect x={gx - 3} y={gy - 3} width={w + 6} height={h + 6} rx={(h + 6) * 0.36} fill="none" stroke={ringC} strokeWidth={1.8} />}
            <rect x={gx} y={gy} width={w} height={h} rx={h * 0.34} fill={fill} />
            {lbl && <text x={x} y={cy + 0.5} fill={ink(t.col)} fontSize={Math.min(11, h * 0.56)} fontWeight={700} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: 'none' }}>{lbl}</text>}
          </g>,
        );
      }
    });
    if (fold > 0 && foldX != null) {
      const w = Math.max(28, String(fold).length * 7 + 22);
      els.push(
        <g key={`f-${t.Le}`}>
          <rect x={foldX - w / 2} y={t.y - 9} width={w} height={18} rx={9} fill={P.pill} stroke={P.pillBd} />
          <text x={foldX} y={t.y + 4} fill={P.ink2} fontSize={10} textAnchor="middle">{`+${fold}`}</text>
        </g>,
      );
    }
  });
  // 4) tier labels (gutter): Lx · name · shown/total · p50/红
  rows.forEach(({ t, inCount }) => {
    const a = aggOf(t.Le);
    els.push(
      <g key={`l-${t.Le}`}>
        {t.tag && <text x={12} y={t.y - 6} fill={t.col} fontSize={9} fontWeight={700}>{t.tag}</text>}
        <text x={12} y={t.y + (t.tag ? 6 : 4)} fill={P.ink} fontSize={12} fontWeight={600}>{t.label}</text>
        <text x={12} y={t.y + (t.tag ? 18 : 16)} fill={P.ink3} fontSize={9}>{`${focus ? inCount + '/' : ''}${total(t.Le).toLocaleString()} · p50 ${Math.round(a.p50 * 100)}% · ${Math.round(a.red * 100)}%红`}</text>
      </g>,
    );
  });
  // 5) divider + card-internal sub-grids — 层内关系. 始终展开「代表卡」的卡内结构 (机柜/节点选中=该
  //    范围首卡；无选中=卡0)，用满竖向空间；选中具体卡时即该卡。结构色，播放时叠加负载。
  const repCard = focusCard != null ? focusCard : focus ? scopeRange(focus, N)[0] : 0;
  const repReal = focusCard != null;   // true = 真的选到某张卡（否则是代表卡）
  els.push(<line key="div" x1={8} y1={312} x2={592} y2={312} stroke={P.line} strokeDasharray="2 4" />);
  els.push(<text key="divt" x={300} y={307} fill={P.ink3} fontSize={9} textAnchor="middle">{`—— 卡内结构 · ${repReal ? '卡' : '代表卡'} r${repCard}（${repReal ? '已选中' : '该范围首卡'}）——`}</text>);
  // containment connectors into the sub-card layers — same bus-wiring language as 选中链路·层级图:
  // 代表卡 → 2 计算 Die → AI Core 网格顶 → Tile 网格顶, each a solid SEL line + connector dots + 流动彗星.
  { const rp4 = pos[4]?.[repCard];
    const dieCx = [135, 175], dieTopY = 340, dieBotY = 370;        // compute Die centres (i=0,1) · 30px cells @ y=340
    const coreCx = 254.5, coreTopY = 426, coreBotY = 457;          // AI Core grid (16 cols · 17px pitch) span 120..389
    const tileCx = 230.5, tileTopY = 526;                          // Tile grid (16 cols · 14px pitch) span 120..341
    const cardBotY = 278;                                          // just below the card glyph (card centre y=268)
    if (rp4) {
      dieCx.forEach((dx, di) => {
        els.push(<line key={`cc-die-${di}`} x1={rp4.x} y1={cardBotY} x2={dx} y2={dieTopY} stroke={ACCENT} strokeWidth={1.3} strokeOpacity={0.55} />);
        els.push(cflow(rp4.x, cardBotY, dx, dieTopY, `ccf-die-${di}`));
        els.push(cdot(dx, dieTopY, ACCENT, `ccd-die-${di}`, 2.2));
      });
      els.push(cdot(rp4.x, cardBotY, ACCENT, 'ccd-card'));
    }
    dieCx.forEach((dx, di) => {
      els.push(<line key={`cd-core-${di}`} x1={dx} y1={dieBotY} x2={coreCx} y2={coreTopY} stroke={ACCENT} strokeWidth={1.2} strokeOpacity={0.5} />);
      els.push(cflow(dx, dieBotY, coreCx, coreTopY, `cdf-core-${di}`));
      els.push(cdot(dx, dieBotY, ACCENT, `cdd-die-${di}`, 2));
    });
    els.push(cdot(coreCx, coreTopY, ACCENT, 'cd-core-top'));
    els.push(<line key="cd-tile" x1={coreCx} y1={coreBotY} x2={tileCx} y2={tileTopY} stroke={ACCENT} strokeWidth={1.2} strokeOpacity={0.5} />);
    els.push(cflow(coreCx, coreBotY, tileCx, tileTopY, 'cdf-tile'));
    els.push(cdot(coreCx, coreBotY, ACCENT, 'cd-core-bot', 2));
    els.push(cdot(tileCx, tileTopY, ACCENT, 'cd-tile-top'));
  }
  SUBTIERS.forEach((st) => {
    els.push(<text key={`slt-${st.key}`} x={12} y={st.y - 6} fill={ENTITY_COLORS.cube} fontSize={9} fontWeight={700}>{st.tag}</text>);
    els.push(<text key={`sl-${st.key}`} x={12} y={st.y + 6} fill={P.ink} fontSize={12} fontWeight={600}>{st.label}</text>);
    els.push(<text key={`scnt-${st.key}`} x={12} y={st.y + 18} fill={P.ink3} fontSize={9}>{`×${st.n}${st.key === 'core' ? '/卡' : st.key === 'tile' ? '/核' : ''}`}</text>);
    for (let i = 0; i < st.n; i++) {
      const cx = 120 + (i % st.cols) * (st.cell + st.gap), cy = st.y - 6 + Math.floor(i / st.cols) * (st.cell + st.gap);
      const isSel = repReal && ((st.lvl === 'die' && focus?.die === i) || (st.lvl === 'core' && focus?.core === i));
      // always use load-based color keyed to repCard so L0-L2 visually changes when a different
      // node/cabinet is selected; IO Die (i≥2) keeps its structural color (no compute load).
      const fill = (st.key === 'die' && i >= 2) ? st.col(i) : loadColor(Math.max(0, Math.min(1, nodeLoad(repCard * st.seed + i, wlKind))));
      els.push(
        <rect key={`s-${st.key}-${i}`} x={cx} y={cy} width={st.cell} height={st.cell} rx={Math.min(3, st.cell * 0.18)} fill={fill} style={{ cursor: 'pointer' }}
          stroke={isSel ? ringC : 'none'} strokeWidth={isSel ? 1.8 : 0}
          onClick={(e) => { e.stopPropagation(); setFocus({ level: st.lvl, card: repCard, ...(st.lvl === 'die' ? { die: i } : st.lvl === 'core' ? { core: i } : {}) }); }} />,
      );
    }
    if (st.key === 'die') els.push(<text key="die-cap" x={120 + 4 * (st.cell + st.gap) + 6} y={st.y + st.cell / 2} fill={P.ink3} fontSize={9} dominantBaseline="central">2 计算(UMA) · 2 IO</text>);
  });

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style={{ display: 'block' }}>
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="transparent" onClick={() => setFocus(null)} />
      {els}
    </svg>
  );
}

export function ConsoleView({ gen, dark }: { gen: Gen; dark: boolean }) {
  const spec = GENERATIONS[gen];
  const N = spec.totalNpus;
  const nBlades = Math.ceil(N / CPB), nCabs = Math.ceil(nBlades / BPC), PP = Math.min(16, nBlades);

  const [workload, setWorkload] = useState<Workload>('pretrain');
  const [metric, setMetric] = useState<Metric>('util');
  const [dir, setDir] = useState<Dir>('all');
  const [lens, setLens] = useState<Lens>('heat');
  const [partDim, setPartDim] = useState<Exclude<PartitionDim, 'none'>>('tp');
  const [planeOn, setPlaneOn] = useState({ ub: true, rdma: true, vpc: false });
  const [focus, setFocus] = useState<Focus>(null);
  const [scopeB, setScopeB] = useState<{ cx: number; cy: number; cz: number; r: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);
  const wlKind = WL[workload].kind;

  useEffect(() => { setFocus(null); }, [gen]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1) % (STEP_MAX + 1)), 650);
    return () => clearInterval(id);
  }, [playing]);

  const stats = useMemo<Stats>(() => {
    const cabSum = new Float64Array(nCabs), cabCnt = new Int32Array(nCabs);
    const ndSum = new Float64Array(nBlades), ndCnt = new Int32Array(nBlades);
    const cardVals: number[] = [], stride = Math.max(1, Math.floor(N / 2048));
    let utilSum = 0, hot = 0, strag = 0; const faultNodes = new Set<number>();
    for (let k = 0; k < N; k++) {
      const u = cardLoad(k, wlKind, step); utilSum += u; if (isHot(u)) hot++;
      if (isStrag(k, step)) strag++; if (isFault(k, step)) faultNodes.add(Math.floor(k / CPB));
      const mv = cardMetric(k, metric, wlKind, step);
      const cb = Math.floor(k / PER_CAB), nd = Math.floor(k / CPB);
      cabSum[cb] += mv; cabCnt[cb]++; ndSum[nd] += mv; ndCnt[nd]++;
      if (k % stride === 0) cardVals.push(mv);
    }
    const cabVals = Array.from({ length: nCabs }, (_, i) => (cabCnt[i] ? cabSum[i] / cabCnt[i] : 0));
    const ndVals = Array.from({ length: nBlades }, (_, i) => (ndCnt[i] ? ndSum[i] / ndCnt[i] : 0));
    const agg = (arr: number[]) => {
      if (!arr.length) return { p50: 0, p95: 0, red: 0 };
      const s = [...arr].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      let red = 0; for (const v of arr) if (loadState(v) >= 2) red++;
      return { p50: q(0.5), p95: q(0.95), red: red / arr.length };
    };
    const clusterMean = cabVals.reduce((a, b) => a + b, 0) / Math.max(1, cabVals.length);
    return {
      kpi: { util: utilSum / N, hot, strag, faultDom: faultNodes.size },
      clusterMean, cabVals, ndVals, cardVals,
      agg: { cluster: agg([clusterMean]), cab: agg(cabVals), node: agg(ndVals), card: agg(cardVals) },
    };
  }, [N, nCabs, nBlades, metric, wlKind, step]);

  // focused-entity auxiliary metrics (exact over the scope range; ≤64 cards unless whole)
  const rail = useMemo(() => {
    const [lo, hi] = scopeRange(focus, N), n = hi - lo;
    if (n > PER_CAB) return null;
    const mean = (m: Metric) => { let s = 0; for (let k = lo; k < hi; k++) s += cardMetric(k, m, wlKind, step); return n ? s / n : 0; };
    return { util: mean('util'), strag: mean('strag'), fault: mean('fault'), count: n };
  }, [focus, N, wlKind, step]);

  const problem = useMemo(() => {
    if (step < EVT_LO || step > EVT_HI) return null;
    let strag = 0; for (let k = EVT_CAB * PER_CAB; k < (EVT_CAB + 1) * PER_CAB && k < N; k++) if (isStrag(k, step)) strag++;
    const redR = stats.kpi.hot / N;
    return { root: EVT_CAB, title: `机柜 C${EVT_CAB} 过热`, chain: `液冷异常 → ${strag} 卡掉队(straggler) → DP 梯度 AllReduce 阻塞`, impact: `影响 ${Math.min(N, PER_CAB)} 卡 · step 延迟 +${Math.round(redR * 420 + 22)}%` };
  }, [step, N, stats.kpi.hot]);

  const crumbs = useMemo(() => {
    const out: { lvl: Level; label: string; card: number }[] = [{ lvl: 'super', label: '超节点', card: 0 }];
    if (focus && focus.level !== 'super' && focus.level !== 'cluster') {
      const cab = Math.floor(focus.card / PER_CAB); out.push({ lvl: 'cab', label: `机柜 C${cab}`, card: cab * PER_CAB });
      if (['node', 'card', 'die', 'core', 'tile'].includes(focus.level)) { const b = Math.floor(focus.card / CPB); out.push({ lvl: 'node', label: `节点 B${b}`, card: b * CPB }); }
      if (['card', 'die', 'core', 'tile'].includes(focus.level)) out.push({ lvl: 'card', label: `卡 r${focus.card}`, card: focus.card });
      if (['die', 'core', 'tile'].includes(focus.level)) out.push({ lvl: focus.level, label: LEVEL_NAME[focus.level], card: focus.card });
    }
    return out;
  }, [focus]);

  // panorama config (lens → array presentation); memoised so playback ticks don't churn the 8K recolor
  const panoStatus = lens === 'heat' || lens === 'flow';
  const panoPeers = lens === 'flow';
  const panoPlanes = lens === 'phys';
  const panoPart: PartitionDim = lens === 'domain' ? partDim : 'none';
  const panoPhase = useMemo<RunPhase | null>(() => (playing && (lens === 'heat' || lens === 'flow')
    ? { id: 'wl', name: WL[workload].label, kind: wlKind, color: wlKind === 'comm' ? '#ff4b7b' : '#22d3ee', collective: lens === 'flow' ? 'ring' : undefined, note: '' }
    : null), [playing, lens, workload, wlKind]);
  const runMode: RunMode = workload === 'pretrain' ? 'train' : 'infer';
  const reach = Math.sqrt(N) * 1.3 + 12;
  const panoSel = useMemo(() => focusToSel(focus), [focus]);

  const groups = focus && rail ? (() => {
    const k = focus.card, b = Math.floor(k / CPB);
    return [
      { d: 'tp', label: `TP·${k % CPB}`, c: PARALLEL_COLORS.tp },
      { d: 'pp', label: `PP·${b % PP}`, c: PARALLEL_COLORS.pp },
      { d: 'dp', label: `DP·复本${Math.floor(b / PP)}`, c: PARALLEL_COLORS.dp },
      { d: 'ep', label: `EP·C${Math.floor(k / PER_CAB)}`, c: PARALLEL_COLORS.ep },
    ];
  })() : [];
  const phys = focus && rail ? LEVEL_PHYS[focus.level] : null;
  const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 11, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 11, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--tx)' }}>
      {/* ── toolbar: 工况 / 指标 / 方向 / 镜头 (+切分) / 平面 · breadcrumb · KPI ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 12px', borderBottom: '1px solid var(--bd)', flexWrap: 'wrap', background: 'var(--panel-solid)' }}>
        <span style={GLAB}>工况</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(Object.keys(WL) as Workload[]).map((w) => (
            <button key={w} onClick={() => setWorkload(w)} style={{ ...btnBase, ...(workload === w ? { border: '1px solid #2a6f5f', background: '#2a6f5f', color: '#fff', fontWeight: 600 } : SECONDARY) }}>{WL[w].label}</button>
          ))}
        </div>
        <span style={GLAB}>指标</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(Object.keys(M_LABEL) as Metric[]).map((m) => (<button key={m} onClick={() => setMetric(m)} style={{ ...btnBase, ...navBtn(metric === m) }}>{M_LABEL[m]}</button>))}
        </div>
        <span style={GLAB}>方向</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {([['all', '全链'], ['up', '上游'], ['down', '下游']] as [Dir, string][]).map(([d, l]) => (<button key={d} onClick={() => setDir(d)} style={{ ...btnBase, ...navBtn(dir === d) }}>{l}</button>))}
        </div>
        <span style={GLAB}>镜头</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(Object.keys(LENS_LABEL) as Lens[]).map((l) => (<button key={l} onClick={() => setLens(l)} style={{ ...btnBase, ...(lens === l ? { border: '1px solid #5a3a86', background: '#5a3a86', color: '#fff', fontWeight: 600 } : SECONDARY) }}>{LENS_LABEL[l]}</button>))}
        </div>
        {lens === 'domain' && (
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={GLAB}>切分</span>
            {(['tp', 'pp', 'dp', 'ep'] as Exclude<PartitionDim, 'none'>[]).map((d) => (
              <button key={d} onClick={() => setPartDim(d)} title={PARTITION_META[d].label} style={{ ...btnBase, display: 'inline-flex', alignItems: 'center', gap: 5, ...toggleBtn(partDim === d, PARALLEL_COLORS[d]) }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: partDim === d ? ink(PARALLEL_COLORS[d]) : PARALLEL_COLORS[d] }} />{d.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        <span style={GLAB}>平面</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {PLANES.map((p) => { const on = planeOn[p.id]; return (
            <button key={p.id} onClick={() => setPlaneOn((s) => ({ ...s, [p.id]: !s[p.id] }))} title={p.role} style={{ ...btnBase, display: 'inline-flex', alignItems: 'center', gap: 5, ...toggleBtn(on, p.color) }}>
              <span style={{ width: 9, height: 3, borderRadius: 1, background: on ? ink(p.color) : p.color }} />{p.short.split('·')[0]}
            </button>
          ); })}
        </div>
        {/* breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tx2)', flex: 1, minWidth: 60, overflow: 'hidden' }}>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <span style={{ color: 'var(--tx3)' }}>›</span>}
              <span onClick={() => setFocus(c.lvl === 'super' ? null : { level: c.lvl, card: c.card })} style={{ cursor: 'pointer', padding: '2px 5px', borderRadius: 5, color: i === crumbs.length - 1 ? 'var(--tx)' : ACCENT }}>{c.label}</span>
            </span>
          ))}
        </div>
        {/* KPI */}
        <div style={{ display: 'flex', gap: 14 }}>
          {([
            [`${Math.round(stats.kpi.util * 100)}%`, `集群${M_LABEL.util}`, 'var(--tx)'],
            [`${metric === 'fault' ? stats.kpi.faultDom : stats.kpi.hot}`, metric === 'fault' ? '故障域' : '热点卡', loadColor(0.9)],
            [`${stats.kpi.strag}`, '掉队卡', PARALLEL_COLORS.ep],
          ] as [string, string, string][]).map(([v, l, c], i) => (
            <div key={i} style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.1, color: c, ...TNUM }}>{v}</div>
              <div style={{ fontSize: 10, color: 'var(--tx3)' }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── body: left Smartscape 控制 · right panorama (scopeOnly) + 仪表 ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: '0 0 40%', maxWidth: '46%', minWidth: 340, borderRight: '1px solid var(--bd)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel-solid)' }}>
          <div style={{ padding: '5px 12px', fontSize: 11, color: 'var(--tx3)', borderBottom: '1px solid var(--bd)', flexShrink: 0 }}>
            平面视图 · 层级图（控制 · 图元/配色同层级图）— 点任一实体 → 只展开其链路(祖先+后代) 并联动右侧阵列全景；每层显示 选中/总数 · p50 · 红卡率
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0, padding: '4px 6px' }}>
            <Smartscape N={N} nCabs={nCabs} nBlades={nBlades} focus={focus} setFocus={setFocus} metric={metric} wlKind={wlKind} step={step} dir={dir} planeOn={planeOn} playing={playing} stats={stats} dark={dark} />
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <Canvas
            orthographic dpr={[1, 2]}
            camera={{ position: [reach, reach * 0.7, reach], zoom: 8, near: 0.1, far: 4000 }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1, powerPreference: 'high-performance' }}
            onCreated={({ gl }) => { gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault(), false); }}
          >
            <color attach="background" args={[dark ? '#101010' : '#f5f5f5']} />
            <fog attach="fog" args={[dark ? '#101010' : '#f5f5f5', 90, 420]} />
            <ambientLight intensity={dark ? 1.35 : 1.05} />
            <directionalLight position={[8, 14, 6]} intensity={dark ? 0.95 : 1.2} />
            <pointLight position={[0, 10, 0]} intensity={dark ? 0.7 : 1.0} color={dark ? '#7e93cf' : '#e8f0ff'} />
            <FrameCamera bounds={scopeB} reach={reach} controls={controlsRef} />
            <SceneTheme.Provider value={dark}>
              <FullPodScene
                scale="64P" podCount={1} full gen={spec} overlays={OVERLAYS}
                runMode={runMode} phase={panoPhase} partition={panoPart} peers={panoPeers}
                status={panoStatus} planes={panoPlanes} onHoverInfo={setHover} onPick={() => { /* dbl-click via focus */ }}
                focusSel={panoSel} onSel={(s) => setFocus(selToFocus(s))} dir={dir} scopeOnly onScope={setScopeB}
              />
            </SceneTheme.Provider>
            <OrbitControls
              ref={controlsRef} makeDefault enableDamping dampingFactor={0.08}
              minPolarAngle={0} maxPolarAngle={Math.PI / 2} minDistance={2} maxDistance={600}
              mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
            />
          </Canvas>

          <div style={{ position: 'absolute', top: 8, left: 12, fontSize: 11, color: 'var(--tx3)', pointerEvents: 'none' }}>
            3D 阵列全景 · 主视图 · {focus ? `仅显示「${focusName(focus)}」链路` : '全量'} · 镜头：{LENS_LABEL[lens]}{dir !== 'all' ? ` · ${dir === 'up' ? '上游' : '下游'}` : ''} · {N.toLocaleString()} 卡
          </div>

          {/* DAVIS 根因 */}
          <div style={{ position: 'absolute', top: 30, right: 12, width: 224, ...card, padding: '10px 12px', borderColor: problem ? 'var(--danger, #ef4d4d)' : 'var(--bd)', background: problem ? 'rgba(60,24,24,0.92)' : 'var(--panel)' }}>
            <div style={{ fontSize: 10, letterSpacing: 0.4, color: 'var(--tx3)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: problem ? '#ef4d4d' : '#2bd47d' }} />DAVIS · 根因分析
            </div>
            {problem ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>{problem.title}</div>
                <div style={{ fontSize: 11, color: 'var(--tx2)', lineHeight: 1.55, marginBottom: 7 }}>{problem.chain}</div>
                <div style={{ fontSize: 11, color: '#ef6d6d', marginBottom: 8 }}>{problem.impact}</div>
                <button onClick={() => { setFocus({ level: 'cab', card: problem.root * PER_CAB }); setDir('down'); }} style={{ width: '100%', border: `1px solid ${ACCENT}`, background: ACCENT, color: '#fff', fontSize: 12, padding: 6, borderRadius: 8, cursor: 'pointer' }}>定位根因 →</button>
              </>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--tx3)', lineHeight: 1.55 }}>当前无活动问题。拖动下方时间轴到 t=34–46 触发过热事件，看根因链自动聚合与定位。</div>
            )}
          </div>

          {/* 实体仪表 (auxiliary metrics for the focus) */}
          <div style={{ position: 'absolute', top: problem ? 186 : 166, right: 12, width: 224, ...card, padding: '10px 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 2px' }}>{focusName(focus)}</div>
            <div style={{ fontSize: 11, color: 'var(--tx2)', marginBottom: 8 }}>{focus && rail ? `${LEVEL_NAME[focus.level]}${rail.count > 1 ? ' · ' + rail.count + ' 卡' : ''}` : `${N.toLocaleString()} 卡 · ${nCabs} 机柜 · ${nBlades.toLocaleString()} 节点`}</div>
            {focus && rail ? (
              <>
                {(['util', 'strag', 'fault'] as Metric[]).map((mm) => {
                  const v = rail[mm];
                  return (
                    <div key={mm}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, margin: '4px 0 2px' }}>
                        <span style={{ color: 'var(--tx2)' }}>{M_LABEL[mm]}</span><span style={{ fontWeight: 600, ...TNUM }}>{Math.round(v * 100)}%</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 3, background: 'var(--btn)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.round(v * 100)}%`, background: loadColor(v), borderRadius: 3 }} /></div>
                    </div>
                  );
                })}
                {groups.length > 0 && (
                  <div style={{ marginTop: 9, borderTop: '1px solid var(--bd)', paddingTop: 7 }}>
                    <div style={{ fontSize: 10, color: 'var(--tx3)', marginBottom: 5 }}>并行组（rank 关系）</div>
                    {groups.map((g) => <span key={g.d} style={{ display: 'inline-block', fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: `${g.c}22`, color: g.c, margin: '0 4px 4px 0' }}>{g.label}</span>)}
                  </div>
                )}
                {phys && (
                  <div style={{ marginTop: 4, borderTop: '1px solid var(--bd)', paddingTop: 7 }}>
                    <div style={{ fontSize: 10, color: 'var(--tx3)', marginBottom: 5 }}>通信平面 · {phys.planeLabel}</div>
                    {PLANES.map((p) => <span key={p.id} style={{ display: 'inline-block', fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: `${p.color}1f`, color: p.color, margin: '0 4px 4px 0', opacity: phys.plane === p.id || phys.plane === 'multi' ? 1 : 0.4 }}>{p.short}</span>)}
                    <div style={{ fontSize: 9.5, color: 'var(--tx3)', lineHeight: 1.5, marginTop: 2 }}>{phys.devices}</div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--tx3)', lineHeight: 1.55 }}>左侧层级图驱动右侧阵列全景。点实体只展开其链路；方向(全链/上游/下游)过滤；镜头切阵列呈现；时间轴回放看问题定位。</div>
            )}
          </div>

          {/* legend */}
          <div style={{ position: 'absolute', left: 12, bottom: 12, ...card, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 260 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx2)' }}>状态（红黄绿+灰 = 状态唯一一套色）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {STATE_LABELS.map((lb, i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--tx2)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: stateColor(i) }} />{lb}</span>)}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, borderTop: '1px solid var(--bd)', paddingTop: 4 }}>
              {([['卡', ENTITY_COLORS.card], ['节点', ENTITY_COLORS.node], ['机柜', ENTITY_COLORS.cab], [TOK.supernode, ENTITY_COLORS.super]] as [string, string][]).map(([t, c]) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--tx2)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{t}</span>
              ))}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--tx3)' }}>蓝=选中焦点 · 紫环=掉队卡 · 链路外压暗 · 单击实体联动</div>
          </div>

          {hover && (
            <div style={{ position: 'absolute', right: 248, bottom: 12, maxWidth: 320, ...card, padding: '7px 11px', fontSize: 12, lineHeight: 1.5, color: 'var(--tx)', pointerEvents: 'none' }}>{hover}</div>
          )}
        </div>
      </div>

      {/* playbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 16px', borderTop: '1px solid var(--bd)', background: 'var(--panel-solid)' }}>
        <button onClick={() => setPlaying((v) => !v)} style={{ width: 30, height: 26, border: `1px solid ${ACCENT}`, background: ACCENT, color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>{playing ? '❚❚' : '▶'}</button>
        <span style={{ fontSize: 11, color: 'var(--tx2)', whiteSpace: 'nowrap', ...TNUM }}>{`t = ${step}`}</span>
        <input type="range" min={0} max={STEP_MAX} value={step} onChange={(e) => setStep(+e.target.value)} style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: problem ? '#ef6d6d' : 'var(--tx3)', whiteSpace: 'nowrap' }}>{problem ? `⚠ 过热事件窗口 t=${EVT_LO}–${EVT_HI}` : `工况 ${WL[workload].label} · 指标 ${M_LABEL[metric]}`}</span>
      </div>
    </div>
  );
}
