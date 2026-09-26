import * as THREE from 'three';
import { ILLUSTRATIVE_LIVER_MODEL as LIVER } from '../scene/LiverLobeBuilder';
import { ANTERIOR_SKIN_SURFACE as SKIN } from './skinSurface';

/**
 * Analytic versions of the illustrative anatomy the scene draws, so planning
 * questions ("does this shaft pass through the liver?", "where does this line
 * reach the skin?") are answered exactly rather than by ray-casting meshes.
 * Illustrative geometry only - not patient anatomy.
 */

type Lobe = { side: 'right' | 'left'; extent: number };
const LOBES: Lobe[] = [
  { side: 'right', extent: LIVER.rightExtentX },
  { side: 'left', extent: LIVER.leftExtentX }
];

/** Normalised radius of p inside one half-ellipsoid lobe (<1 inside), or Infinity if on the other side. */
function lobeValue(p: THREE.Vector3, lobe: Lobe): number {
  const along = lobe.side === 'right' ? LIVER.interfaceX - p.x : p.x - LIVER.interfaceX;
  if (along < 0) return Infinity;
  return Math.sqrt(
    (along / lobe.extent) ** 2 +
    ((p.y - LIVER.centerY) / LIVER.radiusY) ** 2 +
    ((p.z - LIVER.centerZ) / LIVER.radiusZ) ** 2
  );
}

/** Smallest normalised radius over both lobes: < 1 inside the liver, 1 on its surface. */
export function liverValue(p: THREE.Vector3): number {
  return Math.min(lobeValue(p, LOBES[0]), lobeValue(p, LOBES[1]));
}

export function isInsideLiver(p: THREE.Vector3, marginMm = 0): boolean {
  // A margin shrinks the liver slightly so points touching the surface count as outside.
  const scale = 1 - marginMm / LIVER.radiusZ;
  return liverValue(p) < scale;
}

/** Outward unit normal of the lobe surface nearest in normalised radius. */
export function liverNormal(p: THREE.Vector3): THREE.Vector3 {
  const right = lobeValue(p, LOBES[0]);
  const left = lobeValue(p, LOBES[1]);
  const lobe = right <= left ? LOBES[0] : LOBES[1];
  const sign = lobe.side === 'right' ? -1 : 1;
  return new THREE.Vector3(
    sign * (sign * (p.x - LIVER.interfaceX)) / lobe.extent ** 2,
    (p.y - LIVER.centerY) / LIVER.radiusY ** 2,
    (p.z - LIVER.centerZ) / LIVER.radiusZ ** 2
  ).normalize();
}

export interface LiverSurfaceSample {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Points on the outer (visible) liver surface, roughly `spacingMm` apart. The flat
 * interface between the two lobes is internal and is not sampled.
 */
export function sampleLiverSurface(spacingMm = 3): LiverSurfaceSample[] {
  const samples: LiverSurfaceSample[] = [];
  for (const lobe of LOBES) {
    const sign = lobe.side === 'right' ? -1 : 1;
    const longSteps = Math.max(8, Math.ceil(lobe.extent / spacingMm));
    for (let i = 0; i < longSteps; i++) {
      const t = (i + 0.5) / longSteps; // 0 at interface, 1 at the lobe tip
      const ring = Math.sqrt(Math.max(0, 1 - t * t));
      const circumference = Math.PI * (LIVER.radiusY + LIVER.radiusZ) * ring;
      const radialSteps = Math.max(8, Math.ceil(circumference / spacingMm));
      for (let j = 0; j < radialSteps; j++) {
        const angle = (j / radialSteps) * Math.PI * 2;
        const point = new THREE.Vector3(
          LIVER.interfaceX + sign * lobe.extent * t,
          LIVER.centerY + Math.cos(angle) * LIVER.radiusY * ring,
          LIVER.centerZ + Math.sin(angle) * LIVER.radiusZ * ring
        );
        samples.push({ point, normal: liverNormal(point) });
      }
    }
  }
  return samples;
}

/** True when the open segment a->b passes through liver tissue (ends excluded). */
export function segmentCrossesLiver(
  a: THREE.Vector3,
  b: THREE.Vector3,
  steps = 24,
  endClearanceMm = 2
): boolean {
  const length = a.distanceTo(b);
  if (length < 1e-6) return false;
  const p = new THREE.Vector3();
  for (let i = 1; i < steps; i++) {
    const s = i / steps;
    const fromEnd = Math.min(s, 1 - s) * length;
    if (fromEnd < endClearanceMm) continue;
    p.lerpVectors(a, b, s);
    if (isInsideLiver(p, 0.5)) return true;
  }
  return false;
}

/**
 * First point where the ray origin + t*dir (t > 0) meets the anterior skin surface,
 * coming from inside the body. Returns null when the ray leaves through the
 * posterior half, which the illustrative skin does not model.
 */
export function raySkinIntersection(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
  const d = dir.clone().normalize();
  const o = new THREE.Vector3(
    (origin.x - SKIN.centerX) / SKIN.radiusX,
    (origin.y - SKIN.centerY) / SKIN.radiusY,
    (origin.z - SKIN.baseZ) / SKIN.radiusZ
  );
  const v = new THREE.Vector3(d.x / SKIN.radiusX, d.y / SKIN.radiusY, d.z / SKIN.radiusZ);
  const a = v.lengthSq();
  const b = 2 * o.dot(v);
  const c = o.lengthSq() - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-15) return null;
  const root = Math.sqrt(disc);
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter(t => t > 1e-6).sort((x, y) => x - y);
  for (const t of candidates) {
    const hit = origin.clone().addScaledVector(d, t);
    if (hit.z >= SKIN.baseZ) return hit;
  }
  return null;
}

/**
 * Illustrative costal margin: the same arc AnatomyBuilder draws, from the xiphoid
 * down both costal margins. Skin points above it overlie the rib cage.
 */
export const COSTAL_MARGIN = { halfWidthMm: 115, heightMm: 95, offsetYMm: -20, maxAngle: Math.PI * 0.45 } as const;

export function costalMarginPoint(t: number): { x: number; y: number } {
  return {
    x: Math.sin(t) * COSTAL_MARGIN.halfWidthMm,
    y: Math.cos(t) * COSTAL_MARGIN.heightMm + COSTAL_MARGIN.offsetYMm
  };
}

/** True when a skin point lies over the illustrative rib cage (cranial to the costal margin). */
export function isOverRibCage(x: number, y: number): boolean {
  const s = x / COSTAL_MARGIN.halfWidthMm;
  if (Math.abs(s) >= 1) return y > COSTAL_MARGIN.offsetYMm;
  const t = Math.asin(s);
  if (Math.abs(t) > COSTAL_MARGIN.maxAngle) return y > costalMarginPoint(Math.sign(t) * COSTAL_MARGIN.maxAngle).y;
  return y > costalMarginPoint(t).y;
}
