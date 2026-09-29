import * as THREE from 'three';
import { getPatientAnatomyContext } from './anatomyContext';

export const ANTERIOR_SKIN_SURFACE = {
  centerX: 10,
  centerY: 0,
  baseZ: -30,
  radiusX: 145,
  radiusY: 160,
  radiusZ: 130
} as const;

/** Point on the active anterior skin surface at the supplied scene X/Y location. */
export function getAnteriorSkinSurfacePoint(
  x: number,
  y: number,
  clearance = 0
): THREE.Vector3 | null {
  const patient = getPatientAnatomyContext();
  if (patient) return patient.anteriorSkinPoint(x, y, clearance);

  const { centerX, centerY, baseZ, radiusX, radiusY, radiusZ } = ANTERIOR_SKIN_SURFACE;
  if (![x, y, clearance].every(Number.isFinite)) return null;

  const normalizedX = (x - centerX) / radiusX;
  const normalizedY = (y - centerY) / radiusY;
  const remaining = 1 - normalizedX * normalizedX - normalizedY * normalizedY;
  if (remaining < -1e-10) return null;

  const z = baseZ + radiusZ * Math.sqrt(Math.max(0, remaining));
  const normal = getAnteriorSkinSurfaceNormal(x, y);
  if (!normal) return null;

  return new THREE.Vector3(x, y, z).addScaledVector(normal, clearance);
}

/** Outward normal of the active anterior skin surface at the supplied scene X/Y location. */
export function getAnteriorSkinSurfaceNormal(x: number, y: number): THREE.Vector3 | null {
  const patient = getPatientAnatomyContext();
  if (patient) {
    const point = patient.anteriorSkinPoint(x, y, 0);
    return point ? patient.skinNormal(point) : null;
  }

  const { centerX, centerY, baseZ, radiusX, radiusY, radiusZ } = ANTERIOR_SKIN_SURFACE;
  if (![x, y].every(Number.isFinite)) return null;

  const normalizedX = (x - centerX) / radiusX;
  const normalizedY = (y - centerY) / radiusY;
  const remaining = 1 - normalizedX * normalizedX - normalizedY * normalizedY;
  if (remaining < -1e-10) return null;

  const z = baseZ + radiusZ * Math.sqrt(Math.max(0, remaining));
  return new THREE.Vector3(
    (x - centerX) / (radiusX * radiusX),
    (y - centerY) / (radiusY * radiusY),
    (z - baseZ) / (radiusZ * radiusZ)
  ).normalize();
}
