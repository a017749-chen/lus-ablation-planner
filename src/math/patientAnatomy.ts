import * as THREE from 'three';
import {
  AnatomyContext,
  AnatomyLesion,
  RibCageStatus,
  VascularStructure,
  VesselClearanceResult
} from './anatomyContext';
import { LiverSurfaceSample } from './anatomyShapes';
import { dicomLpsToScene, sceneToDicomLps } from './patientCoordinates';

export const ANATOMY_RLE_SCHEMA = 'liverplan/anatomy-rle-1';
const RLE_ENCODING = 'binary-flat-c-order-runs-v1';

type StructureName = 'liver' | 'tumor' | 'portal_vein' | 'hepatic_vein' | 'ivc' | 'body' | 'ribs';

interface RleStructure {
  encoding: string;
  runs: number[];
  voxels: number;
  mask_sha256?: string;
}

export interface AnatomyRlePayload {
  schema: string;
  anatomy_schema: string;
  coordinate_system: string;
  volume_fingerprint: string;
  reviewed: boolean;
  ct_pixels_included: boolean;
  planning_grid: {
    shape: number[];
    spacing_mm: number;
    origin_lps_mm: number[];
    affine_lps_mm?: number[][];
  };
  structures: Partial<Record<StructureName | 'vessels', RleStructure>>;
  lesions?: Array<{
    id: string;
    ml?: number;
    centroid_lps_mm: number[];
  }>;
  clinical_validated: boolean;
}

interface VesselVoxel {
  point: THREE.Vector3;
  structure: VascularStructure;
  name: string;
}

function finite3(values: unknown, label: string): [number, number, number] {
  if (!Array.isArray(values) || values.length !== 3 || values.some(v => !Number.isFinite(v))) {
    throw new Error(`${label} 必須是 3 個有限數值。`);
  }
  return [Number(values[0]), Number(values[1]), Number(values[2])];
}

function positiveShape(values: unknown): [number, number, number] {
  const v = finite3(values, 'planning_grid.shape');
  if (v.some(x => !Number.isInteger(x) || x <= 0)) throw new Error('planning_grid.shape 無效。');
  return v;
}

/** Sparse binary mask stored as sorted flat C-order runs; no dense 3-D allocation. */
class RleMask {
  readonly runs: Uint32Array;
  readonly voxels: number;
  private readonly runStarts: Uint32Array;

  constructor(
    readonly name: string,
    structure: RleStructure,
    readonly shape: [number, number, number]
  ) {
    if (structure.encoding !== RLE_ENCODING) throw new Error(`${name} RLE encoding 不支援。`);
    if (!Array.isArray(structure.runs) || structure.runs.length % 2 !== 0) {
      throw new Error(`${name} RLE runs 格式錯誤。`);
    }
    const total = shape[0] * shape[1] * shape[2];
    let lastEnd = 0;
    let count = 0;
    const raw = structure.runs.map(Number);
    for (let n = 0; n < raw.length; n += 2) {
      const start = raw[n], length = raw[n + 1];
      if (!Number.isInteger(start) || !Number.isInteger(length) || length <= 0 || start < lastEnd || start + length > total) {
        throw new Error(`${name} RLE run 超出網格或未排序。`);
      }
      lastEnd = start + length;
      count += length;
    }
    if (Number(structure.voxels) !== count) throw new Error(`${name} RLE voxel count 不一致。`);
    this.runs = Uint32Array.from(raw);
    this.voxels = count;
    this.runStarts = new Uint32Array(raw.length / 2);
    for (let i = 0; i < this.runStarts.length; i++) this.runStarts[i] = raw[i * 2];
  }

  containsLinear(index: number): boolean {
    if (!Number.isInteger(index) || index < 0) return false;
    let lo = 0, hi = this.runStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.runs[mid * 2];
      const length = this.runs[mid * 2 + 1];
      if (index < start) hi = mid - 1;
      else if (index >= start + length) lo = mid + 1;
      else return true;
    }
    return false;
  }

  linear(i: number, j: number, k: number): number {
    return (i * this.shape[1] + j) * this.shape[2] + k;
  }

  containsIndex(i: number, j: number, k: number): boolean {
    if (i < 0 || j < 0 || k < 0 || i >= this.shape[0] || j >= this.shape[1] || k >= this.shape[2]) return false;
    return this.containsLinear(this.linear(i, j, k));
  }

  indexFromLinear(index: number): [number, number, number] {
    const yz = this.shape[1] * this.shape[2];
    const i = Math.floor(index / yz);
    const rem = index - i * yz;
    const j = Math.floor(rem / this.shape[2]);
    return [i, j, rem - j * this.shape[2]];
  }

  forEachVoxel(callback: (i: number, j: number, k: number, linear: number) => void): void {
    for (let r = 0; r < this.runs.length; r += 2) {
      const start = this.runs[r], end = start + this.runs[r + 1];
      for (let index = start; index < end; index++) {
        const [i, j, k] = this.indexFromLinear(index);
        callback(i, j, k, index);
      }
    }
  }
}

function pointToSegmentDistance(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const denom = ab.lengthSq();
  if (denom < 1e-12) return point.distanceTo(a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(point, a).dot(ab) / denom, 0, 1);
  return point.distanceTo(a.clone().addScaledVector(ab, t));
}

export class PatientAnatomyContext implements AnatomyContext {
  readonly kind = 'patient' as const;
  readonly label: string;
  readonly clinicalValidated = false as const;
  readonly volumeFingerprint: string;
  readonly shape: [number, number, number];
  readonly spacingMm: number;
  readonly originLps: THREE.Vector3;

  private masks = new Map<string, RleMask>();
  private surfaceCache = new Map<string, THREE.Vector3[]>();
  private liverSurfaceCache = new Map<number, LiverSurfaceSample[]>();
  private vesselBuckets = new Map<string, VesselVoxel[]>();
  private vesselStructures: VascularStructure[] = [];
  private readonly vesselCellMm: number;
  private readonly vesselSearchMm = 36;

  constructor(readonly payload: AnatomyRlePayload) {
    if (payload.schema !== ANATOMY_RLE_SCHEMA) throw new Error('不是 LiverPlan anatomy-rle-1。');
    if (payload.coordinate_system !== 'DICOM-LPS-mm') throw new Error('anatomy coordinate system 必須是 DICOM-LPS-mm。');
    if (payload.reviewed !== true) throw new Error('只接受已人工覆核的 patient-specific anatomy。');
    if (payload.ct_pixels_included !== false) throw new Error('anatomy transport 不應包含 CT pixels。');
    this.shape = positiveShape(payload.planning_grid?.shape);
    this.originLps = new THREE.Vector3(...finite3(payload.planning_grid?.origin_lps_mm, 'planning_grid.origin_lps_mm'));
    this.spacingMm = Number(payload.planning_grid?.spacing_mm);
    if (!Number.isFinite(this.spacingMm) || this.spacingMm <= 0 || this.spacingMm > 10) {
      throw new Error('planning_grid.spacing_mm 無效。');
    }
    this.volumeFingerprint = String(payload.volume_fingerprint || '');
    if (!this.volumeFingerprint) throw new Error('缺少 volume_fingerprint。');
    this.label = `Patient anatomy · ${this.volumeFingerprint.slice(0, 12)}`;

    for (const [name, structure] of Object.entries(payload.structures || {})) {
      if (!structure || name === 'vessels') continue; // never collapse identity in patient mode
      this.masks.set(name, new RleMask(name, structure, this.shape));
    }
    for (const required of ['liver', 'tumor', 'body']) {
      if (!this.masks.get(required)?.voxels) throw new Error(`patient anatomy 缺少非空 ${required} mask。`);
    }
    if (![...['portal_vein', 'hepatic_vein', 'ivc']].some(name => (this.masks.get(name)?.voxels ?? 0) > 0)) {
      throw new Error('patient anatomy 沒有可分辨身份的 PV/HV/IVC mask。');
    }

    this.vesselCellMm = Math.max(6, this.spacingMm * 3);
    this.buildVesselIndex();
  }

  static fromJson(text: string): PatientAnatomyContext {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('patient anatomy JSON 無法解析。'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('patient anatomy JSON 必須是物件。');
    return new PatientAnatomyContext(parsed as AnatomyRlePayload);
  }

  private mask(name: string): RleMask | undefined { return this.masks.get(name); }

  private indexFromLps(lps: THREE.Vector3): [number, number, number] {
    return [
      Math.round((lps.x - this.originLps.x) / this.spacingMm),
      Math.round((lps.y - this.originLps.y) / this.spacingMm),
      Math.round((lps.z - this.originLps.z) / this.spacingMm),
    ];
  }

  private lpsFromIndex(i: number, j: number, k: number): THREE.Vector3 {
    return new THREE.Vector3(
      this.originLps.x + i * this.spacingMm,
      this.originLps.y + j * this.spacingMm,
      this.originLps.z + k * this.spacingMm
    );
  }

  private sceneFromIndex(i: number, j: number, k: number): THREE.Vector3 {
    return dicomLpsToScene(this.lpsFromIndex(i, j, k));
  }

  private containsScene(mask: RleMask | undefined, point: THREE.Vector3): boolean {
    if (!mask) return false;
    const [i, j, k] = this.indexFromLps(sceneToDicomLps(point));
    return mask.containsIndex(i, j, k);
  }

  private outwardNormal(mask: RleMask, point: THREE.Vector3): THREE.Vector3 | null {
    const [i, j, k] = this.indexFromLps(sceneToDicomLps(point));
    const gx = Number(mask.containsIndex(i - 1, j, k)) - Number(mask.containsIndex(i + 1, j, k));
    const gy = Number(mask.containsIndex(i, j - 1, k)) - Number(mask.containsIndex(i, j + 1, k));
    const gz = Number(mask.containsIndex(i, j, k - 1)) - Number(mask.containsIndex(i, j, k + 1));
    const lps = new THREE.Vector3(gx, gy, gz);
    if (lps.lengthSq() < 1e-9) return null;
    return dicomLpsToScene(lps).normalize();
  }

  isInsideLiver(point: THREE.Vector3, marginMm = 0): boolean {
    const liver = this.mask('liver')!;
    const [i, j, k] = this.indexFromLps(sceneToDicomLps(point));
    if (!liver.containsIndex(i, j, k)) return false;
    if (marginMm <= 0) return true;
    const n = Math.ceil(marginMm / this.spacingMm);
    return liver.containsIndex(i - n, j, k) && liver.containsIndex(i + n, j, k) &&
      liver.containsIndex(i, j - n, k) && liver.containsIndex(i, j + n, k) &&
      liver.containsIndex(i, j, k - n) && liver.containsIndex(i, j, k + n);
  }

  liverNormal(point: THREE.Vector3): THREE.Vector3 {
    return this.outwardNormal(this.mask('liver')!, point) ?? new THREE.Vector3(0, 0, 1);
  }

  private boundaryPoints(name: string, spacingMm = 3): THREE.Vector3[] {
    const cacheKey = `${name}:${spacingMm.toFixed(2)}`;
    const cached = this.surfaceCache.get(cacheKey);
    if (cached) return cached;
    const mask = this.mask(name);
    if (!mask) return [];
    const cells = new Set<string>();
    const out: THREE.Vector3[] = [];
    const q = Math.max(spacingMm, this.spacingMm);
    mask.forEachVoxel((i, j, k) => {
      const boundary = !mask.containsIndex(i - 1, j, k) || !mask.containsIndex(i + 1, j, k) ||
        !mask.containsIndex(i, j - 1, k) || !mask.containsIndex(i, j + 1, k) ||
        !mask.containsIndex(i, j, k - 1) || !mask.containsIndex(i, j, k + 1);
      if (!boundary) return;
      const p = this.sceneFromIndex(i, j, k);
      const key = `${Math.round(p.x / q)},${Math.round(p.y / q)},${Math.round(p.z / q)}`;
      if (cells.has(key)) return;
      cells.add(key);
      out.push(p);
    });
    this.surfaceCache.set(cacheKey, out);
    return out;
  }

  /** Exposed for display only; planning calls the mask-backed context methods. */
  displaySurfacePoints(name: StructureName, spacingMm = 3): THREE.Vector3[] {
    return this.boundaryPoints(name, spacingMm).map(p => p.clone());
  }

  liverSurface(spacingMm = 2.5): LiverSurfaceSample[] {
    const key = Math.max(spacingMm, this.spacingMm);
    const cached = this.liverSurfaceCache.get(key);
    if (cached) return cached;
    const samples = this.boundaryPoints('liver', key).map(point => ({
      point,
      normal: this.liverNormal(point)
    }));
    this.liverSurfaceCache.set(key, samples);
    return samples;
  }

  segmentCrossesLiver(a: THREE.Vector3, b: THREE.Vector3, steps = 24, endClearanceMm = 2): boolean {
    const length = a.distanceTo(b);
    if (length < 1e-6) return false;
    const n = Math.max(steps, Math.ceil(length / Math.max(0.75, this.spacingMm * 0.45)));
    const p = new THREE.Vector3();
    for (let i = 1; i < n; i++) {
      const s = i / n;
      if (Math.min(s, 1 - s) * length < endClearanceMm) continue;
      p.lerpVectors(a, b, s);
      if (this.isInsideLiver(p, this.spacingMm * 0.2)) return true;
    }
    return false;
  }

  isUnderSkin(point: THREE.Vector3): boolean { return this.containsScene(this.mask('body'), point); }

  raySkinIntersection(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Vector3 | null {
    const d = direction.clone().normalize();
    if (d.lengthSq() < 1e-12) return null;
    const extents = this.shape.map(n => (n - 1) * this.spacingMm);
    const maxDistance = Math.hypot(extents[0], extents[1], extents[2]) * 1.25;
    const step = Math.max(0.75, this.spacingMm * 0.5);
    let previous = origin.clone();
    let wasInside = this.isUnderSkin(previous);
    let entered = wasInside;
    for (let t = step; t <= maxDistance; t += step) {
      const current = origin.clone().addScaledVector(d, t);
      const inside = this.isUnderSkin(current);
      if (!entered && inside) entered = true;
      if (entered && wasInside && !inside) {
        let lo = previous.clone(), hi = current.clone();
        for (let n = 0; n < 10; n++) {
          const mid = lo.clone().add(hi).multiplyScalar(0.5);
          if (this.isUnderSkin(mid)) lo = mid; else hi = mid;
        }
        return lo.add(hi).multiplyScalar(0.5);
      }
      previous = current;
      wasInside = inside;
    }
    return null;
  }

  skinNormal(point: THREE.Vector3): THREE.Vector3 | null {
    return this.outwardNormal(this.mask('body')!, point);
  }

  ribCageStatus(point: THREE.Vector3): RibCageStatus {
    const ribs = this.mask('ribs');
    if (!ribs?.voxels) return 'not-evaluable';
    const lps = sceneToDicomLps(point);
    const [i, j, k] = this.indexFromLps(lps);
    const n = Math.ceil(8 / this.spacingMm);
    for (let di = -n; di <= n; di++) for (let dj = -n; dj <= n; dj++) for (let dk = -n; dk <= n; dk++) {
      if ((di * di + dj * dj + dk * dk) * this.spacingMm * this.spacingMm > 64) continue;
      if (ribs.containsIndex(i + di, j + dj, k + dk)) return 'over';
    }
    return 'clear';
  }

  private vesselKey(point: THREE.Vector3): string {
    return `${Math.floor(point.x / this.vesselCellMm)},${Math.floor(point.y / this.vesselCellMm)},${Math.floor(point.z / this.vesselCellMm)}`;
  }

  private buildVesselIndex(): void {
    const names: Array<[StructureName, VascularStructure, string]> = [
      ['portal_vein', 'portal_vein', 'Portal vein'],
      ['hepatic_vein', 'hepatic_vein', 'Hepatic vein'],
      ['ivc', 'ivc', 'IVC'],
    ];
    for (const [maskName, structure, label] of names) {
      const mask = this.mask(maskName);
      if (!mask?.voxels) continue;
      this.vesselStructures.push(structure);
      mask.forEachVoxel((i, j, k) => {
        const point = this.sceneFromIndex(i, j, k);
        const key = this.vesselKey(point);
        const bucket = this.vesselBuckets.get(key) ?? [];
        bucket.push({ point, structure, name: label });
        this.vesselBuckets.set(key, bucket);
      });
    }
  }

  vesselClearance(start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm = 0.8): VesselClearanceResult {
    const margin = this.vesselSearchMm;
    const cell = this.vesselCellMm;
    const min = new THREE.Vector3(
      Math.min(start.x, end.x) - margin,
      Math.min(start.y, end.y) - margin,
      Math.min(start.z, end.z) - margin
    );
    const max = new THREE.Vector3(
      Math.max(start.x, end.x) + margin,
      Math.max(start.y, end.y) + margin,
      Math.max(start.z, end.z) + margin
    );
    const lo = [Math.floor(min.x / cell), Math.floor(min.y / cell), Math.floor(min.z / cell)];
    const hi = [Math.floor(max.x / cell), Math.floor(max.y / cell), Math.floor(max.z / cell)];
    let bestCenter = Infinity;
    let closest: VesselVoxel | null = null;
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const bucket = this.vesselBuckets.get(`${x},${y},${z}`);
      if (!bucket) continue;
      for (const voxel of bucket) {
        const d = pointToSegmentDistance(voxel.point, start, end);
        if (d < bestCenter) { bestCenter = d; closest = voxel; }
      }
    }
    // A vessel voxel is a cube, not a point. Subtracting half the voxel diagonal and
    // the shaft radius gives a conservative lower bound on surface clearance.
    const voxelRadius = Math.sqrt(3) * this.spacingMm * 0.5;
    const centerBound = Math.min(bestCenter, margin);
    const lower = Math.max(0, centerBound - voxelRadius - needleRadiusMm);
    return {
      minimumLowerBoundMm: Number(lower.toFixed(2)),
      closestStructure: closest?.structure ?? 'none',
      closestName: closest?.name ?? 'No segmented vessel within indexed search envelope',
      warningThresholdMm: 5,
      segmentedStructures: [...this.vesselStructures],
      exactNearestWithinIndexedGeometry: bestCenter < margin,
      clinicalSafetyEstablished: false,
    };
  }

  lesions(): AnatomyLesion[] {
    return (this.payload.lesions || []).map(lesion => ({
      id: String(lesion.id),
      centroid: dicomLpsToScene(new THREE.Vector3(...finite3(lesion.centroid_lps_mm, `${lesion.id}.centroid_lps_mm`))),
      volumeMl: lesion.ml === undefined ? undefined : Number(lesion.ml),
    }));
  }
}
