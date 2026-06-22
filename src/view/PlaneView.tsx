/**
 * PlaneView — a flat 2-D "tiled" diagram of the full super-node, complementary to
 * the 3-D full-pod view (which it does not touch). Drawn on a 2-D <canvas> so it
 * scales to the full ~8 K-card super-node. Nesting shows the physical containment
 * (super-node → cabinet → blade → card); colour shows parallel-group relationships
 * (TP/PP/DP/EP). Pan = drag, zoom = wheel, hover a card for its identity.
 *
 * Display text with brand terms is sourced from ../content (decoded at runtime).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GENERATIONS, PARTITION_PALETTE, PARALLEL_COLORS, PARTITION_META, UB_LEVELS, COMM_PATTERNS, LAYER_INFO, CORES_PER_CARD, ENTITY_COLORS, type Gen, type PartitionDim } from '../scene/data';
import { TOK } from '../content';

const CPB = 8, BPC = 8;   // cards / blade, blades / cabinet (= 64 NPU / cabinet)
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
  const [play, setPlay] = useState(false);          // scenario playback (animated hop-by-hop flow)
  const [scenario, setScenario] = useState<'ring' | 'a2a'>('ring');
  const [layout, setLayout] = useState<'top' | 'layers'>('top');   // top-down map vs. layered hierarchy
  const [selL, setSelL] = useState<{ lvl: number; idx: number } | null>(null);   // layered-view selection
  const downXY = useRef<{ x: number; y: number } | null>(null);   // pointer-down (click vs drag)
  const phaseRef = useRef(0);                       // flow animation phase
  const rafRef = useRef<number | null>(null);

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

  // ── layered-hierarchy layout: each level is MATRIX-PACKED into a square-ish grid
  // (like the top view), the grids stacked top→bottom by level. Formula-based (no
  // per-unit arrays) so the full pod — incl. 16K Die / ~300K AI Core — costs nothing.
  // Levels: 超节点 → 机柜 → 节点 → 卡/NPU(1 device · 内含 4 Die) → AI Core.
  // HARDWARE containment only; rank is software, bound 1:1 to the card-device. ──
  const LAY = useMemo(() => {
    const N = spec.totalNpus, nCab = Math.max(1, Math.round(N / 64));
    const margin = 11, Wc = 100, gap = 2.4;   // wider canvas
    // HARDWARE containment chain only (rank is software, shown separately). 950 card =
    // 1 device (4 Die) → ≈32 AI Core. `ar` sets panel aspect (smaller → bigger cells).
    const defs = [
      { kind: 'super', count: 1,                 color: ENTITY_COLORS.super, label: 'L3 超节点',        ar: 5.4 },
      { kind: 'cab',   count: nCab,               color: ENTITY_COLORS.cab,   label: 'L2 机柜',          ar: 6.0 },
      { kind: 'node',  count: nCab * 8,           color: ENTITY_COLORS.node,  label: 'L1 节点/刀片',     ar: 5.0 },
      { kind: 'card',  count: N,                  color: ENTITY_COLORS.card,  label: '卡/NPU (1 device)', ar: 2.6 },
      { kind: 'core',  count: N * CORES_PER_CARD, color: ENTITY_COLORS.cube,  label: 'AI Core (×32/卡)', ar: 0.7 },
    ];
    let y = margin;
    const levels = defs.map((d, li) => {
      if (d.kind === 'super') { const h = 5, y0 = y; y += h + gap * 1.6; return { ...d, cols: 1, cell: Wc, rows: 1, y0, h, grp: 1, banner: true }; }
      const cols = Math.max(1, Math.round(Math.sqrt(d.count * d.ar)));
      const cell = Wc / cols, rows = Math.ceil(d.count / cols), h = rows * cell, y0 = y;
      y += h + gap;
      return { ...d, cols, cell, rows, y0, h, grp: d.count / defs[li - 1].count, banner: false };   // grp = children per parent
    });
    return { levels, margin, Wc, w: margin * 2 + Wc, h: y - gap + margin };
  }, [spec]);

  // formula cell centre (level li, unit index i) — no stored arrays
  const cellXY = (li: number, i: number): [number, number] => {
    const Lv = LAY.levels[li];
    if (Lv.banner) return [LAY.margin + LAY.Wc / 2, Lv.y0 + Lv.h / 2];
    const c = i % Lv.cols, r = Math.floor(i / Lv.cols);
    return [LAY.margin + (c + 0.5) * Lv.cell, Lv.y0 + (r + 0.5) * Lv.cell];
  };

  const ext = layout === 'layers' ? { tw: LAY.w, th: LAY.h } : { tw: L.tw, th: L.th };
  // layered matrix is tall → fit to WIDTH (bigger, readable cells; scroll vertically)
  const fit = useCallback((W: number, H: number) => layout === 'layers' ? (W / ext.tw) * 0.96 : Math.min(W / ext.tw, H / ext.th) * 0.92, [ext.tw, ext.th, layout]);

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

  // layered view: hit-test world point → { level, grid cell index }
  const pickLayer = (wx: number, wy: number): { lvl: number; idx: number } | null => {
    for (let li = 0; li < LAY.levels.length; li++) {
      const Lv = LAY.levels[li]; if (wy < Lv.y0 || wy > Lv.y0 + Lv.h) continue;
      const c = Math.floor((wx - LAY.margin) / Lv.cell), r = Math.floor((wy - Lv.y0) / Lv.cell);
      if (c < 0 || c >= Lv.cols) return null;
      const idx = r * Lv.cols + c;
      if (idx >= 0 && idx < Lv.count) return { lvl: li, idx };
    }
    return null;
  };
  // Selected up/down-stream chain as a CONTIGUOUS [lo,hi) index range per level
  // (hierarchy is index-ordered, so ancestors/descendants are contiguous) → O(levels).
  const layRange = (): { lo: number[]; hi: number[] } | null => {
    if (!selL) return null;
    const n = LAY.levels.length, lo = Array(n).fill(0), hi = Array(n).fill(1);
    lo[selL.lvl] = selL.idx; hi[selL.lvl] = selL.idx + 1;
    for (let l = selL.lvl; l > 0; l--) { lo[l - 1] = Math.floor(lo[l] / LAY.levels[l].grp); hi[l - 1] = lo[l - 1] + 1; }
    for (let l = selL.lvl; l < n - 1; l++) { lo[l + 1] = lo[l] * LAY.levels[l + 1].grp; hi[l + 1] = hi[l] * LAY.levels[l + 1].grp; }
    return { lo, hi };
  };

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current; if (!cv || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    if (!tf.current) { const f = fit(W, H); tf.current = { s: f, tx: (W - ext.tw * f) / 2, ty: layout === 'layers' ? H * 0.04 : (H - ext.th * f) / 2 }; }
    const { s, tx, ty } = tf.current;
    const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;   // context state persists across frames; force a fully-opaque clear (no ghosting)
    ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(tx, ty); ctx.scale(s, s);

    // ── layered-hierarchy view: each level matrix-packed into a grid (like the top
    //    view), grids stacked by level. Full pod via LOD: cells when zoomed in, an
    //    aggregate fill when too small. Click → highlight the up/down-stream chain. ──
    if (layout === 'layers') {
      const { levels, margin, Wc } = LAY;
      const rr = (x: number, y: number, w: number, h: number, r: number) => {
        const rad = Math.min(r, w / 2, h / 2);
        ctx.beginPath(); ctx.moveTo(x + rad, y);
        ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
      };
      const hi = layRange();
      const vx0 = -tx / s, vx1 = (W - tx) / s, vy0 = -ty / s, vy1 = (H - ty) / s;

      // per-level simplified glyph (distinct shape, with internal detail when the cell
      // is big enough): cabinet slats · blade+dots · 950 card = 4 Die (2 compute UMA +
      // 2 IO) · AI Core = Cube + 2 Vector.
      const glyph = (kind: string, x: number, y: number, ws: number, base: string, A: number) => {
        const px = ws * s;
        ctx.fillStyle = base; ctx.strokeStyle = base; ctx.lineWidth = Math.max(0.012, ws * 0.05);
        if (kind === 'super') { ctx.globalAlpha = 0.2 * A; rr(x, y, ws, ws, ws * 0.16); ctx.fill(); ctx.globalAlpha = A; ctx.stroke(); }
        else if (kind === 'cab') {   // upright cabinet + horizontal slats
          const cw = ws * 0.6, cx = x + (ws - cw) / 2;
          ctx.globalAlpha = 0.22 * A; rr(cx, y, cw, ws, ws * 0.08); ctx.fill(); ctx.globalAlpha = A; ctx.stroke();
          if (px > 5) { ctx.globalAlpha = 0.5 * A; ctx.lineWidth = ws * 0.035; for (let k = 1; k < 4; k++) { const yy = y + ws * k / 4; ctx.beginPath(); ctx.moveTo(cx + cw * 0.16, yy); ctx.lineTo(cx + cw * 0.84, yy); ctx.stroke(); } }
        } else if (kind === 'node') {   // horizontal blade + NPU dots
          const bh = ws * 0.46, by = y + (ws - bh) / 2;
          ctx.globalAlpha = 0.22 * A; rr(x, by, ws, bh, bh * 0.3); ctx.fill(); ctx.globalAlpha = A; ctx.stroke();
          if (px > 7) { ctx.globalAlpha = 0.85 * A; for (let d = 0; d < 8; d++) { const dx = x + ws * (0.1 + 0.8 * d / 7); ctx.beginPath(); ctx.arc(dx, y + ws / 2, ws * 0.04, 0, 7); ctx.fill(); } }
        } else if (kind === 'card') {   // 950 package = 4 Die: 2 compute (UMA → 1 device) + 2 IO
          ctx.globalAlpha = 0.14 * A; rr(x, y, ws, ws, ws * 0.12); ctx.fill(); ctx.globalAlpha = A; ctx.stroke();
          if (px > 7) {
            const ins = ws * 0.13, g = ws * 0.08, dw = (ws - ins * 2 - g) / 2, dh = (ws - ins * 2 - g) / 2;
            const x0 = x + ins, x1 = x + ins + dw + g, y0 = y + ins, y1 = y + ins + dh + g;
            ctx.fillStyle = ENTITY_COLORS.computeDie; ctx.globalAlpha = 0.5 * A;   // top row = 2 compute Die (teal, UMA)
            rr(x0, y0, dw, dh, ws * 0.04); ctx.fill(); rr(x1, y0, dw, dh, ws * 0.04); ctx.fill();
            ctx.strokeStyle = ENTITY_COLORS.computeDie; ctx.globalAlpha = 0.95 * A; ctx.lineWidth = ws * 0.05;   // UMA bridge → single device
            ctx.beginPath(); ctx.moveTo(x0 + dw, y0 + dh / 2); ctx.lineTo(x1, y0 + dh / 2); ctx.stroke();
            ctx.fillStyle = ENTITY_COLORS.ioDie; ctx.globalAlpha = 0.4 * A;   // bottom row = 2 IO Die (grey)
            rr(x0, y1, dw, dh, ws * 0.04); ctx.fill(); rr(x1, y1, dw, dh, ws * 0.04); ctx.fill();
          } else {   // too small → a single compute-die hint band
            ctx.fillStyle = ENTITY_COLORS.computeDie; ctx.globalAlpha = 0.42 * A;
            rr(x + ws * 0.16, y + ws * 0.22, ws * 0.68, ws * 0.3, ws * 0.05); ctx.fill();
          }
        } else {   // AI Core = 1 Cube (AIC) + 2 Vector (AIV), separate dual-issue cores
          if (px > 6) {
            ctx.globalAlpha = 0.9 * A; rr(x + ws * 0.08, y + ws * 0.2, ws * 0.42, ws * 0.6, ws * 0.08); ctx.fill();   // Cube (base = cyan)
            ctx.fillStyle = ENTITY_COLORS.vector; ctx.globalAlpha = 0.78 * A; rr(x + ws * 0.58, y + ws * 0.24, ws * 0.14, ws * 0.52, ws * 0.04); ctx.fill(); rr(x + ws * 0.76, y + ws * 0.24, ws * 0.14, ws * 0.52, ws * 0.04); ctx.fill();   // 2 Vector (light cyan)
          } else { ctx.globalAlpha = 0.82 * A; rr(x, y, ws, ws, ws * 0.18); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      };

      levels.forEach((Lv, li) => {
        // super = a clean full-width banner (not a half-width cell)
        if (Lv.banner) {
          const on = !hi || (hi.lo[0] === 0);
          ctx.fillStyle = Lv.color; ctx.globalAlpha = hi && !on ? 0.1 : 0.18; rr(margin, Lv.y0, Wc, Lv.h, 1); ctx.fill();
          ctx.globalAlpha = hi && !on ? 0.3 : 1; ctx.strokeStyle = hi && on ? '#ffb020' : Lv.color; ctx.lineWidth = 0.18; rr(margin, Lv.y0, Wc, Lv.h, 1); ctx.stroke();
          ctx.fillStyle = hi && on ? '#ffb020' : Lv.color; ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '2.2px sans-serif';
          ctx.fillText(`${TOK.supernode} · ${LAY.levels[1].count.toLocaleString()} 机柜 / ${LAY.levels[3].count.toLocaleString()} NPU`, margin + Wc / 2, Lv.y0 + Lv.h / 2);
          return;
        }
        const cellPx = Lv.cell * s, pad = Lv.cell * 0.14;
        // visible cell window (cull to viewport)
        const c0 = Math.max(0, Math.floor((vx0 - margin) / Lv.cell)), c1 = Math.min(Lv.cols, Math.ceil((vx1 - margin) / Lv.cell));
        const r0 = Math.max(0, Math.floor((vy0 - Lv.y0) / Lv.cell)), r1 = Math.min(Lv.rows, Math.ceil((vy1 - Lv.y0) / Lv.cell));
        if (cellPx >= 3 && Lv.y0 < vy1 && Lv.y0 + Lv.h > vy0) {
          // individual glyphs (culled)
          for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
            const i = r * Lv.cols + c; if (i >= Lv.count) break;
            const on = !hi || (i >= hi.lo[li] && i < hi.hi[li]);
            const x = margin + c * Lv.cell + pad, y = Lv.y0 + r * Lv.cell + pad, ws = Lv.cell - pad * 2;
            glyph(Lv.kind, x, y, ws, hi ? (on ? '#ffb020' : Lv.color) : Lv.color, hi ? (on ? 1 : 0.14) : 1);
          }
          ctx.globalAlpha = 1;
        } else if (Lv.y0 < vy1 && Lv.y0 + Lv.h > vy0) {
          // aggregate: one fill over the whole grid panel (represents all units)
          ctx.fillStyle = Lv.color; ctx.globalAlpha = hi ? 0.08 : 0.5; rr(margin, Lv.y0, Wc, Lv.h, 0.2); ctx.fill(); ctx.globalAlpha = 1;
          if (hi) {   // selected range = a contiguous bright block (rows lo..hi)
            const ra = Math.floor(hi.lo[li] / Lv.cols), rb = Math.floor((hi.hi[li] - 1) / Lv.cols);
            ctx.fillStyle = '#ffb020'; ctx.globalAlpha = 0.85;
            if (ra === rb) { const x = margin + (hi.lo[li] % Lv.cols) * Lv.cell; rr(x, Lv.y0 + ra * Lv.cell, (hi.hi[li] - hi.lo[li]) * Lv.cell, Lv.cell, 0.06); ctx.fill(); }
            else { rr(margin, Lv.y0 + ra * Lv.cell, Wc, (rb - ra + 1) * Lv.cell, 0.06); ctx.fill(); }
            ctx.globalAlpha = 1;
          }
        }
      });

      // ── containment links for the selected chain (parent cell → child block centre) ──
      if (hi) {
        ctx.strokeStyle = '#ffb020'; ctx.globalAlpha = 0.9; ctx.lineWidth = 0.12; ctx.lineCap = 'round';
        for (let li = 1; li < levels.length; li++) {
          const pa = cellXY(li - 1, hi.lo[li - 1]);                                  // parent cell
          const ca = cellXY(li, hi.lo[li]), cb = cellXY(li, Math.min(levels[li].count - 1, hi.hi[li] - 1));
          ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // ── per-level label + ×count + 1:1 / 非1:1 tag ──
      ctx.textAlign = 'right';
      levels.forEach((Lv, li) => {
        const yc = Lv.y0 + Math.min(Lv.h / 2, 3);
        ctx.fillStyle = Lv.color; ctx.textBaseline = 'alphabetic'; ctx.font = '0.7px sans-serif';
        ctx.fillText(Lv.label, margin - 0.6, yc);
        ctx.fillStyle = P.ink2; ctx.font = '0.46px sans-serif';
        ctx.fillText(`×${Lv.count.toLocaleString()}`, margin - 0.6, yc + 0.85);
        if (LAYER_INFO[li]?.tag) { ctx.fillStyle = LAYER_INFO[li].tag!.includes('1:1') ? '#04d793' : '#7c8db8'; ctx.font = '0.4px sans-serif'; ctx.fillText(LAYER_INFO[li].tag!.split('（')[0], margin - 0.6, yc + 1.55); }
      });
      ctx.restore();
      return;
    }

    const vx0 = -tx / s, vy0 = -ty / s, vx1 = (W - tx) / s, vy1 = (H - ty) / s;   // visible world rect (cull per-card detail)

    // cabinets (L2) + blades (L1) containment frames
    ctx.lineWidth = 1.2 / s; ctx.strokeStyle = UB_LEVELS[2].color; ctx.fillStyle = 'rgba(167,139,250,0.07)';
    for (let cab = 0; cab < L.nC; cab++) { const [x, y] = cabXY(cab); ctx.fillRect(x, y, L.cw, L.ch); ctx.strokeRect(x, y, L.cw, L.ch); }
    ctx.lineWidth = 0.8 / s; ctx.strokeStyle = UB_LEVELS[1].color;
    for (let b = 0; b < L.nB; b++) { const [x, y] = bladeXY(Math.floor(b / BPC), b % BPC); ctx.strokeRect(x, y, L.bw, L.bh); }

    // cards
    const showBorder = s > 4, showId = s > 14, showDie = s > 26;   // card = device (HW); r-label = bound rank (SW); 4-Die package on deep zoom
    ctx.lineWidth = 0.6 / s; ctx.strokeStyle = P.cardBd;
    for (let k = 0; k < L.N1; k++) {
      const [x, y] = cardXY(k); const g = groupOf(k);
      ctx.fillStyle = g < 0 ? P.cardN : PARTITION_PALETTE[g % PARTITION_PALETTE.length];
      ctx.fillRect(x, y, L.cs, L.cs);
      if (showBorder) ctx.strokeRect(x, y, L.cs, L.cs);
      // card = 1 device (HW); the r-label is the SOFTWARE rank bound 1:1 to it; on deep
      // zoom the card interior shows the 950 package = 4 Die — SAME glyph as the layered
      // view + 3D NpuChip (2 compute Die UMA-bridged → 1 device + 2 IO Die).
      if (showId && x + L.cs >= vx0 && x <= vx1 && y + L.cs >= vy0 && y <= vy1) {
        ctx.fillStyle = P.ink; ctx.textAlign = 'center'; ctx.font = '0.26px sans-serif';
        ctx.textBaseline = showDie ? 'top' : 'middle';
        ctx.fillText(`r${k}`, x + L.cs / 2, y + (showDie ? 0.05 : L.cs / 2));
        if (showDie) {
          const ins = L.cs * 0.14, gp = L.cs * 0.07;
          const dw = (L.cs - ins * 2 - gp) / 2, dh = (L.cs * 0.7 - gp) / 2;
          const x0 = x + ins, x1 = x + ins + dw + gp, y0 = y + L.cs * 0.28, y1 = y + L.cs * 0.28 + dh + gp;
          ctx.fillStyle = ENTITY_COLORS.computeDie;   // 2 compute Die (teal, UMA)
          ctx.fillRect(x0, y0, dw, dh); ctx.fillRect(x1, y0, dw, dh);
          ctx.strokeStyle = ENTITY_COLORS.computeDie; ctx.lineWidth = L.cs * 0.045;   // UMA bridge → 1 device
          ctx.beginPath(); ctx.moveTo(x0 + dw, y0 + dh / 2); ctx.lineTo(x1, y0 + dh / 2); ctx.stroke();
          ctx.lineWidth = 0.6 / s; ctx.strokeStyle = P.cardBd;
          ctx.fillStyle = ENTITY_COLORS.ioDie;   // 2 IO Die (grey)
          ctx.fillRect(x0, y1, dw, dh); ctx.fillRect(x1, y1, dw, dh);
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

    // ── scenario playback: animated hop-by-hop flow (marching ants) ──
    // Ring-AllReduce → staged L1 (intra-blade) then L2 (intra-cabinet); All-to-All
    // → L2 cross-blade full-mesh emphasised. Reads as "卡→刀片→机柜逐跳流动".
    if (play) {
      const ph = phaseRef.current, cyc = ph % 1;
      const col = scenario === 'ring' ? COMM_PATTERNS[0].color : COMM_PATTERNS[1].color;
      const l1A = scenario === 'ring' ? (cyc < 0.5 ? 1 : 0.3) : 0.45;
      const l2A = scenario === 'ring' ? (cyc >= 0.5 ? 1 : 0.3) : 1;
      ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8;
      ctx.setLineDash([0.16, 0.46]); ctx.lineDashOffset = -ph * 1.4;
      // L1 board flow
      if (links && s * L.cs > 4) {
        ctx.globalAlpha = 0.95 * l1A; ctx.lineWidth = 1.5 / s; ctx.beginPath();
        for (let b = 0; b < L.nB; b++) {
          const cen: [number, number][] = [];
          for (let l = 0; l < CPB; l++) { const k = b * CPB + l; if (k >= L.N1) break; const [x, y] = cardXY(k); cen.push([x + L.cs / 2, y + L.cs / 2]); }
          for (let l = 0; l < cen.length; l++) {
            const col2 = l % 4, row = Math.floor(l / 4);
            if (col2 < 3 && l + 1 < cen.length) { ctx.moveTo(cen[l][0], cen[l][1]); ctx.lineTo(cen[l + 1][0], cen[l + 1][1]); }
            if (row === 0 && l + 4 < cen.length) { ctx.moveTo(cen[l][0], cen[l][1]); ctx.lineTo(cen[l + 4][0], cen[l + 4][1]); }
          }
        }
        ctx.stroke();
      }
      // L2 cabinet blade-mesh flow
      if (links && s * L.bw > 14) {
        ctx.globalAlpha = 0.95 * l2A; ctx.lineWidth = 1.8 / s; ctx.beginPath();
        for (let cab = 0; cab < L.nC; cab++) {
          const c: [number, number][] = [];
          for (let bl = 0; bl < BPC; bl++) { const blade = cab * BPC + bl; if (blade >= L.nB) break; const [bx, by] = bladeXY(cab, bl); c.push([bx + L.bw / 2, by + L.bh / 2]); }
          for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { ctx.moveTo(c[i][0], c[i][1]); ctx.lineTo(c[j][0], c[j][1]); }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.restore();
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
  }, [L, colorBy, links, fit, cabXY, bladeXY, cardXY, groupOf, dark, play, scenario, layout, selL]);

  // re-fit when the layout (top ↔ layers) changes, then redraw
  useEffect(() => { tf.current = null; setSelL(null); setPlay(false); }, [layout]);
  // redraw on colour / size changes
  useEffect(() => { draw(); }, [draw]);

  // scenario playback loop: advance the flow phase and redraw
  useEffect(() => {
    if (!play || layout !== 'top') { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; return; }
    const loop = () => { phaseRef.current += 0.02; draw(); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [play, draw, layout]);
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
    const fb = fit(r.width, r.height), maxZ = layout === 'layers' ? fb * 400 : fb * 60;   // layers needs deep zoom to resolve cards/threads
    const f = Math.exp(-e.deltaY * 0.0015); const ns = Math.max(fb * 0.5, Math.min(t.s * f, maxZ));
    tf.current = { s: ns, tx: mx - wx * ns, ty: my - wy * ns }; draw();
  };
  const onDown = (e: React.PointerEvent) => { if (!tf.current) return; downXY.current = { x: e.clientX, y: e.clientY }; drag.current = { x: e.clientX, y: e.clientY, tx: tf.current.tx, ty: tf.current.ty }; (e.target as Element).setPointerCapture(e.pointerId); };
  const onUp = (e: React.PointerEvent) => {
    // layered view: a click (no drag) selects a node → highlight its up/down-stream chain
    if (layout === 'layers' && downXY.current && Math.abs(e.clientX - downXY.current.x) + Math.abs(e.clientY - downXY.current.y) < 5) {
      const [wx, wy] = toWorld(e.clientX, e.clientY); const hit = pickLayer(wx, wy);
      setSelL((prev) => (hit && prev && prev.lvl === hit.lvl && prev.idx === hit.idx ? null : hit));
    }
    downXY.current = null; drag.current = null; try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current && tf.current) { tf.current = { ...tf.current, tx: drag.current.tx + (e.clientX - drag.current.x), ty: drag.current.ty + (e.clientY - drag.current.y) }; draw(); return; }
    if (layout === 'layers') return;   // layered view: pan/zoom only (no per-card hover)
    const [wx, wy] = toWorld(e.clientX, e.clientY); const k = pick(wx, wy);
    if (k !== hoverRef.current) { hoverRef.current = k; draw(); }
    const r = canvasRef.current!.getBoundingClientRect();
    setTip(k == null ? null : { k, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onLeave = () => { if (hoverRef.current != null) { hoverRef.current = null; draw(); } setTip(null); };

  const tipInfo = tip && (() => {
    const k = tip.k, b = Math.floor(k / CPB), cab = Math.floor(b / BPC);
    const parts = [`硬件：${TOK.n950} 卡 ${k}（1 device · 4 Die）`, `软件：rank ${k}（${TOK.hccl} 逻辑号 · 与 device 1:1）· tp${k % CPB}`, `约 ${CORES_PER_CARD} AI Core/卡 · 刀片 B${b} · 机柜 C${cab}`];
    if (colorBy !== 'none') parts.push(`${PARTITION_META[colorBy as Exclude<PartitionDim, 'none'>].label}：组 ${groupOf(k)}`);
    return parts;
  })();

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, zIndex: 11, background: 'var(--bg2)', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: drag.current ? 'grabbing' : layout === 'layers' ? 'pointer' : 'crosshair', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerUp={onUp} onPointerMove={onMove} onPointerLeave={onLeave}
      />
      {/* controls */}
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
        {/* layout: top-down map vs. layered hierarchy */}
        <span style={{ fontSize: 11.5, color: 'var(--tx2)' }}>布局</span>
        {([['top', '顶视图'], ['layers', '层级图']] as [typeof layout, string][]).map(([id, lb]) => {
          const on = layout === id;
          return <button key={id} onClick={() => setLayout(id)} title={id === 'top' ? '超节点顶视图（嵌套平铺）' : '层级矩阵图（超节点→机柜→节点→卡/NPU(1 device·4 Die)→AI Core，每层一张矩阵）'}
            style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${on ? '#4369ef' : 'var(--bd)'}`, background: on ? 'rgba(67,105,239,0.12)' : 'transparent', color: on ? '#4369ef' : 'var(--tx2)' }}>{lb}</button>;
        })}
        <span style={{ borderLeft: '1px solid var(--bd)', height: 16, margin: '0 2px' }} />
        {layout === 'top' ? (
          <>
            <span style={{ fontSize: 11.5, color: 'var(--tx2)' }}>上色</span>
            {COLOR_BTNS.map((c) => {
              const on = colorBy === c.id; const sig = PARALLEL_COLORS[c.id];
              return <button key={c.id} onClick={() => setColorBy(c.id)} title={`按 ${c.label} 上色`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${on ? sig : 'var(--bd)'}`, background: on ? `${sig}1f` : 'transparent', color: on ? sig : 'var(--tx2)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: sig, display: 'inline-block', opacity: on ? 1 : 0.6 }} />{c.label}
              </button>;
            })}
            <button onClick={() => setLinks((v) => !v)} title="卡↔卡（L1 板载）+ 节点↔节点（L2 机柜内）连线，放大后显示"
              style={{ padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 4, border: `1px solid ${links ? UB_LEVELS[1].color : 'var(--bd)'}`, background: links ? `${UB_LEVELS[1].color}22` : 'transparent', color: links ? 'var(--tx)' : 'var(--tx3)' }}>
              <span style={{ width: 9, height: 3, background: UB_LEVELS[1].color, display: 'inline-block', borderRadius: 1, opacity: links ? 1 : 0.4 }} />连线
            </button>
            <span style={{ borderLeft: '1px solid var(--bd)', height: 16, margin: '0 2px' }} />
            {(['ring', 'a2a'] as const).map((sc) => {
              const on = scenario === sc, c = sc === 'ring' ? COMM_PATTERNS[0].color : COMM_PATTERNS[1].color;
              return <button key={sc} onClick={() => { setScenario(sc); setPlay(true); }} title={sc === 'ring' ? 'Ring-AllReduce（数据并行梯度规约）' : 'All-to-All（MoE 专家并行）'}
                style={{ padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${on ? c : 'var(--bd)'}`, background: on ? `${c}1f` : 'transparent', color: on ? c : 'var(--tx2)' }}>{sc === 'ring' ? 'AllReduce' : 'All-to-All'}</button>;
            })}
            <button onClick={() => setPlay((v) => !v)} title="播放 / 暂停 数据流动"
              style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `1px solid ${play ? '#4369ef' : 'var(--bd)'}`, background: play ? 'rgba(67,105,239,0.12)' : 'transparent', color: play ? '#4369ef' : 'var(--tx2)' }}>{play ? '⏸ 播放中' : '▶ 播放'}</button>
            <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 2 }}>{`${L.N1.toLocaleString()} 卡 · ${L.nC} 机柜 · 拖动 / 滚轮缩放`}</span>
          </>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--tx3)' }}>{`层级矩阵图 · 全量 ${LAY.levels[3].count.toLocaleString()} 卡/device · 每层一张矩阵(同顶视图) · 缩放看个体，点格高亮上下游链路`}</span>
        )}
      </div>
      {/* legend */}
      <div style={{ position: 'absolute', bottom: 12, left: 12, padding: '7px 11px', fontSize: 11, background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', lineHeight: 1.6, color: 'var(--tx2)' }}>
        {layout === 'top' ? (
          <>
            <div style={{ fontWeight: 600, color: 'var(--tx)', marginBottom: 2 }}>{`全量${TOK.supernode} · 平面拓扑`}</div>
            <div><span style={{ display: 'inline-block', width: 11, height: 11, background: 'rgba(167,139,250,0.18)', border: `1px solid ${UB_LEVELS[2].color}`, borderRadius: 2, verticalAlign: '-2px', marginRight: 5 }} />L2 机柜框（含 8 刀片）</div>
            <div><span style={{ display: 'inline-block', width: 11, height: 11, border: `1px solid ${UB_LEVELS[1].color}`, borderRadius: 2, verticalAlign: '-2px', marginRight: 5 }} />L1 刀片框（含 8 卡）</div>
            <div><span style={{ color: ENTITY_COLORS.card, fontWeight: 600 }}>卡 = 1 device</span>（硬件）· <span style={{ color: ENTITY_COLORS.rank, fontWeight: 600 }}>r 号 = rank</span>（软件 · 1:1 绑定） · <span style={{ display: 'inline-block', width: 7, height: 7, background: ENTITY_COLORS.computeDie, borderRadius: 1, verticalAlign: '-1px', marginLeft: 4, marginRight: 1 }} /><span style={{ display: 'inline-block', width: 7, height: 7, background: ENTITY_COLORS.ioDie, borderRadius: 1, verticalAlign: '-1px', marginRight: 4 }} />卡内 = 4 Die：2 计算(UMA)+2 IO（放大显示）</div>
            <div>{colorBy === 'none' ? '格子 = 1 张 950 卡 / device（嵌套=包含关系）' : `卡按 ${colorBy.toUpperCase()} 组上色（${cfg}）`}</div>
            {links && <div><span style={{ display: 'inline-block', width: 11, height: 0, borderTop: `2px solid ${UB_LEVELS[1].color}`, verticalAlign: 'middle', marginRight: 5 }} />卡↔卡(L1) · <span style={{ display: 'inline-block', width: 11, height: 0, borderTop: `2px solid ${UB_LEVELS[2].color}`, verticalAlign: 'middle', margin: '0 5px' }} />节点↔节点(L2)，放大显示</div>}
            {play && <div style={{ color: scenario === 'ring' ? COMM_PATTERNS[0].color : COMM_PATTERNS[1].color }}>{scenario === 'ring' ? '▶ Ring-AllReduce：先卡内(L1)逐跳→再机柜内(L2)' : '▶ All-to-All：机柜内刀片全互联(L2)'} · 放大看流动</div>}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: 'var(--tx)', marginBottom: 3 }}>{`${TOK.supernode} · 层级矩阵图`}</div>
            {/* each level = a matrix grid of its real units, with a distinct glyph */}
            {LAY.levels.map((Lv) => {
              const shape = ({ super: '面板', cab: '柜+槽位', node: '刀片+8 NPU 点', card: '4 Die = 2 计算(UMA)+2 IO', core: 'Cube + 2 Vector' } as Record<string, string>)[Lv.kind];
              return <div key={Lv.kind}><span style={{ display: 'inline-block', width: 9, height: 9, background: Lv.color, borderRadius: 2, verticalAlign: '-1px', marginRight: 5 }} />{Lv.label} <span style={{ color: 'var(--tx3)' }}>×{Lv.count.toLocaleString()} · {shape}</span></div>;
            })}
            <div style={{ borderTop: '1px solid var(--bd)', marginTop: 3, paddingTop: 3, color: 'var(--tx3)', fontSize: 10 }}>每层=该级全部单元的矩阵铺排（同顶视图）· 放大看图元(卡内含 4 Die · AI Core 含 Cube/Vector) · <span style={{ color: ENTITY_COLORS.card }}>硬件 device</span> ↔ <span style={{ color: ENTITY_COLORS.rank }}>软件 rank</span> 严格 1:1</div>
            <div style={{ color: '#ffb020', fontSize: 10.5 }}>{selL ? '已选中：金色=其上游父级 + 下游子级链路 · 再点取消' : '点任一格 → 高亮上下游链路 + 右上详情'}</div>
          </>
        )}
      </div>
      {/* layered-view selection detail — level semantics (层内 / 层间关系 + 带宽/域) */}
      {layout === 'layers' && selL && (() => {
        const info = LAYER_INFO[selL.lvl]; if (!info) return null;
        const col = LAY.levels[selL.lvl].color;
        return (
          <div style={{ position: 'absolute', top: 12, right: 12, width: 280, padding: '11px 13px', fontSize: 11.5, lineHeight: 1.5, background: 'var(--panel)', border: `1px solid ${col}`, borderRadius: 12, boxShadow: 'var(--shadow)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: col }} />
              <span style={{ fontWeight: 700, color: 'var(--tx)', fontSize: 12.5 }}>{info.name}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {info.tag && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 5, color: info.tag.includes('1:1') ? '#04d793' : '#ffaa3b', border: `1px solid ${info.tag.includes('1:1') ? '#04d793' : '#ffaa3b'}` }}>{info.tag.split('（')[0]}</span>}
                {info.domain !== '—' && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 5, color: info.domain.includes('SU') ? '#04d793' : '#7c8db8', border: `1px solid ${info.domain.includes('SU') ? '#04d793' : '#7c8db8'}` }}>{info.domain}</span>}
              </span>
            </div>
            {/* hardware ↔ software cleanly separated (rank is never the hardware) */}
            {info.hw && <div style={{ marginBottom: 5, padding: '5px 7px', borderRadius: 7, background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.38)' }}><span style={{ color: ENTITY_COLORS.hw, fontWeight: 700, fontSize: 10.5, letterSpacing: 0.3 }}>硬件 HW</span> <span style={{ color: 'var(--tx2)' }}>{info.hw.replace(/^硬件：/, '')}</span></div>}
            {info.sw && <div style={{ marginBottom: 6, padding: '5px 7px', borderRadius: 7, background: 'rgba(67,105,239,0.10)', border: '1px solid rgba(67,105,239,0.35)' }}><span style={{ color: ENTITY_COLORS.sw, fontWeight: 700, fontSize: 10.5, letterSpacing: 0.3 }}>软件 SW</span> <span style={{ color: 'var(--tx2)' }}>{info.sw.replace(/^软件：/, '')}</span></div>}
            <div style={{ marginBottom: 6 }}><span style={{ color: COMM_PATTERNS[2].color, fontWeight: 600 }}>层内关系</span> <span style={{ color: 'var(--tx2)' }}>{info.intra}</span></div>
            <div style={{ marginBottom: 6 }}><span style={{ color: '#4369ef', fontWeight: 600 }}>层间关系</span> <span style={{ color: 'var(--tx2)' }}>{info.inter}</span></div>
            <div style={{ color: 'var(--tx3)', fontSize: 10.5, borderTop: '1px solid var(--bd)', paddingTop: 5 }}>带宽/时延：{info.bw}</div>
          </div>
        );
      })()}
      {/* hover tooltip */}
      {tip && tipInfo && (
        <div style={{ position: 'absolute', left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 9999) - 200), top: tip.y + 14, padding: '6px 9px', fontSize: 11.5, background: 'var(--panel)', border: '1px solid var(--bd2)', borderRadius: 10, pointerEvents: 'none', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'var(--tx)' }}>
          {tipInfo.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
