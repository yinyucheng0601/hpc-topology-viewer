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
export type ViewMode = 'overview' | 'rack' | 'node' | 'topology' | 'matrix' | 'mapping' | 'trace' | 'fullpod' | 'plane';
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
// 950-class package = 4 Die per card: 2 compute Die (UMA-merged → OS sees ONE device,
// which the software rank binds to 1:1) + 2 IO Die (interconnect / IO). die-to-die via UB/SIO.
export const COMPUTE_DIES_PER_CARD = 2;
export const IO_DIES_PER_CARD = 2;
export const DIES_PER_NPU = COMPUTE_DIES_PER_CARD + IO_DIES_PER_CARD;   // = 4 (950)
export const NODES_PER_CAB = 8;       // 8 nodes × 8 NPU = 64 NPU per compute cabinet

// ─── UB interconnect hierarchy (chip → cluster), drives all colour coding ─────
export interface UbLevel { id: string; color: string; label: string; detail: string; }
export const UB_LEVELS: UbLevel[] = [
  { id: 'L0', color: '#2dd4bf', label: '片内 die',                  detail: '封装内 die 间 UB / SIO 直连' },
  { id: 'L1', color: '#38bdf8', label: '节点内',                    detail: '板载 UB 2D-Mesh，NPU 直连' },
  { id: 'L2', color: '#a78bfa', label: `机柜内 ${TOK.fullmesh}`,    detail: `跨节点 ${TOK.fullmesh} 总线级直连` },
  { id: 'L3', color: '#ffaa3b', label: `${TOK.supernode} Clos`,     detail: `经 UB 交换(通信柜) Clos 全互联` },
  { id: 'L4', color: '#04d793', label: `${TOK.supernode}间`,        detail: `${TOK.supercluster} scale-out（全光）` },
];

// Per UB level: scale-up/scale-out domain + bandwidth/latency + the parallel dims
// that prefer it. (SU = scale-up 超高带宽窄域 全互联 ≤128 卡 → TP·EP; SO = scale-out
// 高带宽广域，双层 UB 交换 → PP·DP. Sources: UB 互联研究 @ Hot Chips.)
export interface UbLevelMeta { domain: 'SU' | 'SO'; bw: string; parallel: string; }
export const UB_LEVEL_META: Record<string, UbLevelMeta> = {
  L0: { domain: 'SU', bw: 'D2D 双向 784 GB/s',           parallel: '片内 die 对等' },
  L1: { domain: 'SU', bw: '单卡 UB 2016 GB/s · 板载 2D-Mesh', parallel: 'TP 张量并行（窄快）' },
  L2: { domain: 'SU', bw: `柜内 ${TOK.fullmesh} · 单跳 200 ns · 1:1 无收敛`, parallel: 'TP·EP（SU 超低延迟域）' },
  L3: { domain: 'SO', bw: 'any-to-any <1 µs · 16 PB/s · 双层 UB 交换', parallel: 'EP·PP（SO 广域）' },
  L4: { domain: 'SO', bw: `跨超节点 ${TOK.uboe}/RoCE`,    parallel: 'DP 数据并行（广而省）' },
};

// ─── Physical communication planes (三平面) + physical devices ────────────────
// The single logical "NPU 经 UB 全互联" line actually rides THREE distinct PHYSICAL
// planes — the layer the pure logical bus model omitted. Each NPU exposes TWO
// different port groups (UB scale-up vs RDMA scale-out, physically different SerDes
// groups), and the CPU drives a third plane (VPC) via the NIC. The optical segment
// of the scale-up / scale-out planes is carried by LPO (linear-drive, DSP-less)
// modules. This lets "NPU 经 UB 全互联" expand into the real chain
// "NPU 端口 → 铜/LPO → 交换", and separates TP/EP (scale-up) · DP/PP (scale-out) ·
// 南北向 (VPC). Sources: CloudMatrix384 三平面解读 (InfoQ/知乎, 厂商口径 C) ·
// LPO 功耗/时延 (Vitex, C). Figures标"趋势/待核"处为下一代(LPO 800G/UB2.0)推断。
export type PlaneId = 'ub' | 'rdma' | 'vpc';
export interface PlaneSpec {
  id: PlaneId; name: string; short: string; color: string;
  role: string; members: string; devices: string; scope: string; parallel: string;
  confidence: 'A' | 'B' | 'C';
}
export const PLANES: PlaneSpec[] = [
  { id: 'ub', name: `${TOK.ub} 平面 · Scale-up`, short: 'UB·SU', color: '#04d793',
    role: '超节点内全互联（NPU↔NPU↔CPU）', members: `NPU + CPU`,
    devices: `NPU UB 端口 → 铜缆(柜内)/LPO 光模块(柜间) → L1/L2 ${TOK.ub} 交换`,
    scope: '超节点内 SU 域 · ≤128 卡超低延迟 · >2 TB/s·NPU', parallel: 'TP · EP · SP', confidence: 'B' },
  { id: 'rdma', name: 'RDMA 平面 · Scale-out', short: 'RDMA·SO', color: '#ffaa3b',
    role: '跨超节点 / 外部 RDMA（RoCE）', members: '仅 NPU（自带 RoCE 口）',
    devices: 'NPU RDMA 端口(400G/NPU) → LPO 光模块 → scale-out 交换 → 其它超节点',
    scope: '跨超节点 SO 域', parallel: 'DP · PP', confidence: 'B' },
  { id: 'vpc', name: 'VPC 平面', short: 'VPC', color: '#9d7bff',
    role: '接入数据中心（存储 / 前端 / 管理 · 南北向）', members: `CPU + ${TOK.qingtian} NIC`,
    devices: `CPU → ${TOK.qingtian} NIC → 数据中心网络`,
    scope: '南北向 · 非训练关键路径', parallel: '—', confidence: 'B' },
];

// physical devices the planes traverse (这是现模型最该补的器件层)
export interface PhysDevice { id: string; label: string; color: string; plane: PlaneId | 'multi'; note: string; }
export const PHYS_DEVICES: PhysDevice[] = [
  { id: 'npu_ub_port', label: 'NPU UB 端口', color: '#04d793', plane: 'ub',
    note: 'SerDes/LQC 高速口，进 UB 总线 · 单卡 >2 TB/s · scale-up 最高带宽' },
  { id: 'npu_rdma_port', label: 'NPU RDMA 端口', color: '#ffaa3b', plane: 'rdma',
    note: '集成在 NPU 上的 RoCE 口 · 400 Gbps/NPU · 跨超节点（与 UB 口是 NPU 上不同的 SerDes 组）' },
  { id: 'cpu_ub', label: `${TOK.kunpeng} CPU`, color: '#4a8cff', plane: 'multi',
    note: 'UB 平面与 NPU 平等互联(8×30G LQC 统一编址) · host 侧挂 NIC 接 VPC · 调度/预处理/存储' },
  { id: 'lpo', label: 'LPO 光模块', color: '#36e0c4', plane: 'multi',
    note: '线性直驱(去 DSP)：功耗降 35–50%(→7–8.5W)、单跳<3ns · 柜间光链路介质 · scale-up/out 共用' },
  { id: 'nic', label: `${TOK.qingtian} NIC`, color: '#9d7bff', plane: 'vpc',
    note: '负责 VPC 平面（注意：scale-out RDMA 走 NPU 自带 RoCE 口，不走擎天 NIC）· 南北向接入 DC' },
];

// the physical hop-chain per plane — 把"NPU 经 UB 全互联"那根逻辑线展开成物理链
export interface PhysChain { plane: PlaneId; label: string; hops: string[] }
export const PHYS_CHAINS: PhysChain[] = [
  { plane: 'ub', label: 'Scale-up（超节点内）', hops: ['NPU Die', 'UB 端口', '铜缆 / LPO 光模块', `L1→L2 ${TOK.ub} 交换`] },
  { plane: 'rdma', label: 'Scale-out（跨超节点）', hops: ['NPU Die', 'RDMA/RoCE 口 400G', 'LPO 光模块', 'scale-out 交换', '其它超节点'] },
  { plane: 'vpc', label: 'VPC（南北向）', hops: [`${TOK.kunpeng} CPU`, `${TOK.qingtian} NIC`, '数据中心网络'] },
];

// ── PER-LEVEL physical devices & plane (把物理器件挂到每一层级上) ─────────────────
// Mirrors the reference "物理三平面" layer: each hierarchy level carries WHICH physical
// devices live there and WHICH plane it rides. Keyed by the level `kind` used in the
// 层级图 (LAY.levels.kind) and mapped onto the 阵列全景 bands. `color` = plane accent
// (grey = on-chip, no external port). Consumed by PlaneView (层级图) + FullPodScene bands.
export interface LevelPhys { plane: PlaneId | 'none' | 'multi'; planeLabel: string; color: string; devices: string; short: string }
export const LEVEL_PHYS: Record<string, LevelPhys> = {
  cluster: { plane: 'rdma', planeLabel: 'RDMA · Scale-out', color: '#ffaa3b', short: 'RDMA口→其它超节点', devices: `跨超节点 · ${TOK.uboe}/RoCE（NPU RDMA 口）` },
  super:   { plane: 'ub',   planeLabel: 'UB · Scale-up',    color: '#04d793', short: 'UB 交换 · LPO', devices: `L2 ${TOK.ub} 交换 · LPO 光模块(柜间)` },
  cab:     { plane: 'ub',   planeLabel: 'UB · Scale-up',    color: '#04d793', short: '柜内 mesh · 铜/LPO', devices: `柜内 ${TOK.fullmesh} · 铜/LPO 上行` },
  node:    { plane: 'multi', planeLabel: 'UB / RDMA / VPC', color: '#9d7bff', short: 'UB口/RDMA口·CPU·LPO·NIC', devices: 'NPU UB口 + RDMA口 · 鲲鹏 CPU · LPO · 擎天 NIC · L1 交换' },
  card:    { plane: 'multi', planeLabel: 'UB + RDMA',       color: '#04d793', short: 'NPU UB口 + RDMA口', devices: 'NPU 封装：UB 端口(绿·scale-up) + RDMA/RoCE 端口(橙·scale-out)' },
  die:     { plane: 'none',  planeLabel: '片上 · 无对外口',  color: '#7c8db8', short: '片上 · 无对外口', devices: 'D2D 784 GB/s · NoC · HBM' },
  core:    { plane: 'none',  planeLabel: '片上 · 无对外口',  color: '#7c8db8', short: '片上 · 无对外口', devices: 'AIC(Cube)/AIV(Vector) · Global Memory' },
  tile:    { plane: 'none',  planeLabel: '片上 · 无对外口',  color: '#7c8db8', short: '片上 · 无对外口', devices: 'Cube/Vector 单元 · UB/L0 buffer' },
};
// 阵列全景 band index → LEVEL_PHYS key
export const BAND_PHYS_KEY: Record<number, string> = {
  7: 'tile', 0: 'core', 1: 'die', 2: 'card', 3: 'node', 4: 'cab', 5: 'super', 6: 'cluster',
};

// Each hierarchy level carries HARDWARE facts (hw) and the SOFTWARE view (sw)
// SEPARATELY — rank is pure software (a collective-comm logical id) bound to a device,
// never the device itself. Tuned for the 950 (4-Die package · UMA · ≈32 AI Core/card).
export interface LayerInfo { key: string; name: string; intra: string; inter: string; bw: string; domain: string; tag?: string; hw?: string; sw?: string; }
export const LAYER_INFO: LayerInfo[] = [
  { key: 'super', name: `${TOK.supernode}`, intra: `域内全互联 · ${TOK.ubmesh}（SU 窄快 + SO 广省）`, inter: '顶层 · UB Load/Store 内存语义抹平总线/网络边界', bw: 'any-to-any <1 µs · 16 PB/s', domain: 'SU+SO', sw: '集群通信域 / 全局编排' },
  { key: 'cab',   name: '机柜', intra: `柜内 ${TOK.fullmesh}（≤128 卡 SU 超低延迟域）`, inter: '↑ 总线池化 pooling：UB 统一编址 → 超节点“一台计算机”', bw: `柜内 ${TOK.fullmesh} · 1:1 无收敛`, domain: 'SU' },
  { key: 'node',  name: '节点 / 刀片', intra: '8 卡 + CPU 经 LQC 对 L1 全互联、平等编址', inter: '↑ 互联收敛 interconnect：经 L1/L2 上联（单跳 200 ns · 1:1）', bw: 'LQC 8×56G(卡) / 8×30G(CPU)', domain: 'SU' },
  { key: 'card',  name: '卡 / NPU（1 device）', intra: '封装内 4 Die：2 计算 Die（UMA 高带宽直连、OS 视为单设备）+ 2 IO Die', inter: '↑ 坐标绑定 binding：软件 rank → 硬件 device', bw: 'D2D · HBM · 单卡 UB 2016 GB/s', domain: '—', tag: 'device ↔ rank 1:1',
    hw: '硬件：1 张 950 卡 = 1 device = 2 计算 Die（UMA 合并）+ 2 IO Die', sw: `软件：rank = ${TOK.hccl} 逻辑编号（rank 表），与 device 严格 1:1 绑定 · 纯软件、与代际无关` },
  { key: 'die',   name: '计算 Die / 核组（CoreGroup）', intra: '单计算 Die ≈ 16 AI Core，经片上 NoC 互联、共享 HBM', inter: '↑ UMA 合并：2 计算 Die 统一寻址 → 整卡 = 1 device', bw: '片上 NoC · D2D 784 GB/s · HBM 3.2–9.6 TB/s', domain: '—', tag: '设备内（非 rank）',
    hw: '硬件：1 计算 Die ≈ 16 AI Core · 整卡 = 2 计算 Die（UMA）+ 2 IO Die', sw: '软件：rank 内核组（CoreGroup）· 同 rank、不增 rank' },
  { key: 'core',  name: 'AI Core（L1 · AIC/AIV）', intra: 'AIC(Cube)/AIV(Vector) 分离独立核、双发射并行 · 核间 GlobalMem + CrossCoreFlag', inter: '↑ block_idx 核实例（SPMD）：rank 内 TileShape 切到各 AI Core', bw: 'L0A/L0B/L0C · TQue/TPipe 流水', domain: '—', tag: '设备内并行（非 rank）',
    hw: '硬件：约 32 AI Core/卡（16/计算 Die × 2）· AIC(Cube)/AIV(Vector) 分离独立核 · Cube∶Vector ≈ 8∶1', sw: '软件：block_idx 核实例（SPMD）· rank 内不增 rank' },
  { key: 'tile',  name: 'Tile（L0 · Cube/Vector/lane）', intra: '核内 Cube/Vector ALU + 片上 buf（L0A/B/C）+ SIMD/SIMT lane', inter: '↑ TileShape 切分：tile / element 落到 lane', bw: 'L0 buf · 寄存器 · element 级', domain: '—', tag: '设备内（非 rank）',
    hw: '硬件：AI Core 内 Cube/Vector 计算单元 + 片上 buffer + SIMD/SIMT 通道（lane）', sw: '软件：tile / SIMT lane / element（950 SIMD/SIMT 同构双编程的最细粒度）' },
];

// per-card AI Core count on the 950 (≈16 AI Core / compute Die × 2 compute Die)
export const CORES_PER_CARD = 32;

// ─── Process / thread communication overlays (node view) ─────────────────────
export interface CommPattern { id: string; color: string; label: string; }
export const COMM_PATTERNS: CommPattern[] = [
  { id: 'ring',   color: '#ff4b7b', label: 'Ring-AllReduce · 进程(rank)' },
  { id: 'a2a',    color: '#ffaa3b', label: 'All-to-All MoE · 进程(rank)' },
  { id: 'thread', color: '#22d3ee', label: 'die 内线程 / AI Core 流' },
];

// ─── Trace timeline (illustrative training-iteration schedule, NOT a real profile) ─
export type Phase = 'load' | 'compute' | 'comm' | 'store';
export const TRACE_SCHED: Phase[] = ['load', 'compute', 'compute', 'comm', 'compute', 'compute', 'comm', 'store'];
export const PHASE_META: Record<Phase, { name: string; color: string }> = {
  load:    { name: '加载',           color: '#c2c9d4' },
  compute: { name: '计算（算子/Tile）', color: '#22d3ee' },
  comm:    { name: '通信 AllReduce',  color: '#ff4b7b' },
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

// canonical signature colour per parallel dimension (one colour each for none/TP/PP/DP/EP),
// used for the dimension *selector* chips + legends so each dim reads consistently.
export const PARALLEL_COLORS: Record<PartitionDim, string> = {
  none: '#7c8db8', tp: '#4369ef', pp: '#04d793', dp: '#ffaa3b', ep: '#ff4b7b',
};

// ─── ONE canonical colour per entity, shared by ALL three views (top / layered /
// 3-D) so they correspond: same concept → same colour → same glyph language.
// Hardware accent = teal (the die/device domain); software accent = indigo (rank).
// The two are deliberately different hues so hardware and software never blur.
export const ENTITY_COLORS = {
  super:      UB_LEVELS[3].color,      // 超节点 — amber
  cab:        UB_LEVELS[2].color,      // 机柜 — purple
  node:       UB_LEVELS[1].color,      // 节点 / 刀片 — sky blue
  card:       UB_LEVELS[0].color,      // 卡 / NPU device — teal (compute-die domain)
  computeDie: UB_LEVELS[0].color,      // 计算 Die — teal
  ioDie:      '#7c8db8',               // IO Die — accent grey
  cube:       COMM_PATTERNS[2].color,  // AI Core · Cube(AIC) — cyan
  vector:     '#7dd3fc',               // AI Core · Vector(AIV) — light cyan
  rank:       '#4369ef',               // software rank — indigo (distinct from all hardware)
  hw:         UB_LEVELS[0].color,      // generic HARDWARE accent — teal
  sw:         '#4369ef',               // generic SOFTWARE accent — indigo
} as const;

// ─── UB L0–L7：软硬件“同一坐标系”（L0–L7 对齐表）─────────────────────────────────
// L0–L7 是“任务在哪个作用域运行”的递归坐标（4 对作用域：核内 L0–L1 / 芯片 L2–L3 /
// 机器 L4–L5 / 集群 L6–L7），不是 8 个硬件零件。它和我们的物理层不一一对应：① 机柜
// 并入机器域(Pod)，无独立级；② 底部 die/核/tile 5 级压进 L0–L3；③ 把软件(tile)与硬件
// (core)揉进同一根轴。下表把它对齐到本视图的五个层级（含每层软件落点 + 可观测指标）。
export interface UbCoordLevel { L: string; scope: string; sw: string; obs: string; note?: string; }
export const UB_COORD: Record<string, UbCoordLevel> = {
  job:     { L: 'L7', scope: '集群域', sw: 'Job 全局 · 整个训练作业 / 数据中心', obs: '端到端吞吐 · MFU' },
  cluster: { L: 'L6', scope: '集群域', sw: '跨超节点集群 · DP / PP 跨超节点', obs: '集群通信占比 (DP)' },
  super: { L: 'L5', scope: '机器域', sw: 'Pod 部署边界 · TP/EP/SP 域(SU)', obs: 'UB 带宽利用 · EP All-to-All' },
  cab:   { L: 'L4–L5', scope: '机器域', sw: '部署 / 放置边界', obs: '卡间带宽 · host 开销',
           note: `机柜并入机器域 · ${TOK.ub} 坐标无独立级` },
  node:  { L: 'L4', scope: '机器域', sw: '单机多卡放置（Host = 1 CPU + 8 NPU）', obs: '卡间带宽 · host 开销' },
  card:  { L: 'L3', scope: '芯片域', sw: 'Chip = rank 逻辑设备（950 整卡 UMA）', obs: '算力% · HBM% · 负载均衡' },
  die:   { L: 'L2', scope: '芯片域', sw: 'CoreGroup = rank 内核组（Die / NoC）', obs: 'NoC 争用 · D2D · HBM 带宽' },
  core:  { L: 'L1', scope: '核内域', sw: 'Core = block_idx 核实例（SPMD）', obs: 'AIC/AIV 利用率 · 同步等待' },
  tile:  { L: 'L0', scope: '核内域', sw: 'Tile = Cube/Vector + 片上 buf + lane · tile / SIMT lane', obs: '流水气泡 · 访存等待' },
};
// topology-tier (UB 互联层级 L0–L4) → UB L0–L7 coordinate (底部 5 级压进 L0–L3)
export const UB_COORD_TOPO: Record<number, { L: string; scope: string }> = {
  0: { L: 'L0–L3', scope: '核内→芯片域（die/核/tile 压缩）' },
  1: { L: 'L4',    scope: 'Host · 机器域' },
  2: { L: 'L4–L5', scope: '机器域（机柜并入 Pod）' },
  3: { L: 'L5',    scope: 'Pod · 机器域' },
  4: { L: 'L6–L7', scope: 'Cluster / Global · 集群域' },
};

// ─── Live status / flow overlay (full-pod): node activity + link state ────────
// Node colour = current activity (from the run phase); link thickness = bandwidth
// (intra-node L1 fattest → scale-out L4 thinnest) with a flow surge on the active
// collective. Status colour takes priority over the partition colour.
export const STATUS_COLORS: Record<string, string> = {
  compute: '#04d793', comm: '#ff4b7b', mem: '#a78bfa', load: '#60a5fa', store: '#94a3b8', idle: '#9aa6b8',
};
export const STATUS_META: { id: string; label: string }[] = [
  { id: 'compute', label: '计算中' }, { id: 'comm', label: '通信中' }, { id: 'mem', label: '访存' },
  { id: 'load', label: '加载' }, { id: 'store', label: '存储' }, { id: 'idle', label: '空闲' },
];

// ─── Observation palette: ONE load/utilisation heatmap (the high-saturation colours
// we reserve OUT of the hierarchy). 0 空闲 → 1 繁忙 = 绿 → 黄 → 红. Lines & nodes use this
// for STATE; line thickness ∝ load/bandwidth. Hierarchy/type uses only faint neutral hues.
const HEAT_LOW = [0x22, 0xc5, 0x5e], HEAT_MID = [0xf5, 0x9e, 0x0b], HEAT_HOT = [0xef, 0x44, 0x44];   // 绿 / 黄 / 红
const lerp3 = (a: number[], b: number[], t: number) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
export function loadRGB(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const c = x < 0.5 ? lerp3(HEAT_LOW, HEAT_MID, x / 0.5) : lerp3(HEAT_MID, HEAT_HOT, (x - 0.5) / 0.5);
  return [c[0], c[1], c[2]];
}
export function loadColor(t: number): string { const [r, g, b] = loadRGB(t); return `rgb(${r},${g},${b})`; }
// desaturate a hierarchy hue toward its own luminance-grey (keep a FAINT tint so levels are
// still tellable, but they never compete with the state heatmap). amt→1 = fully neutral.
export function mute(hex: string, amt = 0.8): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  return `rgb(${Math.round(r + (y - r) * amt)},${Math.round(g + (y - g) * amt)},${Math.round(b + (y - b) * amt)})`;
}
// deterministic, stable per-id "load" 0..1 (illustrative), modulated by the current run-phase
// kind so playback reads as a live heatmap (compute → cores hot, comm → links hot, idle → cool).
export function nodeLoad(id: number, phaseKind?: string): number {
  let h = (id * 2654435761) >>> 0; h ^= h >>> 13; h = (h * 1274126177) >>> 0;
  const base = (h >>> 8) / 0xffffff;            // 0..1 stable spread
  const lvl = phaseKind === 'compute' ? 0.78 : phaseKind === 'comm' ? 0.42 : phaseKind === 'mem' ? 0.6 : phaseKind === 'load' || phaseKind === 'store' ? 0.5 : 0.22;
  return Math.max(0, Math.min(1, lvl + (base - 0.5) * 0.42));
}

export const RUN_SCHED: Record<RunMode, RunPhase[]> = {
  train: [
    { id: 'load', name: '加载 batch',      kind: 'load',    color: '#c2c9d4', parallel: 'DP',    note: '各 DP 副本读入各自 micro-batch' },
    { id: 'fwd',  name: '前向 Forward',    kind: 'compute', color: '#22d3ee', parallel: 'TP·PP', note: 'TP 层内并行 + PP 流水级逐级前向' },
    { id: 'bwd',  name: '反向 Backward',   kind: 'compute', color: '#0ea5e9', parallel: 'TP·PP', note: '反向传播逐级回传，产生梯度' },
    { id: 'ar',   name: '梯度 AllReduce',  kind: 'comm',    color: '#ff4b7b', collective: 'ring', parallel: 'DP', note: 'DP 副本间环状 AllReduce 同步梯度' },
    { id: 'opt',  name: '优化器更新',      kind: 'store',   color: '#aab4c4', parallel: '—',     note: '更新参数 / 写回（含 store）' },
  ],
  infer: [
    { id: 'pre', name: 'Prefill 预填充',     kind: 'compute', color: '#22d3ee', parallel: 'TP', note: '提示词整段并行前向，KV-Cache 建立' },
    { id: 'a2a', name: 'MoE All-to-All',     kind: 'comm',    color: '#f59e0b', collective: 'a2a', parallel: 'EP', note: '专家并行 token 分发 All-to-All' },
    { id: 'dec', name: 'Decode 解码(逐token)', kind: 'compute', color: '#34d399', parallel: 'TP', note: '自回归逐 token 前向，吞吐 = tok/s' },
    { id: 'kv',  name: 'KV-Cache 读写',      kind: 'mem',     color: '#a78bfa', parallel: '—', note: '每步读写 KV-Cache（显存带宽受限）' },
  ],
};

// ─── Per-card memory hierarchy (single NPU) — illustrative occupancy ──────────
// Bridges the cluster topology down to the on-chip story PTO focuses on: where a
// rank's bytes live and where the bottleneck usually is. `util` is a schematic
// fill ratio (NOT a measured profile), drawn in the PTO 14%-fill / 34%-stroke style.
export interface MemLayer { id: string; name: string; cap: string; util: number; color: string; note: string; }
export function memLayers(gen: GenSpec): MemLayer[] {
  return [
    { id: 'hbm', name: `HBM（${gen.hbm}）`, cap: `${gen.memGB} GB`, util: 0.78, color: '#4369ef', note: '权重 + 激活 + KV-Cache，带宽常为瓶颈' },
    { id: 'l2',  name: 'L2 全局缓存',        cap: gen.l2MB ? `${gen.l2MB} MB` : '—', util: 0.62, color: '#7c8db8', note: 'die 内共享，算子间数据复用' },
    { id: 'ub',  name: 'UB Memory',          cap: '512 KB', util: 0.5, color: '#04d793', note: '统一编址，跨 NPU 池化访问' },
    { id: 'l1',  name: 'L1（片上 SRAM）',    cap: '512 KB', util: 0.7, color: '#ffaa3b', note: 'Tile 驻留，搬运 HBM→L1→L0' },
    { id: 'l0',  name: 'L0A/B/C',            cap: '64–256 KB', util: 0.85, color: '#ff4b7b', note: 'Cube/Vector 计算缓冲，最贴近算力' },
  ];
}

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
      label: `${TOK.ascend} ${TOK.n950dt} #${i + 1}（1 device）· ${DIES_PER_NPU} Die = 2 计算(UMA)+2 IO · UB 2 TB/s · ${TOK.hbmZQ} HBM`,
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

