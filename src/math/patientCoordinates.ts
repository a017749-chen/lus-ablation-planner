import * as THREE from 'three';

/**
 * Scene frame used by this illustrative planner:
 * +X patient-left, +Y superior, +Z anterior.
 * A DICOM LPS patient point maps to (L, S, -P) in this scene frame.
 */
export const PATIENT_SCENE_FRAME = {
  positiveX: 'patient-left',
  positiveY: 'superior',
  positiveZ: 'anterior'
} as const;

/** Anterior view that places patient-right on the viewer's left. */
export const ANTERIOR_VIEW = {
  position: [10, 10, 320] as const,
  target: [10, 10, 10] as const,
  up: [0, 1, 0] as const
} as const;

/** Operating view: patient-left projects to screen-right, without mirroring anatomy. */
export const SURGEON_VIEW = {
  position: [-90, -190, 210] as const,
  target: [10, 10, 10] as const,
  up: [0, 1, 0] as const
} as const;

/** Convert a DICOM BIPED LPS millimeter point into the planner's Three.js scene frame. */
export function dicomLpsToScene(point: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.z, -point.y);
}

/** Convert a planner scene point back to DICOM BIPED LPS millimeters. */
export function sceneToDicomLps(point: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(point.x, -point.z, point.y);
}

