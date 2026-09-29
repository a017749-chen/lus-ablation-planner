import * as THREE from 'three';
import { PatientAnatomyContext } from './patientAnatomy';

declare module './patientAnatomy' {
  interface PatientAnatomyContext {
    anteriorSkinPoint(x: number, y: number, offsetMm?: number): THREE.Vector3 | null;
  }
}

/**
 * Project one scene X/Y position to the first anterior body-mask boundary.
 * Scene +Z is anterior while DICOM LPS +Y is posterior, so increasing grid-j walks
 * from anterior to posterior. No illustrative ellipsoid is mixed into patient mode.
 */
PatientAnatomyContext.prototype.anteriorSkinPoint = function(
  x: number,
  y: number,
  offsetMm = 0
): THREE.Vector3 | null {
  if (![x, y, offsetMm].every(Number.isFinite)) return null;
  const anteriorZ = -this.originLps.y;
  let previous = new THREE.Vector3(x, y, anteriorZ + this.spacingMm);
  let previousInside = this.isUnderSkin(previous);

  for (let j = 0; j < this.shape[1]; j++) {
    const z = -(this.originLps.y + j * this.spacingMm);
    const current = new THREE.Vector3(x, y, z);
    const inside = this.isUnderSkin(current);
    if (!previousInside && inside) {
      let outside = previous.clone();
      let insidePoint = current.clone();
      for (let n = 0; n < 10; n++) {
        const mid = outside.clone().add(insidePoint).multiplyScalar(0.5);
        if (this.isUnderSkin(mid)) insidePoint = mid; else outside = mid;
      }
      const surface = outside.add(insidePoint).multiplyScalar(0.5);
      const normal = this.skinNormal(surface);
      return normal ? surface.addScaledVector(normal, offsetMm) : surface;
    }
    previous = current;
    previousInside = inside;
  }
  return null;
};
