import * as THREE from 'three';
import { PatientAnatomyContext } from './patientAnatomy';
import { RibCageStatus, RibPathStatus } from './anatomyContext';
import { sceneToDicomLps } from './patientCoordinates';

declare module './patientAnatomy' {
  interface PatientAnatomyContext {
    ribProjectionStatus(x: number, y: number): RibCageStatus;
    ribPathStatus(start: THREE.Vector3, end: THREE.Vector3, radiusMm?: number): RibPathStatus;
  }
}

interface RibIndex {
  projectionCells: Set<string>;
  runs: Uint32Array;
  evaluable: boolean;
}

const cache = new WeakMap<PatientAnatomyContext, RibIndex>();

function buildIndex(context: PatientAnatomyContext): RibIndex {
  const structure = context.payload.structures.ribs;
  if (!structure || structure.voxels <= 0 || !Array.isArray(structure.runs)) {
    return { projectionCells: new Set(), runs: new Uint32Array(), evaluable: false };
  }

  const projectionCells = new Set<string>();
  const [, ny, nz] = context.shape;
  const yz = ny * nz;
  const runs = Uint32Array.from(structure.runs.map(Number));
  for (let r = 0; r < runs.length; r += 2) {
    const start = runs[r];
    const length = runs[r + 1];
    for (let linear = start; linear < start + length; linear++) {
      const i = Math.floor(linear / yz);
      const rem = linear - i * yz;
      const k = rem % nz;
      projectionCells.add(`${i},${k}`);
    }
  }
  return { projectionCells, runs, evaluable: projectionCells.size > 0 };
}

function indexFor(context: PatientAnatomyContext): RibIndex {
  let value = cache.get(context);
  if (!value) {
    value = buildIndex(context);
    cache.set(context, value);
  }
  return value;
}

function containsLinear(index: RibIndex, linear: number): boolean {
  let lo = 0, hi = index.runs.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = index.runs[mid * 2];
    const length = index.runs[mid * 2 + 1];
    if (linear < start) hi = mid - 1;
    else if (linear >= start + length) lo = mid + 1;
    else return true;
  }
  return false;
}

function ribAtIndex(context: PatientAnatomyContext, index: RibIndex, i: number, j: number, k: number): boolean {
  const [nx, ny, nz] = context.shape;
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
  return containsLinear(index, (i * ny + j) * nz + k);
}

PatientAnatomyContext.prototype.ribProjectionStatus = function(
  x: number,
  y: number
): RibCageStatus {
  if (![x, y].every(Number.isFinite)) return 'not-evaluable';
  const index = indexFor(this);
  if (!index.evaluable) return 'not-evaluable';

  const s = this.spacingMm;
  const i0 = Math.round((x - this.originLps.x) / s);
  const k0 = Math.round((y - this.originLps.z) / s);
  const tolerance = Math.SQRT2 * s * 0.5 + 1e-9;
  for (let di = -1; di <= 1; di++) {
    for (let dk = -1; dk <= 1; dk++) {
      const i = i0 + di;
      const k = k0 + dk;
      if (!index.projectionCells.has(`${i},${k}`)) continue;
      const cx = this.originLps.x + i * s;
      const cy = this.originLps.z + k * s;
      if (Math.hypot(x - cx, y - cy) <= tolerance) return 'over';
    }
  }
  return 'clear';
};

/**
 * Conservative straight-path overlap with the reviewed patient rib mask.
 *
 * Samples the path at <=0.45 voxel spacing and checks neighbouring rib voxels within
 * instrument radius plus half the voxel diagonal. The added half-diagonal accounts
 * for treating each occupied voxel as a cube rather than a point; it is not a
 * physiologic or clinical safety margin.
 */
PatientAnatomyContext.prototype.ribPathStatus = function(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radiusMm = 0
): RibPathStatus {
  const index = indexFor(this);
  if (!index.evaluable) return 'not-evaluable';
  if (!Number.isFinite(radiusMm) || radiusMm < 0 || radiusMm > 50) return 'not-evaluable';

  const length = start.distanceTo(end);
  if (length < 1e-9) return 'clear';
  const s = this.spacingMm;
  const voxelRadius = Math.sqrt(3) * s * 0.5;
  const threshold = radiusMm + voxelRadius;
  const neighbourhood = Math.max(1, Math.ceil(threshold / s));
  const samples = Math.max(2, Math.ceil(length / Math.max(0.5, s * 0.45)));
  const p = new THREE.Vector3();

  for (let n = 0; n <= samples; n++) {
    p.lerpVectors(start, end, n / samples);
    const lps = sceneToDicomLps(p);
    const i0 = Math.round((lps.x - this.originLps.x) / s);
    const j0 = Math.round((lps.y - this.originLps.y) / s);
    const k0 = Math.round((lps.z - this.originLps.z) / s);
    for (let di = -neighbourhood; di <= neighbourhood; di++) {
      for (let dj = -neighbourhood; dj <= neighbourhood; dj++) {
        for (let dk = -neighbourhood; dk <= neighbourhood; dk++) {
          const i = i0 + di, j = j0 + dj, k = k0 + dk;
          if (!ribAtIndex(this, index, i, j, k)) continue;
          const centreLps = new THREE.Vector3(
            this.originLps.x + i * s,
            this.originLps.y + j * s,
            this.originLps.z + k * s
          );
          const centreScene = new THREE.Vector3(centreLps.x, centreLps.z, -centreLps.y);
          if (centreScene.distanceTo(p) <= threshold + 1e-9) return 'crosses';
        }
      }
    }
  }
  return 'clear';
};
