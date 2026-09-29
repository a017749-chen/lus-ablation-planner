import { PatientAnatomyContext } from './patientAnatomy';
import { RibCageStatus } from './anatomyContext';

declare module './patientAnatomy' {
  interface PatientAnatomyContext {
    ribProjectionStatus(x: number, y: number): RibCageStatus;
  }
}

interface RibProjection {
  cells: Set<string>;
  evaluable: boolean;
}

const cache = new WeakMap<PatientAnatomyContext, RibProjection>();

function buildProjection(context: PatientAnatomyContext): RibProjection {
  const structure = context.payload.structures.ribs;
  if (!structure || structure.voxels <= 0 || !Array.isArray(structure.runs)) {
    return { cells: new Set(), evaluable: false };
  }

  const cells = new Set<string>();
  const [, ny, nz] = context.shape;
  const yz = ny * nz;
  const runs = structure.runs.map(Number);
  for (let r = 0; r < runs.length; r += 2) {
    const start = runs[r];
    const length = runs[r + 1];
    for (let linear = start; linear < start + length; linear++) {
      const i = Math.floor(linear / yz);
      const rem = linear - i * yz;
      // j is anterior/posterior depth and is deliberately projected away. Scene Y
      // corresponds to LPS superior (grid k), so one i/k pair is the anterior rib
      // footprint seen by a skin-entry query.
      const k = rem % nz;
      cells.add(`${i},${k}`);
    }
  }
  return { cells, evaluable: cells.size > 0 };
}

/**
 * Return whether an anterior skin-entry X/Y lies over the projected patient rib mask.
 *
 * The original API asks this question with only scene X/Y. A 3-D distance to an
 * arbitrary Z therefore cannot answer it reliably. This method projects the exact
 * binary rib voxels along the anterior/posterior axis and tests the query against
 * their voxel footprint. The half-diagonal tolerance only accounts for discretising
 * one planning-grid voxel; it is not a clinical safety margin.
 */
PatientAnatomyContext.prototype.ribProjectionStatus = function(
  x: number,
  y: number
): RibCageStatus {
  if (![x, y].every(Number.isFinite)) return 'not-evaluable';
  let projection = cache.get(this);
  if (!projection) {
    projection = buildProjection(this);
    cache.set(this, projection);
  }
  if (!projection.evaluable) return 'not-evaluable';

  const s = this.spacingMm;
  const i0 = Math.round((x - this.originLps.x) / s);
  const k0 = Math.round((y - this.originLps.z) / s);
  const tolerance = Math.SQRT2 * s * 0.5 + 1e-9;
  for (let di = -1; di <= 1; di++) {
    for (let dk = -1; dk <= 1; dk++) {
      const i = i0 + di;
      const k = k0 + dk;
      if (!projection.cells.has(`${i},${k}`)) continue;
      const cx = this.originLps.x + i * s;
      const cy = this.originLps.z + k * s;
      if (Math.hypot(x - cx, y - cy) <= tolerance) return 'over';
    }
  }
  return 'clear';
};
