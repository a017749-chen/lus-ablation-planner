import * as THREE from 'three';

export interface UltrasoundSectorBounds {
  kind?: 'sector';
  nearRadiusMm: number;
  farRadiusMm: number;
  sectorAngleDeg: number;
}

/** Rectangular image of a linear array: lateral +-halfWidth, depth near..far below the face. */
export interface LinearImageBounds {
  kind: 'linear';
  halfWidthMm: number;
  nearDepthMm: number;
  farDepthMm: number;
}

export type ImageBounds = UltrasoundSectorBounds | LinearImageBounds;

function isLinear(bounds: ImageBounds): bounds is LinearImageBounds {
  return bounds.kind === 'linear';
}

export const ULTRASOUND_SECTOR: Readonly<UltrasoundSectorBounds & { sliceThicknessMm: number }> = {
  nearRadiusMm: 10,
  farRadiusMm: 105,
  sectorAngleDeg: 75,
  sliceThicknessMm: 1.5
};

export interface SphereSlabIntersection {
  visible: boolean;
  effectiveOffsetMm: number;
  crossSectionRadiusMm: number;
}

/** Largest sphere cross-section contained by a slab of the given thickness. */
export function getSphereSlabIntersection(
  radiusMm: number,
  planeOffsetMm: number,
  sliceThicknessMm: number
): SphereSlabIntersection {
  if (
    !Number.isFinite(radiusMm) ||
    !Number.isFinite(planeOffsetMm) ||
    !Number.isFinite(sliceThicknessMm) ||
    radiusMm < 0 ||
    sliceThicknessMm < 0
  ) {
    return { visible: false, effectiveOffsetMm: Infinity, crossSectionRadiusMm: 0 };
  }

  const effectiveOffsetMm = Math.max(0, Math.abs(planeOffsetMm) - sliceThicknessMm * 0.5);
  const visible = effectiveOffsetMm <= radiusMm;
  return {
    visible,
    effectiveOffsetMm,
    crossSectionRadiusMm: visible
      ? Math.sqrt(Math.max(0, radiusMm * radiusMm - effectiveOffsetMm * effectiveOffsetMm))
      : 0
  };
}

export interface SectorClosestPoint {
  lateralMm: number;
  depthMm: number;
  distanceMm: number;
}

/**
 * Closest point inside the image: an annular sector for convex/phased arrays, a
 * rectangle for a linear array.
 */
export function closestPointInUltrasoundSector(
  lateralMm: number,
  depthMm: number,
  bounds: ImageBounds = ULTRASOUND_SECTOR
): SectorClosestPoint {
  if (isLinear(bounds)) {
    const lateral = THREE.MathUtils.clamp(lateralMm, -bounds.halfWidthMm, bounds.halfWidthMm);
    const depth = THREE.MathUtils.clamp(depthMm, bounds.nearDepthMm, bounds.farDepthMm);
    return { lateralMm: lateral, depthMm: depth, distanceMm: Math.hypot(lateralMm - lateral, depthMm - depth) };
  }
  const halfAngle = THREE.MathUtils.degToRad(bounds.sectorAngleDeg * 0.5);
  const targetAngle = Math.atan2(lateralMm, depthMm);
  const angle = THREE.MathUtils.clamp(targetAngle, -halfAngle, halfAngle);
  const radialProjection = lateralMm * Math.sin(angle) + depthMm * Math.cos(angle);
  const radius = THREE.MathUtils.clamp(radialProjection, bounds.nearRadiusMm, bounds.farRadiusMm);
  const closestLateral = radius * Math.sin(angle);
  const closestDepth = radius * Math.cos(angle);

  return {
    lateralMm: closestLateral,
    depthMm: closestDepth,
    distanceMm: Math.hypot(lateralMm - closestLateral, depthMm - closestDepth)
  };
}

export function isPointInUltrasoundSector(
  lateralMm: number,
  depthMm: number,
  bounds: ImageBounds = ULTRASOUND_SECTOR,
  toleranceMm: number = 1e-8
): boolean {
  if (isLinear(bounds)) {
    return Math.abs(lateralMm) <= bounds.halfWidthMm + toleranceMm &&
      depthMm >= bounds.nearDepthMm - toleranceMm &&
      depthMm <= bounds.farDepthMm + toleranceMm;
  }
  const radius = Math.hypot(lateralMm, depthMm);
  const angle = Math.atan2(lateralMm, depthMm);
  const halfAngle = THREE.MathUtils.degToRad(bounds.sectorAngleDeg * 0.5);
  return (
    radius >= bounds.nearRadiusMm - toleranceMm &&
    radius <= bounds.farRadiusMm + toleranceMm &&
    Math.abs(angle) <= halfAngle + 1e-8
  );
}
