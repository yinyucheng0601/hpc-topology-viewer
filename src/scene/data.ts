// ─────────────────────────────────────────────────────────────────────────────
// Cluster model data layer — two generations (A5 / A6).
//
// Specs are drawn from public conference / vendor material (see SOURCES in
// ../content). In-cabinet / die / node layouts are schematic abstractions
// (vendor sheet-metal drawings are not public) and do not represent a real
// physical layout.
//
// All product/brand display text is sourced from ../content (stored base64 and
// decoded at runtime), so this source file carries no plaintext product names.
// ─────────────────────────────────────────────────────────────────────────────
import { TOK, INFO, SOURCES, CHANGES } from '../content';

export { INFO, SOURCES, CHANGES };

export type RackKind = 'compute' | 'switch';
export type ViewMode = 'overview' | 'rack' | 'node' | 'topology' | 'matrix' | 'mapping' | 'trace' | 'fullpod';
export type Gen = 'A5' | 'A6';

// ─── Generation specs ────────────────────────────────────────────────────────
export interface GenSpec {
  code: Gen;
  name: string;             // pod form-factor display name
  npuLabel: string;         // accelerator display label
  npuShort: string;         // accelerator short label
  totalNpus: number;
  fp8EF: number;            // EFLOPS FP8
  fp4EF: number;            // EFLOPS FP4
  memTB: number;            // total HBM capacity
  memPerChipTBs: number;    // per-chip HBM bandwidth (TB/s)
  interconnectPBs: number;  // total UB interconnect bandwidth (PB/s)
  chipUbTBs: number;        // per-NPU UB bandwidth (TB/s)
  computeCabs: number;
  commCabs: number;
  totalCabs: number;
  footprintM2: number;
  hbm: string;              // self-developed HBM name
  release: string;
  trainTokps: string;
  inferTokps: string;
  superclusterNpu: string;  // cluster-level scale
  // per-chip specs (A5 from the published whitepaper; A6 estimated/derived)
  memGB: number;            // per-chip HBM capacity
  fp4Tflops: number | null; // per-chip MXFP4 TFLOPS
  fp8Tflops: number | null; // per-chip FP8-class TFLOPS
  l2MB: number | null;      // global L2 cache
  ubGBs: number;            // per-chip UB bandwidth (GB/s, bidirectional)
  aiSubsys: number | null;  // AI subsystems (each = 1 Cube + 2 Vector)
  estimated?: boolean;      // per-chip figures are estimates (A6)
}

export const GENERATIONS: Record<Gen, GenSpec> = {
  A5: {
    code: 'A5', name: TOK.atlas950, npuLabel: `${TOK.ascend} ${TOK.n950dt}`, npuShort: TOK.n950dt,
    totalNpus: 8192, fp8EF: 8, fp4EF: 16, memTB: 1152, memPerChipTBs: 4, interconnectPBs: 16, chipUbTBs: 2,
    computeCabs: 128, commCabs: 32, totalCabs: 160, footprintM2: 1000,
    hbm: TOK.hbmZQ, release: '2026 Q4', trainTokps: '4.91M tok/s', inferTokps: '19.6M tok/s',
    superclusterNpu: '>52万',
    memGB: 144, fp4Tflops: 2007, fp8Tflops: 1034, l2MB: 128, ubGBs: 2016, aiSubsys: 36,
  },
  A6: {
    code: 'A6', name: TOK.atlas960, npuLabel: `${TOK.ascend} ${TOK.n960}`, npuShort: TOK.n960,
    totalNpus: 15488, fp8EF: 30, fp4EF: 60, memTB: 4460, memPerChipTBs: 4, interconnectPBs: 34, chipUbTBs: 4,
    computeCabs: 176, commCabs: 44, totalCabs: 220, footprintM2: 2200,
    hbm: TOK.hbmZQ, release: '2027 Q4', trainTokps: '15.9M tok/s', inferTokps: '80.5M tok/s',
    superclusterNpu: '>100万',
    memGB: 288, fp4Tflops: 3874, fp8Tflops: 1937, l2MB: null, ubGBs: 4032, aiSubsys: null, estimated: true,
  },
};

export const DEFAULT_GEN: Gen = 'A5';

// per-node schematic constants (illustrative; real per-node config not public)
export const NPUS_PER_NODE = 8;
export const CPUS_PER_NODE = 4;
export const DIES_PER_NPU = 2;        // package-internal dies (UB / SIO die-to-die)
export const NODES_PER_CAB = 8;       // 8 nodes × 8 NPU = 64 NPU per compute cabinet

// ─── UB interconnect hierarchy (chip → cluster), drives all colour coding ─────
export interface UbLevel { id: string; color: string; label: string; detail: string; }
export const UB_LEVELS: UbLevel[] = [
  { id: 'L0', color: '#2dd4bf', label: '片内 die',                  detail: '封装内 die 间 UB / SIO 直连' },
  { id: 'L1', color: '#38bdf8', label: '节点内',                    detail: '板载 UB 2D-Mesh，NPU 直连' },
  { id: 'L2', color: '#a78bfa', label: `机柜内 ${TOK.fullmesh}`,    detail: `跨节点 ${TOK.fullmesh} 总线级直连` },
  { id: 'L3', color: '#fb923c', label: `${TOK.supernode} Clos`,     detail: `经 UB 交换(通信柜) Clos 全互联` },
  { id: 'L4', color: '#4ade80', label: `${TOK.supernode}间`,        detail: `${TOK.supercluster} scale-out（全光）` },
];

// ─── Process / thread communication overlays (node view) ─────────────────────
export interface CommPattern { id: string; color: string; label: string; }
export const COMM_PATTERNS: CommPattern[] = [
  { id: 'ring',   color: '#f43f5e', label: 'Ring AllReduce · 进程(rank)' },
  { id: 'a2a',    color: '#f59e0b', label: 'All-to-All MoE · 进程(rank)' },
  { id: 'thread', color: '#22d3ee', label: 'die 内线程 / AI Core 流' },
];

// ─── Trace timeline (illustrative training-iteration schedule, NOT a real profile) ─
export type Phase = 'load' | 'compute' | 'comm' | 'store';
export const TRACE_SCHED: Phase[] = ['load', 'compute', 'compute', 'comm', 'compute', 'compute', 'comm', 'store'];
export const PHASE_META: Record<Phase, { name: string; color: string }> = {
  load:    { name: '加载',           color: '#c2c9d4' },
  compute: { name: '计算（算子/Tile）', color: '#22d3ee' },
  comm:    { name: '通信 AllReduce',  color: '#f43f5e' },
  store:   { name: '存储',           color: '#aab4c4' },
};

// ─── Full-pod "running" view: train / infer iteration schedules ───────────────
// Drives the phase wash + collectives over the full super-node. A schematic loop
// (illustrative, not a real profile). `kind` selects what lights up: compute →
// AI cores/cards, comm → ranks + the named collective, load/store/mem → data.
export type RunMode = 'train' | 'infer';
export type RunKind = 'load' | 'compute' | 'comm' | 'store' | 'mem';
export interface RunPhase {
  id: string; name: string; kind: RunKind; color: string;
  collective?: 'ring' | 'a2a';   // comm phases: which collective animates
  parallel?: string;             // the parallel dim exercised (TP/PP/DP/EP)
  note: string;
}
// ─── Model-parallel partition (maps a sharded model onto the physical levels) ─
// TP = within a blade (8 NPU, L1) · PP = blades within a replica (L2/L3) ·
// DP = replicas across the super-node (L3/L4) · EP = experts per cabinet (L2/L3).
export type PartitionDim = 'none' | 'tp' | 'pp' | 'dp' | 'ep';
export const PARTITION_META: Record<Exclude<PartitionDim, 'none'>, { label: string; level: string; comm: string; same: string }> = {
  tp: { label: 'TP 张量并行', level: 'L1 节点内（8 卡/节点）', comm: 'AllGather / ReduceScatter', same: '同色 = 同一张量切片（tp rank 0–7，每节点复现）' },
  pp: { label: 'PP 流水并行', level: 'L2/L3 跨刀片 · 跨柜',   comm: '阶段间 P2P 激活传递',        same: '同色 = 同一流水级（承载相同层）' },
  dp: { label: 'DP 数据并行', level: 'L3/L4 副本间',          comm: '梯度 AllReduce',            same: '同色 = 同一数据副本' },
  ep: { label: 'EP 专家并行', level: 'L2/L3 机柜内',          comm: 'token All-to-All',         same: '同色 = 同一专家组（All-to-All 域）' },
};
// cycling palette: group g → PARTITION_PALETTE[g % len] (same colour = same parallel group)
export const PARTITION_PALETTE = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#10b981', '#f97316', '#06b6d4', '#a855f7'];

export const RUN_SCHED: Record<RunMode, RunPhase[]> = {
  train: [
    { id: 'load', name: '加载 batch',      kind: 'load',    color: '#c2c9d4', parallel: 'DP',    note: '各 DP 副本读入各自 micro-batch' },
    { id: 'fwd',  name: '前向 Forward',    kind: 'compute', color: '#22d3ee', parallel: 'TP·PP', note: 'TP 层内并行 + PP 流水级逐级前向' },
    { id: 'bwd',  name: '反向 Backward',   kind: 'compute', color: '#0ea5e9', parallel: 'TP·PP', note: '反向传播逐级回传，产生梯度' },
    { id: 'ar',   name: '梯度 AllReduce',  kind: 'comm',    color: '#f43f5e', collective: 'ring', parallel: 'DP', note: 'DP 副本间环状 AllReduce 同步梯度' },
    { id: 'opt',  name: '优化器更新',      kind: 'store',   color: '#aab4c4', parallel: '—',     note: '更新参数 / 写回（含 store）' },
  ],
  infer: [
    { id: 'pre', name: 'Prefill 预填充',     kind: 'compute', color: '#22d3ee', parallel: 'TP', note: '提示词整段并行前向，KV-Cache 建立' },
    { id: 'a2a', name: 'MoE All-to-All',     kind: 'comm',    color: '#f59e0b', collective: 'a2a', parallel: 'EP', note: '专家并行 token 分发 All-to-All' },
    { id: 'dec', name: 'Decode 解码(逐token)', kind: 'compute', color: '#34d399', parallel: 'TP', note: '自回归逐 token 前向，吞吐 = tok/s' },
    { id: 'kv',  name: 'KV-Cache 读写',      kind: 'mem',     color: '#a78bfa', parallel: '—', note: '每步读写 KV-Cache（显存带宽受限）' },
  ],
};

export const RACK_COLORS = {
  accent: '#e0252f',
  computeGlow: '#38bdf8',
  switchGlow: '#fb923c',
} as const;

// ─── Overview hall: compute-cabinet grid + communication-cabinet spine ────────
export interface CabinetCell {
  id: string;
  kind: RackKind;
  pos: [number, number, number];
}

const HALL_COLS = 16;
export const CAB_W = 0.34, CAB_H = 1.3, CAB_D = 0.68;
const CAB_GAP_X = 0.12, CAB_GAP_Z = 0.5, BLOCK_GAP_Z = 1.0;

/** Build a schematic data-hall floor for a generation:
 *  compute cabinets in a front grid, communication cabinets as a rear block. */
export function buildHall(gen: GenSpec): CabinetCell[] {
  const cells: CabinetCell[] = [];
  const pitchX = CAB_W + CAB_GAP_X;
  const pitchZ = CAB_D + CAB_GAP_Z;
  const rowW = HALL_COLS * pitchX;
  const x0 = -rowW / 2 + CAB_W / 2;

  const computeRows = Math.ceil(gen.computeCabs / HALL_COLS);
  let z = 0;
  // compute block (front, toward +Z growing away)
  for (let i = 0; i < gen.computeCabs; i++) {
    const r = Math.floor(i / HALL_COLS);
    const c = i % HALL_COLS;
    cells.push({ id: `c-${i}`, kind: 'compute', pos: [x0 + c * pitchX, 0, r * pitchZ] });
    z = r * pitchZ;
  }
  // communication block (rear, separated by an aisle)
  const commZ0 = z + pitchZ + BLOCK_GAP_Z;
  for (let i = 0; i < gen.commCabs; i++) {
    const r = Math.floor(i / HALL_COLS);
    const c = i % HALL_COLS;
    cells.push({ id: `s-${i}`, kind: 'switch', pos: [x0 + c * pitchX, 0, commZ0 + r * pitchZ] });
  }
  // centre the whole hall on the Z origin
  const zs = cells.map((c) => c.pos[2]);
  const zMid = (Math.min(...zs) + Math.max(...zs)) / 2;
  for (const cell of cells) cell.pos[2] -= zMid;
  void computeRows;
  return cells;
}

// ─── Cabinet internals (representative; metres, schematic slots) ──────────────
export const RACK_DIM = { w: 0.6, h: 2.25, d: 1.15 };

export interface RackUnit {
  id: string;
  type: 'node' | 'switch-unit' | 'power' | 'mgmt' | 'cdu';
  label: string;
  labelEn: string;
  y0: number;      // unit bottom (0..1 of rack height)
  hFrac: number;   // unit height fraction (0..1)
  nodeSlot?: number;
}

export const COMPUTE_RACK_UNITS: RackUnit[] = (() => {
  const u: RackUnit[] = [];
  u.push({ id: 'power', type: 'power', label: '集中供电 Busbar / 电源框', labelEn: 'Power / Busbar', y0: 0.93, hFrac: 0.05 });
  u.push({ id: 'mgmt',  type: 'mgmt',  label: '柜管模块 + GE 管理交换',   labelEn: 'Mgmt + GE',      y0: 0.882, hFrac: 0.038 });
  const top = 0.86, bottom = 0.075, gap = 0.004;
  const step = (top - bottom) / NODES_PER_CAB;
  for (let i = 0; i < NODES_PER_CAB; i++) {
    u.push({
      id: `node-${i}`, type: 'node',
      label: `计算节点 ${i + 1}（液冷刀片 · ${NPUS_PER_NODE}× NPU）`,
      labelEn: `Node ${i + 1}`,
      y0: bottom + (NODES_PER_CAB - 1 - i) * step + gap / 2,
      hFrac: step - gap, nodeSlot: i,
    });
  }
  u.push({ id: 'cdu', type: 'cdu', label: 'Manifold 液冷分集水器 / 快接头', labelEn: 'Liquid Manifold', y0: 0.012, hFrac: 0.055 });
  return u;
})();

export const SWITCH_UNIT_COUNT = 6;
export const SWITCH_RACK_UNITS: RackUnit[] = (() => {
  const u: RackUnit[] = [];
  u.push({ id: 'power', type: 'power', label: '电源管理 · 集中供电', labelEn: 'Power Shelf', y0: 0.92, hFrac: 0.06 });
  for (let i = 0; i < SWITCH_UNIT_COUNT; i++) {
    u.push({
      id: `sw-${i}`, type: 'switch-unit',
      label: `${TOK.ub} 交换设备 ${i + 1}（UB Clos 顶层 · 全光）`,
      labelEn: `UB Switch ${i + 1}`,
      y0: 0.10 + (SWITCH_UNIT_COUNT - 1 - i) * 0.128, hFrac: 0.108,
    });
  }
  u.push({ id: 'mgmt', type: 'mgmt', label: '管理 / 全光配线区', labelEn: 'Mgmt / Optical Patch', y0: 0.015, hFrac: 0.07 });
  return u;
})();

// ─── Compute-node internals (abstract blade layout, metres) ──────────────────
export const NODE_DIM = { w: 0.86, h: 0.12, d: 0.72 };

export interface NodePart {
  id: string;
  type: 'npu' | 'cpu' | 'ub-fabric' | 'dpu' | 'optical' | 'dimm';
  label: string;
  pos: [number, number, number];
  size: [number, number, number];
  /** NPU index 0..7 (for overlay wiring) */
  npuIdx?: number;
}

// 8 NPUs in a 2×4 grid — these positions drive the die / process / thread overlays.
export const NPU_GRID = { cols: 4, rows: 2, pitchX: 0.18, pitchZ: 0.17, z0: -0.16 };

export const NODE_PARTS: NodePart[] = (() => {
  const parts: NodePart[] = [];
  for (let i = 0; i < NPUS_PER_NODE; i++) {
    const c = i % NPU_GRID.cols, r = Math.floor(i / NPU_GRID.cols);
    const cx = (c - (NPU_GRID.cols - 1) / 2) * NPU_GRID.pitchX;
    const cz = NPU_GRID.z0 + r * NPU_GRID.pitchZ;
    parts.push({
      id: `npu-${i}`, type: 'npu', npuIdx: i,
      label: `${TOK.ascend} ${TOK.n950dt} #${i + 1} · ${DIES_PER_NPU} die · UB 2 TB/s · ${TOK.hbmZQ} HBM`,
      pos: [cx, 0.022, cz], size: [0.12, 0.024, 0.115],
    });
  }
  // 4 CPUs (front row)
  for (let i = 0; i < CPUS_PER_NODE; i++) {
    parts.push({
      id: `cpu-${i}`, type: 'cpu',
      label: `${TOK.kunpeng} ${TOK.n950} #${i + 1} · UB 全池化 · NUMA`,
      pos: [(i - 1.5) * 0.18, 0.018, 0.2], size: [0.085, 0.016, 0.085],
    });
  }
  // 2 DIMM banks
  for (let i = 0; i < 2; i++) {
    parts.push({
      id: `dimm-${i}`, type: 'dimm', label: 'DDR5 内存区（统一编址池化）',
      pos: [0, 0.014, 0.3 + i * 0.04], size: [0.72, 0.018, 0.026],
    });
  }
  // central UB fabric chips (L1 node-internal 2D-mesh switching)
  for (let i = 0; i < 2; i++) {
    parts.push({
      id: `ubf-${i}`, type: 'ub-fabric', label: `${TOK.ub} L1 板载 UB 2D-Mesh 交换 fabric`,
      pos: [(i - 0.5) * 0.22, 0.016, 0.02], size: [0.075, 0.014, 0.06],
    });
  }
  // DPU (VPC egress)
  parts.push({ id: 'dpu', type: 'dpu', label: `${TOK.qingtian} · VPC 外网`, pos: [0.36, 0.02, 0.24], size: [0.085, 0.02, 0.16] });
  // rear optical panel (UB uplink to comms cabinets, L3)
  parts.push({ id: 'optical', type: 'optical', label: '光口区 · UB 上行至通信柜（L3 Clos）+ RoCE scale-out', pos: [-0.02, 0.02, -0.34], size: [0.7, 0.026, 0.018] });
  return parts;
})();

export function npuPositions(): [number, number, number][] {
  return NODE_PARTS.filter((p) => p.type === 'npu').map((p) => p.pos);
}

// ─── Small-pod scales (16P / 32P / 64P) + recursive full-mesh adjacency ───────
// Recursive direct-connect full-mesh: 8 NPU/board form a 1D full mesh, boards
// form the next dimension, etc. (single 64-card cabinet = 8×8).
export type Scale = '16P' | '32P' | '32Pi' | '64P';
export interface ScaleSpec {
  id: Scale; label: string; npus: number; dims: number[];
  kind?: 'mesh' | 'switched';   // switched = single-hop fully-switched fabric
  paths?: number;               // parallel switch paths between any two NPUs
  uboe?: [number, number];      // external ethernet uplink ports per NPU (min, max)
}
export const SCALES: Record<Scale, ScaleSpec> = {
  '16P':  { id: '16P',  label: '16P 小超节点',     npus: 16, dims: [8, 2] },
  '32P':  { id: '32P',  label: '32P 小超节点',     npus: 32, dims: [8, 4] },
  '32Pi': { id: '32Pi', label: '32P 一体(单跳)',   npus: 32, dims: [32], kind: 'switched', paths: 6, uboe: [1, 2] },
  '64P':  { id: '64P',  label: '64P 单柜',         npus: 64, dims: [8, 8] },
};
export const DEFAULT_SCALE: Scale = '64P';

/** dim index → UB hierarchy level index (dim0=板内→L1, dim1=跨板→L2, dim2=跨柜→L3). */
export const dimToLevel = (d: number): number => Math.min(d + 1, UB_LEVELS.length - 1);

export interface AdjCell { level: number; direct: boolean; hops: number; paths?: number; }

/** 32P-integrated single-hop fully-switched fabric: any two NPUs reachable in one
 *  hop via the switch, with `paths` parallel switch paths between every pair. */
export function makeSwitchedAdjacency(n: number, paths: number): { n: number; cell: (i: number, j: number) => AdjCell } {
  return {
    n,
    cell: (i, j) => (i === j ? { level: -1, direct: false, hops: 0 } : { level: 3, direct: true, hops: 1, paths }),
  };
}

/** Recursive full-mesh adjacency for `dims`: two NPUs are directly UB-connected iff they
 *  differ in exactly one dimension; otherwise multi-hop. Cell colour = the
 *  (highest) differing dimension's UB level. */
export function makeAdjacency(dims: number[]): { n: number; cell: (i: number, j: number) => AdjCell } {
  const n = dims.reduce((a, b) => a * b, 1);
  const coords = (idx: number) => {
    const c: number[] = [];
    for (const d of dims) { c.push(idx % d); idx = Math.floor(idx / d); }
    return c;
  };
  const cell = (i: number, j: number): AdjCell => {
    if (i === j) return { level: -1, direct: false, hops: 0 };
    const ci = coords(i), cj = coords(j);
    const diff: number[] = [];
    for (let d = 0; d < dims.length; d++) if (ci[d] !== cj[d]) diff.push(d);
    return { level: dimToLevel(diff[diff.length - 1]), direct: diff.length === 1, hops: diff.length };
  };
  return { n, cell };
}

