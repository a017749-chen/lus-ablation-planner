import * as THREE from 'three';

export interface AblationEllipsoid {
  center: THREE.Vector3;
  axisX: THREE.Vector3;
  axisY: THREE.Vector3;
  axisZ: THREE.Vector3;
  radiusX: number;
  radiusY: number;
  radiusZ: number;
}

/**
 * Estimate the fraction of a spherical target (tumor plus margin) contained in
 * the displayed ablation ellipsoid. This is a geometric visualization metric,
 * not a thermal dose or clinical coverage prediction.
 */
export function estimateEllipsoidTargetOverlap(
  targetCenter: THREE.Vector3,
  targetRadius: number,
  ellipsoid: AblationEllipsoid,
  spacingMm: number = 2
): number {
  if (targetRadius <= 0 || spacingMm <= 0) {
    throw new Error('Target radius and sampling spacing must be positive.');
  }
  if (ellipsoid.radiusX <= 0 || ellipsoid.radiusY <= 0 || ellipsoid.radiusZ <= 0) {
    throw new Error('Ablation ellipsoid radii must be positive.');
  }

  const axes = [ellipsoid.axisX, ellipsoid.axisY, ellipsoid.axisZ];
  const radii = [ellipsoid.radiusX, ellipsoid.radiusY, ellipsoid.radiusZ];
  const centerOffset = new THREE.Vector3().subVectors(targetCenter, ellipsoid.center);
  const normalizedUpperBound = Math.sqrt(
    axes.reduce((sum, axis, index) => {
      const component = Math.abs(centerOffset.dot(axis)) + targetRadius;
      return sum + (component / radii[index]) ** 2;
    }, 0)
  );

  // Conservative sufficient condition: every point in the target sphere lies
  // inside the ellipsoid. This is the only path that reports 100%.
  if (normalizedUpperBound <= 1) return 100;

  const steps = Math.max(1, Math.ceil((2 * targetRadius) / spacingMm));
  const step = (2 * targetRadius) / steps;
  const radiusSq = targetRadius * targetRadius;
  let targetSamples = 0;
  let coveredSamples = 0;

  for (let ix = 0; ix < steps; ix += 1) {
    const x = -targetRadius + (ix + 0.5) * step;
    for (let iy = 0; iy < steps; iy += 1) {
      const y = -targetRadius + (iy + 0.5) * step;
      for (let iz = 0; iz < steps; iz += 1) {
        const z = -targetRadius + (iz + 0.5) * step;
        if (x * x + y * y + z * z > radiusSq) continue;
        targetSamples += 1;

        const sample = centerOffset.clone().add(new THREE.Vector3(x, y, z));
        const ellipsoidX = sample.dot(ellipsoid.axisX) / ellipsoid.radiusX;
        const ellipsoidY = sample.dot(ellipsoid.axisY) / ellipsoid.radiusY;
        const ellipsoidZ = sample.dot(ellipsoid.axisZ) / ellipsoid.radiusZ;
        if (ellipsoidX * ellipsoidX + ellipsoidY * ellipsoidY + ellipsoidZ * ellipsoidZ <= 1) {
          coveredSamples += 1;
        }
      }
    }
  }

  if (targetSamples === 0) return 0;
  const estimatedPercent = Math.round((coveredSamples / targetSamples) * 100);
  return estimatedPercent === 100 ? 99 : estimatedPercent;
}
