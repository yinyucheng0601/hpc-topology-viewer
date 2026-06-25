// ─── 2D 连线样式（bus-wiring 风格）────────────────────────────────────────────
// 参考 https://github.com/Cinnnnnnndy/bus-wiring 的连线样式，在 2D <canvas> 上还原其
// 视觉语言：圆角走线 + 沿线流动的「彗星」白色亮带 + 两端 connector 接点（色环 + 白芯）。
// 颜色 / 粗细 / 透明度由调用方按本项目原有规则给定，这里只负责样式呈现。

/** 折线圆角路径（折角处插二次贝塞尔，半径夹到两侧半段长）。仅建立 path，不描边。 */
export function roundedPath2d(ctx: CanvasRenderingContext2D, pts: [number, number][], radius: number) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const inx = p[0] - a[0], iny = p[1] - a[1], lIn = Math.hypot(inx, iny) || 1;
    const oux = b[0] - p[0], ouy = b[1] - p[1], lOut = Math.hypot(oux, ouy) || 1;
    const r = Math.min(radius, lIn * 0.5, lOut * 0.5);
    ctx.lineTo(p[0] - (inx / lIn) * r, p[1] - (iny / lIn) * r);
    ctx.quadraticCurveTo(p[0], p[1], p[0] + (oux / lOut) * r, p[1] + (ouy / lOut) * r);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

/** connector 接点：色环 + 白芯（r 为外环半径，已含缩放）。 */
export function connDot2d(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
}

/** 流动彗星：一段沿 p→q 滑动的白色亮带（active 链路高亮）。phase 取调用方共享流动相位。 */
export function comet2d(ctx: CanvasRenderingContext2D, p: [number, number], q: [number, number], color: string, w: number, phase: number, alpha = 1) {
  const t = ((phase % 1) + 1) % 1, head = 0.18, t0 = Math.max(0, t - head);
  const ax = p[0] + (q[0] - p[0]) * t0, ay = p[1] + (q[1] - p[1]) * t0;
  const bx = p[0] + (q[0] - p[0]) * t, by = p[1] + (q[1] - p[1]) * t;
  if (ax === bx && ay === by) return;
  const grad = ctx.createLinearGradient(ax, ay, bx, by);
  grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, '#ffffff');
  ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = w; ctx.globalAlpha = alpha;
  ctx.strokeStyle = grad; ctx.shadowColor = color; ctx.shadowBlur = w * 2.4;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore();
}

/**
 * 「平面」总线连线（bus-wiring 的正交/平面投影版）：圆角(可正交)走线 + 管体感描边
 * （暗色外廓 + 实色管身）+ 沿线流动彗星 + 两端 connector 接点（色环 + 白芯）。
 * 颜色 / 粗细 / 透明度由调用方按原规则给定（width 已含缩放）。
 */
export function busWire2d(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  color: string,
  width: number,
  opts: { phase?: number; flowing?: boolean; caps?: boolean; alpha?: number; dash?: number[] | null; tube?: boolean; corner?: number } = {},
) {
  if (pts.length < 2) return;
  const { phase = 0, flowing = false, caps = true, alpha = 1, dash = null, tube = true, corner } = opts;
  const r = corner ?? width * 2.2;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = alpha;
  if (tube) { ctx.lineWidth = width * 1.9; ctx.strokeStyle = 'rgba(8,11,18,0.45)'; roundedPath2d(ctx, pts, r); ctx.stroke(); }   // 管体外廓
  ctx.lineWidth = width; ctx.strokeStyle = color; if (dash) ctx.setLineDash(dash);   // 管身（可虚线=平面/分类）
  roundedPath2d(ctx, pts, r); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
  if (flowing) for (let i = 0; i + 1 < pts.length; i++) comet2d(ctx, pts[i], pts[i + 1], color, width * 1.25, phase, alpha);
  if (caps) { connDot2d(ctx, pts[0][0], pts[0][1], width * 1.5, color); const e = pts[pts.length - 1]; connDot2d(ctx, e[0], e[1], width * 1.5, color); }
}
