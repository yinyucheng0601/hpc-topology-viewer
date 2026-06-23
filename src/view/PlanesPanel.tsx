/**
 * PlanesPanel — surfaces the PHYSICAL device layer + their relationships, as an
 * actual node-level schematic (objects + plane-coloured connector lines), drawn
 * INTO the 阵列全景 (full-pod), 顶视图 and 层级图 views. Shows: 8× NPU each with a
 * UB 端口 (scale-up·绿) and a RDMA/RoCE 端口 (scale-out·橙), the 鲲鹏 CPU, the L1/L2
 * UB 交换, LPO 光模块, and the 擎天 NIC — wired by the three planes
 * (UB scale-up / RDMA scale-out / VPC).
 *
 * Driven by ../scene/data (PLANES / PHYS_DEVICES / PHYS_CHAINS); brand terms via
 * those tokens.
 */
import { useState } from 'react';
import { PLANES, PHYS_DEVICES, type PlaneId } from '../scene/data';

const PLANE_BY_ID: Record<PlaneId, (typeof PLANES)[number]> = Object.fromEntries(PLANES.map((p) => [p.id, p])) as Record<PlaneId, (typeof PLANES)[number]>;
const C_UB = PLANE_BY_ID.ub.color;      // scale-up 绿
const C_RD = PLANE_BY_ID.rdma.color;    // scale-out 橙
const C_VPC = PLANE_BY_ID.vpc.color;    // VPC 紫
const C_LPO = '#36e0c4';                // LPO 光模块 青
const C_CPU = '#4a8cff';                // 鲲鹏 CPU 蓝

// ── one-node physical schematic: objects + plane-coloured relationships ──────────
function NodeSchematic() {
  // 8 NPU in a 4×2 grid, each carrying a UB port (绿) + RDMA port (橙)
  const cells = Array.from({ length: 8 }, (_, i) => {
    const c = i % 4, r = Math.floor(i / 4);
    return { i, x: 16 + c * 64, y: 22 + r * 44 };
  });
  const NW = 56, NH = 34;
  const box = (x: number, y: number, w: number, h: number, color: string, fill = 0.12) => (
    <rect x={x} y={y} width={w} height={h} rx={6} fill={`${color}${Math.round(fill * 255).toString(16).padStart(2, '0')}`} stroke={color} strokeWidth={1.2} />
  );
  const txt = (x: number, y: number, s: string, color = 'var(--tx)', size = 10, weight = 600, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={y} fontSize={size} fontWeight={weight} fill={color} textAnchor={anchor} dominantBaseline="middle">{s}</text>
  );
  return (
    <svg viewBox="0 0 548 196" style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* NPU group frame */}
      <rect x={8} y={12} width={272} height={96} rx={9} fill="none" stroke="var(--bd2)" strokeDasharray="3 3" />
      {txt(12, 8, '8× NPU', 'var(--tx2)', 9.5, 700, 'start')}
      {cells.map(({ i, x, y }) => (
        <g key={i}>
          {box(x, y, NW, NH, '#7c8db8', 0.16)}
          {txt(x + NW / 2 - 6, y + NH / 2, `N${i}`, 'var(--tx2)', 9, 600)}
          {/* UB 端口 (绿) top-right · RDMA 端口 (橙) bottom-right */}
          <circle cx={x + NW - 7} cy={y + 9} r={4} fill={C_UB} />
          <circle cx={x + NW - 7} cy={y + NH - 9} r={4} fill={C_RD} />
        </g>
      ))}

      {/* 鲲鹏 CPU */}
      {box(16, 120, 130, 34, C_CPU)}
      {txt(81, 137, '鲲鹏 CPU', C_CPU, 11, 700)}

      {/* middle column: UB 交换 / LPO / 擎天 NIC */}
      {box(312, 18, 128, 34, C_UB)}
      {txt(376, 35, 'L1/L2 UB 交换', C_UB, 10.5, 700)}
      {box(312, 64, 128, 34, C_LPO)}
      {txt(376, 81, 'LPO 光模块', C_LPO, 10.5, 700)}
      {box(312, 120, 128, 34, C_VPC)}
      {txt(376, 137, '擎天 NIC', C_VPC, 11, 700)}

      {/* right endpoints */}
      {box(456, 18, 84, 34, C_UB, 0.07)}
      {txt(498, 35, '超节点内', C_UB, 10, 600)}
      {box(456, 64, 84, 34, C_RD, 0.07)}
      {txt(498, 81, '其它超节点', C_RD, 9.5, 600)}
      {box(456, 120, 84, 34, C_VPC, 0.07)}
      {txt(498, 137, '数据中心', C_VPC, 10, 600)}

      {/* ── relationships (plane-coloured) ── */}
      {/* UB scale-up (绿): NPU UB 口 → UB 交换 → 超节点内; CPU 也在 UB 平面 → UB 交换 */}
      <g stroke={C_UB} strokeWidth={2} fill="none">
        <path d="M280 40 L312 35" />
        <path d="M440 35 L456 35" />
        <path d="M146 128 C 230 120, 250 60, 312 44" />
        <path d="M376 52 L376 64" strokeDasharray="3 3" />
      </g>
      {/* RDMA scale-out (橙): NPU RDMA 口 → LPO → 其它超节点 */}
      <g stroke={C_RD} strokeWidth={2} fill="none">
        <path d="M280 80 L312 81" />
        <path d="M440 81 L456 81" />
      </g>
      {/* VPC (紫): CPU → 擎天 NIC → 数据中心 */}
      <g stroke={C_VPC} strokeWidth={2} fill="none">
        <path d="M146 140 L312 137" />
        <path d="M440 137 L456 137" />
      </g>
      {/* edge labels */}
      {txt(296, 30, 'UB 口', C_UB, 8.5, 600)}
      {txt(296, 92, 'RDMA 口', C_RD, 8.5, 600)}
      {txt(232, 150, 'VPC', C_VPC, 8.5, 600)}
      {txt(384, 60, '柜间 LPO', C_LPO, 8, 500, 'start')}
    </svg>
  );
}

export function PlanesPanel() {
  const [open, setOpen] = useState(true);

  const pill: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', fontSize: 11.5, fontWeight: 600,
    borderRadius: 9, cursor: 'pointer', border: '1px solid var(--bd)', background: 'var(--panel)',
    color: 'var(--tx)', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
  };

  return (
    <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 30, maxWidth: 'calc(100vw - 24px)' }}>
      {!open ? (
        <button onClick={() => setOpen(true)} title="物理器件 & 三平面关系（NPU 端口 / CPU / LPO / NIC）" style={pill}>
          <span style={{ display: 'inline-flex', gap: 3 }}>
            {PLANES.map((p) => <span key={p.id} style={{ width: 9, height: 9, borderRadius: 2, background: p.color }} />)}
          </span>
          物理器件 & 三平面 ▾
        </button>
      ) : (
        <div style={{
          width: 'min(600px, calc(100vw - 24px))', padding: '9px 12px', fontSize: 11, lineHeight: 1.45,
          background: 'var(--panel)', border: '1px solid var(--bd)', borderRadius: 12, boxShadow: 'var(--shadow)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'var(--tx2)', maxHeight: 'calc(100vh - 90px)', overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <span style={{ fontWeight: 700, color: 'var(--tx)', fontSize: 12.5 }}>节点物理器件 & 三平面关系</span>
            <span style={{ color: 'var(--tx3)', fontSize: 10 }}>NPU 端口 · CPU · LPO · NIC</span>
            <button onClick={() => setOpen(false)} title="收起" style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11, lineHeight: 1, borderRadius: 7, cursor: 'pointer', border: '1px solid var(--bd)', background: 'var(--btn)', color: 'var(--tx2)' }}>✕</button>
          </div>

          {/* the schematic: objects + plane-coloured relationships */}
          <NodeSchematic />

          {/* three-plane legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 6 }}>
            {PLANES.map((p) => (
              <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 11, height: 3, borderRadius: 1, background: p.color }} />
                <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{p.short}</span>
                <span style={{ color: 'var(--tx3)' }}>{p.role} · {p.parallel}</span>
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: C_LPO }} />
              <span style={{ color: 'var(--tx3)' }}>LPO 光模块（线性直驱·柜间光介质）</span>
            </span>
          </div>

          {/* device one-liners */}
          <div style={{ borderTop: '1px solid var(--bd)', marginTop: 6, paddingTop: 5 }}>
            {PHYS_DEVICES.map((d) => (
              <div key={d.id} style={{ marginBottom: 1.5 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: d.color, verticalAlign: '-1px', marginRight: 5 }} />
                <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{d.label}</span>
                <span style={{ color: 'var(--tx3)' }}> · {d.note}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 5, fontSize: 9.5, color: 'var(--tx3)', fontStyle: 'italic' }}>
            关键点：scale-out RDMA 走 NPU 自带 RoCE 口（非擎天 NIC）；擎天 NIC 负责 VPC。来源：CloudMatrix384 三平面解读 · LPO（厂商/媒体口径 C）。
          </div>
        </div>
      )}
    </div>
  );
}
