/**
 * PlaneView — a flat 2-D "tiled" diagram of the full super-node, complementary to
 * the 3-D full-pod view (which it does not touch). Drawn on a 2-D <canvas> so it
 * scales to the full ~8 K-card super-node. Nesting shows the physical containment
 * (super-node → cabinet → blade → card); colour shows parallel-group relationships
 * (TP/PP/DP/EP). Pan = drag, zoom = wheel, hover a card for its identity.
 *
 * Display text with brand terms is sourced from ../content (decoded at runtime).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { GENERATIONS, PARTITION_PALETTE, PARALLEL_COLORS, PARTITION_META, UB_LEVELS, COMM_PATTERNS, type Gen, type PartitionDim } from '../scene/data';
import { TOK } from '../content';

const CPB = 8, BPC = 8;   // cards / blade, blades / cabinet (= 64 NPU / cabinet)
const THREADS = 3;        // threads (AI-core groups) per NPU / rank
const COLOR_BTNS: { id: PartitionDim; label: string }[] = [
  { id: 'none', label: '无' }, { id: 'tp', label: 'TP' }, { id: 'pp', label: 'PP' }, { id: 'dp', label: 'DP' }, { id: 'ep', label: 'EP' },
];

export function PlaneView({ gen, dark }: { gen: Gen; dark: boolean }) {
  const spec = GENERATIONS[gen];
  // canvas-2D palette (cannot use CSS var() in fillStyle/strokeStyle)
  const P = dark
    ? { bg: '#101010', cardBd: 'rgba(255,255,255,0.16)', cardN: '#2a2f3a', ink: 'rgba(255,255,255,0.80)', ink2: 'rgba(255,255,255,0.55)' }
    : { bg: '#f3f4f7', cardBd: 'rgba(0,0,0,0.18)', cardN: '#cfd6e2', ink: 'rgba(0,0,0,0.62)', ink2: 'rgba(0,0,0,0.55)' };
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tf = useRef<{ s: number; tx: number; ty: number } | null>(null);   // world→screen transform
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const hoverRef = useRef<number | null>(null);
  const [colorBy, setColorBy] = useState<PartitionDim>('none');
  const [links, setLinks] = useState(true);   // draw card↔card (L1) + node↔node (L2) connections
  const [tip, setTip] = useState<{ k: number; x: number; y: number } | null>(null);

  // ── layout in world units ──
  const L = (() => {
    const N1 = spec.totalNpus;
    const nB = Math.ceil(N1 / CPB), nC = Math.ceil(nB / BPC);
    const cCols = Math.ceil(Math.sqrt(nC)), cRows = Math.ceil(nC / cCols);
    const cs = 1, gap = 0.3, bpad = 0.5, bgap = 0.5;
    const bw = 4 * (cs + gap) - gap + bpad * 2;        // blade: 4 cols × 2 rows
    const bh = 2 * (cs + gap) - gap + bpad * 2;
    const cpad = 0.9, cgap = 1.6;
    const cw = 2 * bw + bgap + cpad * 2;               // cabinet: 2 blade cols × 4 rows
    const ch = 4 * bh + 3 * bgap + cpad * 2;
    const tw = cCols * cw + (cCols - 1) * cgap;
    const th = cRows * ch + (cRows - 1) * cgap;
    return { N1, nB, nC, cCols, cRows, cs, gap, bpad, bgap, bw, bh, cpad, cgap, cw, ch, tw, th, PP: Math.min(16, nB) };
  })();

  const cabXY = (cab: number): [number, number] => [(cab % L.cCols) * (L.cw + L.cgap), Math.floor(cab / L.cCols) * (L.ch + L.cgap)];
  const bladeXY = (cab: number, bl: number): [number, number] => { const [cx, cy] = cabXY(cab); return [cx + L.cpad + (bl % 2) * (L.bw + L.bgap), cy + L.cpad + Math.floor(bl / 2) * (L.bh + L.bgap)]; };
  const cardXY = (k: number): [number, number] => {
    const b = Math.floor(k / CPB), l = k % CPB, cab = Math.floor(b / BPC), bl = b % BPC;
    const [bx, by] = bladeXY(cab, bl);
    return [bx + L.bpad + (l % 4) * (L.cs + L.gap), by + L.bpad + Math.floor(l / 4) * (L.cs + L.gap)];
  };
  const groupOf = (k: number): number => {
    const b = Math.floor(k / CPB);
    if (colorBy === 'tp') return k % CPB;
    if (colorBy === 'pp') return b % L.PP;
    if (colorBy === 'dp') return Math.floor(b / L.PP);
    if (colorBy === 'ep') return Math.floor(b / BPC);
    return -1;
  };
  const cfg = `TP${CPB}×PP${L.PP}×DP${Math.max(1, Math.round(L.nB / L.PP))}`;

  const fit = useCallback((W: number, H: number) => Math.min(W / L.tw, H / L.th) * 0.92, [L]);

  // hit-test a world point → card index (O(1) via the grid math)
  const pick = (wx: number, wy: number): number | null => {
    const cc = Math.floor(wx / (L.cw + L.cgap)), cr = Math.floor(wy / (L.ch + L.cgap));
    if (cc < 0 || cc >= L.cCols || cr < 0) return null;
    const cab = cr * L.cCols + cc; if (cab >= L.nC) return null;
    let lx = wx - cc * (L.cw + L.cgap) - L.cpad, ly = wy - cr * (L.ch + L.cgap) - L.cpad;
    const blc = Math.floor(lx / (L.bw + L.bgap)), blr = Math.floor(ly / (L.bh + L.bgap));
    if (blc < 0 || blc >= 2 || blr < 0 || blr >= 4) return null;
    const bl = blr * 2 + blc, blade = cab * BPC + bl; if (blade >= L.nB) return null;
    lx -= blc * (L.bw + L.bgap) + L.bpad; ly -= blr * (L.bh + L.bgap) + L.bpad;
    const lc = Math.floor(lx / (L.cs + L.gap)), lr = Math.floor(ly / (L.cs + L.gap));
    if (lc < 0 || lc >= 4 || lr < 0 || lr >= 2) return null;
    if (lx - lc * (L.cs + L.gap) > L.cs || ly - lr * (L.cs + L.gap) > L.cs) return null;   // in the gap
    const k = blade * CPB + (lr * 4 + lc);
    return k < L.N1 ? k : null;
  };

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current; if (!cv || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    if (!tf.current) { const f = fit(W, H); tf.current = { s: f, tx: (W - L.tw * f) / 2, ty: (H - L.th * f) / 2 }; }
    const { s, tx, ty } = tf.current;
    const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(tx, ty); ctx.scale(s, s);
    const vx0 = -tx / s, vy0 = -ty / s, vx1 = (W - tx) / s, vy1 = (H - ty) / s;   // visible world rect (cull per-card detail)

    // cabinets (L2) + blades (L1) containment frames
    ctx.lineWidth = 1.2 / s; ctx.strokeStyle = UB_LEVELS[2].color; ctx.fillStyle = 'rgba(167,139,250,0.07)';
    for (let cab = 0; cab < L.nC; cab++) { const [x, y] = cabXY(cab); ctx.fillRect(x, y, L.cw, L.ch); ctx.strokeRect(x, y, L.cw, L.ch); }
    ctx.lineWidth = 0.8 / s; ctx.strokeStyle = UB_LEVELS[1].color;
    for (let b = 0; b < L.nB; b++) { const [x, y] = bladeXY(Math.floor(b / BPC), b % BPC); ctx.strokeRect(x, y, L.bw, L.bh); }

    // cards
    const showBorder = s > 4, showId = s > 14, showThr = s > 26;   // card = NPU/rank; threads shown on deep zoom
    const thrC = COMM_PATTERNS[2].color;
    ctx.lineWidth = 0.6 / s; ctx.strokeStyle = P.cardBd;
    for (let k = 0; k < L.N1; k++) {
      const [x, y] = cardXY(k); const g = groupOf(k);
      ctx.fillStyle = g < 0 ? P.cardN : PARTITION_PALETTE[g % PARTITION_PALETTE.length];
      ctx.fillRect(x, y, L.cs, L.cs);
      if (showBorder) ctx.strokeRect(x, y, L.cs, L.cs);
      // process = the NPU's rank (label); threads = 3 AI-core slices (sub-cells) — only for visible cards
      if (showId && x + L.cs >= vx0 && x <= vx1 && y + L.cs >= vy0 && y <= vy1) {
        ctx.fillStyle = P.ink; ctx.textAlign = 'center'; ctx.font = '0.28px sans-serif';
        ctx.textBaseline = showThr ? 'top' : 'middle';
        ctx.fillText(`r${k}`, x + L.cs / 2, y + (showThr ? 0.07 : L.cs / 2));
        if (showThr) {
          const gp = L.cs * 0.07, tw = (L.cs - gp * (THREADS + 1)) / THREADS, th = L.cs * 0.34, tyy = y + L.cs - th - gp;
          ctx.fillStyle = thrC;
          for (let t = 0; t < THREADS; t++) ctx.fillRect(x + gp + t * (tw + gp), tyy, tw, th);
        }
      }
    }
    // same-level connections (LOD): L2 node mesh (blade↔blade full-mesh per cabinet) +
    // L1 board 2-D mesh (card↔card neighbours per blade)
    if (links && s * L.bw > 14) {
      ctx.strokeStyle = UB_LEVELS[2].color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.1 / s; ctx.beginPath();
      for (let cab = 0; cab < L.nC; cab++) {
        const c: [number, number][] = [];
        for (let bl = 0; bl < BPC; bl++) { const blade = cab * BPC + bl; if (blade >= L.nB) break; const [bx, by] = bladeXY(cab, bl); c.push([bx + L.bw / 2, by + L.bh / 2]); }
        for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { ctx.moveTo(c[i][0], c[i][1]); ctx.lineTo(c[j][0], c[j][1]); }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (links && s * L.cs > 4) {
      ctx.strokeStyle = UB_LEVELS[1].color; ctx.globalAlpha = 0.55; ctx.lineWidth = 0.7 / s; ctx.beginPath();
      for (let b = 0; b < L.nB; b++) {
        const cen: [number, number][] = [];
        for (let l = 0; l < CPB; l++) { const k = b * CPB + l; if (k >= L.N1) break; const [x, y] = cardXY(k); cen.push([x + L.cs / 2, y + L.cs / 2]); }
        for (let l = 0; l < cen.length; l++) {
          const col = l % 4, row = Math.floor(l / 4);
          if (col < 3 && l + 1 < cen.length) { ctx.moveTo(cen[l][0], cen[l][1]); ctx.lineTo(cen[l + 1][0], cen[l + 1][1]); }   // right neighbour
          if (row === 0 && l + 4 < cen.length) { ctx.moveTo(cen[l][0], cen[l][1]); ctx.lineTo(cen[l + 4][0], cen[l + 4][1]); }  // down neighbour
        }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // hovered card: "active" glow on its links — board neighbours (L1) + its blade↔
    // cabinet blades (L2). Rounded caps + shadow blur = a flow-engine "active" style.
    const hk = hoverRef.current;
    if (hk != null) {
      const b = Math.floor(hk / CPB), cab = Math.floor(b / BPC);
      const [hx, hy] = cardXY(hk); const hc: [number, number] = [hx + L.cs / 2, hy + L.cs / 2];
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // L2: hovered blade centre → other blade centres in the cabinet
      const [bx, by] = bladeXY(cab, b % BPC); const bc: [number, number] = [bx + L.bw / 2, by + L.bh / 2];
      ctx.strokeStyle = UB_LEVELS[2].color; ctx.shadowColor = UB_LEVELS[2].color; ctx.shadowBlur = 10; ctx.lineWidth = 1.6 / s; ctx.globalAlpha = 0.9; ctx.beginPath();
      for (let bl = 0; bl < BPC; bl++) { const blade = cab * BPC + bl; if (blade >= L.nB || blade === b) continue; const [ox, oy] = bladeXY(cab, bl); ctx.moveTo(bc[0], bc[1]); ctx.lineTo(ox + L.bw / 2, oy + L.bh / 2); }
      ctx.stroke();
      // L1: hovered card → its 7 board siblings
      ctx.strokeStyle = UB_LEVELS[1].color; ctx.shadowColor = UB_LEVELS[1].color; ctx.shadowBlur = 12; ctx.lineWidth = 2 / s; ctx.globalAlpha = 1; ctx.beginPath();
      for (let l = 0; l < CPB; l++) { const k2 = b * CPB + l; if (k2 >= L.N1 || k2 === hk) continue; const [sx, sy] = cardXY(k2); ctx.moveTo(hc[0], hc[1]); ctx.lineTo(sx + L.cs / 2, sy + L.cs / 2); }
      ctx.stroke();
      ctx.restore();
      // hovered card outline (on top, no blur)
      ctx.lineWidth = 2.5 / s; ctx.strokeStyle = '#ffb020'; ctx.strokeRect(hx - 0.06, hy - 0.06, L.cs + 0.12, L.cs + 0.12);
    }
    ctx.restore();
  }, [L, colorBy, links, fit, cabXY, bladeXY, cardXY, groupOf, dark]);

  // redraw on colour / size changes
  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onR = () => { tf.current = null; draw(); };   // re-fit on resize
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [draw]);

  // ── interaction ──
  const toWorld = (clientX: number, clientY: number): [number, number] => {
    const cv = canvasRef.current!; const r = cv.getBoundingClientRect(); const t = tf.current!;
    return [(clientX - r.left - t.tx) / t.s, (clientY - r.top - t.ty) / t.s];
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!tf.current) return; const t = tf.current; const r = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = (mx - t.tx) / t.s, wy = (my - t.ty) / t.s;
    const f = Math.exp(-e.deltaY * 0.0015); const ns = Math.max(fit(r.width, r.height) * 0.5, Math.min(t.s * f, fit(r.width, r.height) * 60));
    tf.current = { s: ns, tx: mx - wx * ns, ty: my - wy * ns }; draw();
  };
  const onDown = (e: React.PointerEvent) => { if (!tf.current) return; drag.current = { x: e.clientX, y: e.clientY, tx: tf.current.tx, ty: tf.current.ty }; (e.target as Element).setPointerCapture(e.pointerId); };
  const onUp = (e: React.PointerEvent) => { drag.current = null; try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ } };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current && tf.current) { tf.current = { ...tf.current, tx: drag.current.tx + (e.clientX - drag.current.x), ty: drag.current.ty + (e.clientY - drag.current.y) }; draw(); return; }
    const [wx, wy] = toWorld(e.clientX, e.clientY); const k = pick(wx, wy);
    if (k !== hoverRef.current) { hoverRef.current = k; draw(); }
    const r = canvasRef.current!.getBoundingClientRect();
    setTip(k == null ? null : { k, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onLeave = () => { if (hoverRef.current != null) { hoverRef.current = null; draw(); } setTip(null); };

  const tipInfo = tip && (() => {
    const k = tip.k, b = Math.floor(k / CPB), cab = Math.floor(b / BPC);
    const parts = [`NPU ${k} = 进程 rank ${k}`, `线程 ${THREADS} 个（AI Core 组）· tp${k % CPB}`, `刀片 B${b} · 机柜 C${cab}`];
    if (colorBy !== 'none') parts.push(`${PARTITION_META[colorBy as Exclude<PartitionDim, 'none'>].label}：组 ${groupOf(k)}`);
    return parts;
  })();

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, zIndex: 11, background: 'var(--bg2)', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: drag.current ? 'grabbing' : 'crosshair', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerUp={onUp} onPointerMove={onMove} onPointerLeave={onLeave}
      />
      {/* controls */}
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
        <span style={{ fontSize: 11.5, color: 'var(--tx2)' }}>平面 · 上色</span>
        {COLOR_BTNS.map((c) => {
          const on = colorBy === c.id; const sig = PARALLEL_COLORS[c.id];
          return <button key={c.id} onClick={() => setColorBy(c.id)} title={`按 ${c.label} 上色`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${on ? sig : 'var(--bd)'}`, background: on ? `${sig}1f` : 'transparent', color: on ? sig : 'var(--tx2)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: sig, display: 'inline-block', opacity: on ? 1 : 0.6 }} />{c.label}
          </button>;
        })}
        <button onClick={() => setLinks((v) => !v)} title="卡↔卡（L1 板载）+ 节点↔节点（L2 机柜内）连线，放大后显示"
          style={{ padding: '4px 9px', fontSize: 11.5, borderRadius: 4, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 4, border: `1px solid ${links ? UB_LEVELS[1].color : 'var(--bd)'}`, background: links ? `${UB_LEVELS[1].color}22` : 'transparent', color: links ? 'var(--tx)' : 'var(--tx3)' }}>
          <span style={{ width: 9, height: 3, background: UB_LEVELS[1].color, display: 'inline-block', borderRadius: 1, opacity: links ? 1 : 0.4 }} />连线
        </button>
        <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 2 }}>{`${L.N1.toLocaleString()} 卡 · ${L.nC} 机柜 · 拖动平移 / 滚轮缩放`}</span>
      </div>
      {/* legend */}
      <div style={{ position: 'absolute', bottom: 12, left: 12, padding: '7px 11px', fontSize: 11, background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', lineHeight: 1.6, color: 'var(--tx2)' }}>
        <div style={{ fontWeight: 600, color: 'var(--tx)', marginBottom: 2 }}>{`全量${TOK.supernode} · 平面拓扑`}</div>
        <div><span style={{ display: 'inline-block', width: 11, height: 11, background: 'rgba(167,139,250,0.18)', border: `1px solid ${UB_LEVELS[2].color}`, borderRadius: 2, verticalAlign: '-2px', marginRight: 5 }} />L2 机柜框（含 8 刀片）</div>
        <div><span style={{ display: 'inline-block', width: 11, height: 11, border: `1px solid ${UB_LEVELS[1].color}`, borderRadius: 2, verticalAlign: '-2px', marginRight: 5 }} />L1 刀片框（含 8 卡）</div>
        <div>卡 = NPU / 进程 rank · <span style={{ display: 'inline-block', width: 9, height: 7, background: COMM_PATTERNS[2].color, borderRadius: 1, verticalAlign: '-1px', margin: '0 4px' }} />卡内 3 格 = 线程（放大显示）</div>
        <div>{colorBy === 'none' ? '格子 = NPU 卡（嵌套=包含关系）' : `卡按 ${colorBy.toUpperCase()} 组上色（${cfg}）`}</div>
        {links && <div><span style={{ display: 'inline-block', width: 11, height: 0, borderTop: `2px solid ${UB_LEVELS[1].color}`, verticalAlign: 'middle', marginRight: 5 }} />卡↔卡(L1) · <span style={{ display: 'inline-block', width: 11, height: 0, borderTop: `2px solid ${UB_LEVELS[2].color}`, verticalAlign: 'middle', margin: '0 5px' }} />节点↔节点(L2)，放大显示</div>}
      </div>
      {/* hover tooltip */}
      {tip && tipInfo && (
        <div style={{ position: 'absolute', left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 9999) - 200), top: tip.y + 14, padding: '6px 9px', fontSize: 11.5, background: 'var(--panel)', border: '1px solid var(--bd2)', borderRadius: 10, pointerEvents: 'none', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'var(--tx)' }}>
          {tipInfo.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
