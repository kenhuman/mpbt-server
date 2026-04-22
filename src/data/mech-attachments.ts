import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export type CombatAttachmentHitSection = {
  armorIndex: number;
  internalIndex: number;
  label: string;
};

export type CombatAttachmentImpactContext = {
  impactX: number;
  impactY: number;
  impactZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  facingAccumulator: number;
};

type ModelIndexEntry = {
  modelId: number;
  offset: number;
};

type ParsedRecordPrefix = {
  attachId: number;
  f2: number;
  vertexCount: number;
  polyCount: number;
  linkCount: number;
  vertices: number[][];
  afterPolys: number;
};

type AttachmentRecord = {
  modelId: number;
  attachId: number;
  f2: number;
  center: [number, number, number];
  span: [number, number, number];
};

type AttachmentStats = {
  count: number;
  meanCenter: [number, number, number];
  meanSpan: [number, number, number];
};

type LoadedAttachmentStats = {
  byModel: Map<number, Map<number, AttachmentStats>>;
  global: Map<number, AttachmentStats>;
};

const MODEL_SUBTYPE_BY_MECH_ID = [
  0, 0, 1, 2, 2, 2, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 9, 10, 10, 11, 11, 12, 12, 13,
  13, 14, 15, 16, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 24, 25, 25, 26, 26, 26, 27, 27, 28, 28, 28, 29, 30,
  30, 30, 30, 30, 30, 31, 31, 31, 32, 33, 33, 33, 34, 35, 35, 35, 35, 36, 37, 37, 37, 38, 38, 39, 39, 39, 39, 40, 40, 41, 41, 42,
  42, 42, 43, 43, 43, 44, 44, 44, 44, 44, 44, 45, 45, 46, 46, 46, 47, 47, 47, 47, 48, 49, 49, 49, 49, 50, 50, 50, 50, 51, 51, 51,
  52, 52, 52, 52, 53, 53, 54, 55, 55, 55, 55, 55, 56, 56, 57, 57, 58, 59, 59, 59, 59, 60, 60, 60, 61, 61, 61, 61, 62, 63, 63, 64, 65,
] as const;

const MODEL_ID_BY_SUBTYPE = [
  13, 13, 13, 9, 9, 9, 13, 13, 9, 9, 13, 9, 9, 13, 9, 9, 13, 9, 9, 13, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28, 30, 28,
  28, 30, 28, 28, 28, 51, 51, 30, 51, 43, 51, 51, 51, 61, 61, 51, 43, 51, 51, 61, 61, 61, 51, 61, 61, 59, 61, 61, 59, 61, 61, 59,
] as const;

const CT_FRONT: CombatAttachmentHitSection = { armorIndex: 4, internalIndex: 4, label: 'ct-front' };
const CT_REAR: CombatAttachmentHitSection = { armorIndex: 7, internalIndex: 4, label: 'ct-rear' };
const LT_FRONT: CombatAttachmentHitSection = { armorIndex: 5, internalIndex: 2, label: 'lt-front' };
const LT_REAR: CombatAttachmentHitSection = { armorIndex: 8, internalIndex: 2, label: 'lt-rear' };
const RT_FRONT: CombatAttachmentHitSection = { armorIndex: 6, internalIndex: 3, label: 'rt-front' };
const RT_REAR: CombatAttachmentHitSection = { armorIndex: 9, internalIndex: 3, label: 'rt-rear' };
const HEAD: CombatAttachmentHitSection = { armorIndex: -1, internalIndex: 7, label: 'head' };
const LEFT_ARM: CombatAttachmentHitSection = { armorIndex: 0, internalIndex: 0, label: 'left-arm' };
const RIGHT_ARM: CombatAttachmentHitSection = { armorIndex: 1, internalIndex: 1, label: 'right-arm' };
const LEFT_LEG: CombatAttachmentHitSection = { armorIndex: 2, internalIndex: 5, label: 'left-leg' };
const RIGHT_LEG: CombatAttachmentHitSection = { armorIndex: 3, internalIndex: 6, label: 'right-leg' };

type Vec3 = readonly [number, number, number];
type RootSplitReferences = {
  leftRear: Vec3;
  leftFront: Vec3;
  rightRear: Vec3;
  rightFront: Vec3;
};

const ROOT_FACING_OFFSET = 0x7ff8;
const ANGLE_UNITS_PER_TURN = 0x10000;
const ROOT_SPLIT_SHARED_REFS: RootSplitReferences = {
  leftRear:  [0, -33, -39],
  leftFront: [0, -6, -86],
  rightRear: [0, 33, -37],
  rightFront:[0, 5, -87],
};
const ROOT_SPLIT_REFS_BY_MODEL = new Map<number, Partial<RootSplitReferences>>([
  [9, {
    leftRear:   [0, -33, -39],
    leftFront:  [0, -6, -86],
    rightRear:  [0, 33, -37],
    rightFront: [0, 5, -87],
  }],
  [13, {
    leftRear:   [0, 0, 0],
    leftFront:  [21, -24, -8],
    rightRear:  [0, 24, -1],
    rightFront: [21, 24, -8],
  }],
  [28, {
    leftRear:   [0, 83, -60],
    leftFront:  [-13, -15, -119],
    rightRear:  [0, -84, -61],
    rightFront: [0, 14, -100],
  }],
  [30, {
    leftRear:   [0, -57, -43],
    leftFront:  [-12, 0, -127],
    rightFront: [-11, 0, -130],
  }],
  [43, {
    leftRear:  [0, 0, 0],
    leftFront: [0, 0, 0],
  }],
  [51, {
    leftRear:   [0, -120, -71],
    leftFront:  [-198, 0, 1],
    rightFront: [-200.5, 0, -0.5],
  }],
  [59, {
    leftRear: [0, 0, 0],
  }],
  [61, {
    leftRear:   [-7, 50, -112],
    leftFront:  [-321, 2, -73],
    rightRear:  [3, -49, -128],
    rightFront: [-3, 0, -163],
  }],
]);

const SHARED_SECTION_BY_ATTACH = new Map<number, CombatAttachmentHitSection>([
  [37, HEAD],
  [1, CT_FRONT],
  [32, RT_FRONT],
  [36, CT_REAR],
  [18, LT_REAR],
  [19, LT_FRONT],
  [4, RT_REAR],
  [5, RT_FRONT],
  [52, LEFT_ARM],
  [54, LEFT_ARM],
  [55, LEFT_ARM],
  [38, RIGHT_ARM],
  [40, RIGHT_ARM],
  [41, RIGHT_ARM],
  [31, CT_FRONT],
  [33, LT_FRONT],
  [34, RIGHT_LEG],
  [35, RIGHT_LEG],
]);

const SECTION_BY_MODEL_AND_ATTACH = new Map<number, Map<number, CombatAttachmentHitSection>>([
  [13, new Map<number, CombatAttachmentHitSection>([
    [52, LEFT_LEG],
    [54, LEFT_LEG],
    [38, RIGHT_LEG],
    [40, RIGHT_LEG],
  ])],
  [43, new Map<number, CombatAttachmentHitSection>([
    [43, LEFT_ARM],
    [44, LEFT_ARM],
    [57, LEFT_ARM],
    [58, LEFT_ARM],
    [42, RIGHT_ARM],
    [56, RIGHT_ARM],
  ])],
]);

let cachedAttachmentStats: LoadedAttachmentStats | null = null;

function projectPath(...parts: string[]): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../', ...parts);
}

function readModelIndex(buf: Buffer): ModelIndexEntry[] {
  if (buf.length < 4) return [];
  let off = 0;
  const fileType = buf.readInt16LE(off); off += 2;
  const count = buf.readInt16LE(off); off += 2;
  if (fileType !== 0x10 || count <= 0) return [];

  const entries: ModelIndexEntry[] = [];
  for (let i = 0; i < count && off + 8 <= buf.length; i += 1) {
    const modelId = buf.readInt32LE(off); off += 4;
    const offset = buf.readInt32LE(off); off += 4;
    entries.push({ modelId, offset });
  }
  return entries;
}

function parseRecordPrefix(buf: Buffer, pos: number): ParsedRecordPrefix | null {
  if (pos + 10 > buf.length) return null;

  const attachId = buf.readInt16LE(pos);
  const f2 = buf.readInt16LE(pos + 2);
  const vertexCount = buf.readInt16LE(pos + 4);
  const polyCount = buf.readInt16LE(pos + 6);
  const linkCount = buf.readInt16LE(pos + 8);
  if (vertexCount < 0 || vertexCount > 300) return null;
  if (polyCount < 0 || polyCount > 300) return null;
  if (linkCount < -1 || linkCount > 64) return null;
  if (f2 < -20 || f2 > 300) return null;

  let off = pos + 10;
  const vertices: number[][] = [];
  const vertexRecordSize = 0x18;
  for (let i = 0; i < vertexCount; i += 1) {
    // Each vertex record occupies 0x18 bytes; only the first 12 bytes are
    // currently interpreted here as x/y/z coordinates.
    if (off + vertexRecordSize > buf.length) return null;
    vertices.push([
      buf.readInt32LE(off),
      buf.readInt32LE(off + 4),
      buf.readInt32LE(off + 8),
    ]);
    off += vertexRecordSize;
  }

  for (let i = 0; i < polyCount; i += 1) {
    if (off + 2 > buf.length) return null;
    const pointCount = buf.readInt16LE(off);
    if (pointCount < 0 || pointCount > 200) return null;
    off += 2 + pointCount * 2;
    if (off + 1 + 4 + 12 + 12 + 4 > buf.length) return null;
    off += 1 + 4 + 12 + 12;
    const u29 = buf.readUInt32LE(off);
    off += 4;
    if (((u29 >> 8) & 4) !== 0) {
      off += 4;
      if (off > buf.length) return null;
    }
  }

  return { attachId, f2, vertexCount, polyCount, linkCount, vertices, afterPolys: off };
}

function solveRecordPath(
  buf: Buffer,
  expectedAttachIds: number[],
  pos: number,
  end: number,
  index: number,
  memo: Map<string, ParsedRecordPrefix[] | null>,
): ParsedRecordPrefix[] | null {
  const key = `${index}:${pos}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const prefix = parseRecordPrefix(buf, pos);
  if (prefix === null || prefix.attachId !== expectedAttachIds[index]) {
    memo.set(key, null);
    return null;
  }

  if (index === expectedAttachIds.length - 1) {
    memo.set(key, [prefix]);
    return [prefix];
  }

  const nextAttachId = expectedAttachIds[index + 1];
  const searchEnd = Math.min(end - 10, prefix.afterPolys + 2048);
  for (let candidate = prefix.afterPolys; candidate <= searchEnd; candidate += 1) {
    if (buf.readInt16LE(candidate) !== nextAttachId) continue;
    const remainder = solveRecordPath(buf, expectedAttachIds, candidate, end, index + 1, memo);
    if (remainder !== null) {
      const result = [prefix, ...remainder];
      memo.set(key, result);
      return result;
    }
  }

  memo.set(key, null);
  return null;
}

function parseModelRecords(buf: Buffer, entry: ModelIndexEntry, end: number): AttachmentRecord[] {
  if (entry.offset + 4 + 2 > buf.length) return [];
  let off = entry.offset + 4;
  const recordCount = buf.readInt16LE(off); off += 2;
  if (recordCount <= 0 || recordCount > 32 || off + 32 + 32 + 0x400 + 4 > buf.length) {
    return [];
  }

  const expectedAttachIds = [...buf.slice(off, off + 32)].slice(0, recordCount);
  off += 32 + 32 + 0x400 + 4;

  const path = solveRecordPath(buf, expectedAttachIds, off, end, 0, new Map());
  if (path === null) return [];

  const records: AttachmentRecord[] = [];
  for (const prefix of path) {
    if (prefix.vertices.length === 0) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const vertex of prefix.vertices) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], vertex[axis] ?? 0);
        max[axis] = Math.max(max[axis], vertex[axis] ?? 0);
      }
    }
    records.push({
      modelId: entry.modelId,
      attachId: prefix.attachId,
      f2: prefix.f2,
      center: [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ],
      span: [
        max[0] - min[0],
        max[1] - min[1],
        max[2] - min[2],
      ],
    });
  }
  return records;
}

function updateAttachmentStats(
  stats: Map<number, AttachmentStats>,
  record: AttachmentRecord,
): void {
  const current = stats.get(record.attachId);
  if (current === undefined) {
    stats.set(record.attachId, {
      count: 1,
      meanCenter: [...record.center] as [number, number, number],
      meanSpan: [...record.span] as [number, number, number],
    });
    return;
  }

  const nextCount = current.count + 1;
  for (let axis = 0; axis < 3; axis += 1) {
    current.meanCenter[axis] =
      ((current.meanCenter[axis] * current.count) + record.center[axis]) / nextCount;
    current.meanSpan[axis] =
      ((current.meanSpan[axis] * current.count) + record.span[axis]) / nextCount;
  }
  current.count = nextCount;
}

function mirrorAcrossLateral(point: Vec3): Vec3 {
  return [point[0], -point[1], point[2]];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ];
}

function getRootSplitReferences(modelId: number | undefined): RootSplitReferences {
  const partial = modelId === undefined ? undefined : ROOT_SPLIT_REFS_BY_MODEL.get(modelId);
  const leftRear = partial?.leftRear
    ?? (partial?.rightRear !== undefined
      ? mirrorAcrossLateral(partial.rightRear)
      : ROOT_SPLIT_SHARED_REFS.leftRear);
  const leftFront = partial?.leftFront
    ?? (partial?.rightFront !== undefined
      ? mirrorAcrossLateral(partial.rightFront)
      : ROOT_SPLIT_SHARED_REFS.leftFront);
  const rightRear = partial?.rightRear
    ?? (partial?.leftRear !== undefined
      ? mirrorAcrossLateral(partial.leftRear)
      : ROOT_SPLIT_SHARED_REFS.rightRear);
  const rightFront = partial?.rightFront
    ?? (partial?.leftFront !== undefined
      ? mirrorAcrossLateral(partial.leftFront)
      : ROOT_SPLIT_SHARED_REFS.rightFront);
  return { leftRear, leftFront, rightRear, rightFront };
}

function rotateLocalPointToWorld(
  point: Vec3,
  context: CombatAttachmentImpactContext,
): Vec3 {
  const angleRaw = (context.facingAccumulator + ROOT_FACING_OFFSET) & 0xffff;
  const radians = angleRaw * (Math.PI * 2 / ANGLE_UNITS_PER_TURN);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    context.targetX + (point[0] * cos) - (point[1] * sin),
    context.targetY + (point[0] * sin) + (point[1] * cos),
    context.targetZ + point[2],
  ];
}

export function projectCombatImpactToTargetLocalSpace(
  context: CombatAttachmentImpactContext,
): { forward: number; lateral: number; vertical: number } {
  const angleRaw = (context.facingAccumulator + ROOT_FACING_OFFSET) & 0xffff;
  const radians = angleRaw * (Math.PI * 2 / ANGLE_UNITS_PER_TURN);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = context.impactX - context.targetX;
  const dy = context.impactY - context.targetY;
  return {
    forward: (dx * cos) + (dy * sin),
    lateral: (-dx * sin) + (dy * cos),
    vertical: context.impactZ - context.targetZ,
  };
}

function squaredDistance3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function resolveRootAttachmentHitSection(
  modelId: number | undefined,
  attach: number,
  context: CombatAttachmentImpactContext | undefined,
): CombatAttachmentHitSection | undefined {
  if (context === undefined) return undefined;
  if (attach !== 31 && attach !== 32 && attach !== 33) return undefined;

  const refs = getRootSplitReferences(modelId);
  let rearRef: Vec3;
  let frontRef: Vec3;
  let rearSection: CombatAttachmentHitSection;
  let frontSection: CombatAttachmentHitSection;

  switch (attach) {
    case 33:
      rearRef = refs.leftRear;
      frontRef = refs.leftFront;
      rearSection = LT_REAR;
      frontSection = LT_FRONT;
      break;
    case 32:
      rearRef = refs.rightRear;
      frontRef = refs.rightFront;
      rearSection = RT_REAR;
      frontSection = RT_FRONT;
      break;
    case 31:
      rearRef = midpoint(refs.leftRear, refs.rightRear);
      frontRef = midpoint(refs.leftFront, refs.rightFront);
      rearSection = CT_REAR;
      frontSection = CT_FRONT;
      break;
    default:
      return undefined;
  }

  const impactPoint: Vec3 = [context.impactX, context.impactY, context.impactZ];
  const worldRear = rotateLocalPointToWorld(rearRef, context);
  const worldFront = rotateLocalPointToWorld(frontRef, context);
  return squaredDistance3(impactPoint, worldFront) <= squaredDistance3(impactPoint, worldRear)
    ? frontSection
    : rearSection;
}

function loadAttachmentStats(): LoadedAttachmentStats {
  if (cachedAttachmentStats !== null) return cachedAttachmentStats;

  const byModel = new Map<number, Map<number, AttachmentStats>>();
  const global = new Map<number, AttachmentStats>();
  try {
    const buf = fs.readFileSync(projectPath('3dobj.bin'));
    const entries = readModelIndex(buf);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const end = i + 1 < entries.length ? entries[i + 1]?.offset ?? buf.length : buf.length;
      const records = parseModelRecords(buf, entry, end);
      for (const record of records) {
        const modelStats = byModel.get(record.modelId) ?? new Map<number, AttachmentStats>();
        updateAttachmentStats(modelStats, record);
        byModel.set(record.modelId, modelStats);
        updateAttachmentStats(global, record);
      }
    }
  } catch {
    // The explicit attachment table below remains usable even when assets are absent.
  }

  cachedAttachmentStats = { byModel, global };
  return cachedAttachmentStats;
}

function classifyUnknownAttachment(modelId: number | undefined, attach: number): CombatAttachmentHitSection {
  const loadedStats = loadAttachmentStats();
  const modelStats = modelId === undefined ? undefined : loadedStats.byModel.get(modelId);
  const stats = modelStats?.get(attach) ?? loadedStats.global.get(attach);
  if (stats !== undefined) {
    const vertical = stats.meanCenter[0];
    const lateral = stats.meanCenter[1];
    const depthSpan = stats.meanSpan[2];
    if (vertical > 55 && Math.abs(lateral) <= 18 && depthSpan < 220) {
      return HEAD;
    }
    if (vertical < -40 || depthSpan > 250) {
      return lateral <= 0
        ? { armorIndex: 2, internalIndex: 5, label: 'left-leg' }
        : { armorIndex: 3, internalIndex: 6, label: 'right-leg' };
    }
    if (Math.abs(lateral) > 40) {
      return lateral < 0
        ? { armorIndex: 0, internalIndex: 0, label: 'left-arm' }
        : { armorIndex: 1, internalIndex: 1, label: 'right-arm' };
    }
    if (Math.abs(lateral) > 15) {
      return lateral < 0
        ? { armorIndex: 5, internalIndex: 2, label: 'lt-front' }
        : { armorIndex: 6, internalIndex: 3, label: 'rt-front' };
    }
  }
  return { armorIndex: 4, internalIndex: 4, label: 'ct-front-fallback' };
}

function sectionsMatch(a: CombatAttachmentHitSection, b: CombatAttachmentHitSection): boolean {
  return a.armorIndex === b.armorIndex && a.internalIndex === b.internalIndex;
}

export function getCombatModelIdForMechId(mechId: number | undefined): number | undefined {
  if (mechId === undefined || mechId < 0 || mechId >= MODEL_SUBTYPE_BY_MECH_ID.length) {
    return undefined;
  }
  const subtype = MODEL_SUBTYPE_BY_MECH_ID[mechId];
  if (subtype === undefined || subtype < 0 || subtype >= MODEL_ID_BY_SUBTYPE.length) {
    return undefined;
  }
  return MODEL_ID_BY_SUBTYPE[subtype];
}

export function resolveCombatAttachmentHitSection(
  mechId: number | undefined,
  attach: number,
  impactZ: number,
  impactContext?: CombatAttachmentImpactContext,
): CombatAttachmentHitSection {
  const modelId = getCombatModelIdForMechId(mechId);
  const rootSplit = resolveRootAttachmentHitSection(modelId, attach, impactContext);
  if (rootSplit !== undefined) return rootSplit;
  const explicit = SECTION_BY_MODEL_AND_ATTACH.get(modelId ?? -1)?.get(attach)
    ?? SHARED_SECTION_BY_ATTACH.get(attach);
  if (explicit !== undefined) return explicit;
  const classified = classifyUnknownAttachment(modelId, attach);
  if (classified.label !== 'ct-front-fallback') return classified;
  if (impactZ > 1100) return HEAD;
  if (impactZ > 600) return { armorIndex: 4, internalIndex: 4, label: 'ct-front' };
  return classified;
}

export function findRepresentativeCombatAttachmentIdForSection(
  mechId: number | undefined,
  targetSection: CombatAttachmentHitSection,
): number | undefined {
  if (targetSection.internalIndex === 7) {
    return 37;
  }
  if (targetSection.internalIndex === 4) {
    return 31;
  }
  if (targetSection.internalIndex === 2) {
    return 33;
  }
  if (targetSection.internalIndex === 3) {
    return 32;
  }

  const modelId = getCombatModelIdForMechId(mechId);
  const explicitEntries = [...(SECTION_BY_MODEL_AND_ATTACH.get(modelId ?? -1)?.entries() ?? [])]
    .sort(([attachA], [attachB]) => attachA - attachB);
  for (const [attachId, section] of explicitEntries) {
    if (sectionsMatch(section, targetSection)) {
      return attachId;
    }
  }

  const sharedEntries = [...SHARED_SECTION_BY_ATTACH.entries()]
    .sort(([attachA], [attachB]) => attachA - attachB);
  for (const [attachId, section] of sharedEntries) {
    if (sectionsMatch(section, targetSection)) {
      return attachId;
    }
  }

  const modelStats = modelId === undefined ? undefined : loadAttachmentStats().byModel.get(modelId);
  if (modelStats) {
    const candidateAttaches = [...modelStats.keys()].sort((a, b) => a - b);
    for (const attachId of candidateAttaches) {
      if (attachId === 31 || attachId === 32 || attachId === 33) continue;
      const resolved = resolveCombatAttachmentHitSection(mechId, attachId, 0);
      if (sectionsMatch(resolved, targetSection)) {
        return attachId;
      }
    }
  }

  return undefined;
}
