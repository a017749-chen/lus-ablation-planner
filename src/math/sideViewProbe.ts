import * as THREE from 'three';
import { LUS_PROBE, LusProbeSpec } from '../config/probe';
import { FulcrumKinematics } from './kinematics';

/**
 * Side-viewing laparoscopic ultrasound probe.
 *
 * The shaft pivots at the trocar, runs straight to a flex joint, and a flexible
 * tip carries a linear array along its side. The image plane contains the array
 * axis; the beam leaves the array face at right angles. Bending the tip rotates
 * the face with it (parallel transport), as a real articulating tip does.
 *
 * Frames (all unit vectors, world coordinates):
 *   s  shaft direction, pivot -> joint
 *   a  array axis, proximal -> distal
 *   b  beam direction, array face -> tissue (depth axis of the image)
 *   n  image-plane normal = a x b
 */
export interface ProbeControls {
  shaftPitchDeg: number;
  shaftYawDeg: number;
  insertionMm: number; // pivot -> flex joint
  rollDeg: number; // about the shaft
  flexUpDownDeg: number; // bend toward the array face (+) or away (-)
  flexLeftRightDeg: number; // bend sideways
}

export interface ProbePose {
  pivot: THREE.Vector3;
  shaftDir: THREE.Vector3;
  insertionMm: number;
  joint: THREE.Vector3;
  arrayCenter: THREE.Vector3;
  arrayAxis: THREE.Vector3;
  beamDir: THREE.Vector3;
  planeNormal: THREE.Vector3;
  flexDeg: number;
}

/** Reference face direction for a straight probe: cranial (+Y) projected off the shaft. */
function straightFrame(s: THREE.Vector3, rollDeg: number): { e1: THREE.Vector3; e2: THREE.Vector3 } {
  const ref = Math.abs(s.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e2 = ref.addScaledVector(s, -ref.dot(s)).normalize();
  const e1 = new THREE.Vector3().crossVectors(s, e2).normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(s, THREE.MathUtils.degToRad(rollDeg));
  return { e1: e1.applyQuaternion(q), e2: e2.applyQuaternion(q) };
}

export function poseFromParts(
  pivot: THREE.Vector3,
  joint: THREE.Vector3,
  arrayAxis: THREE.Vector3,
  beamDir: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE
): ProbePose {
  const shaftDir = joint.clone().sub(pivot).normalize();
  const a = arrayAxis.clone().normalize();
  const b = beamDir.clone().addScaledVector(a, -beamDir.dot(a)).normalize();
  return {
    pivot: pivot.clone(),
    shaftDir,
    insertionMm: joint.distanceTo(pivot),
    joint: joint.clone(),
    arrayCenter: joint.clone().addScaledVector(a, spec.tipLengthMm),
    arrayAxis: a,
    beamDir: b,
    planeNormal: new THREE.Vector3().crossVectors(a, b).normalize(),
    flexDeg: THREE.MathUtils.radToDeg(shaftDir.angleTo(a))
  };
}

export function forwardProbe(
  pivot: THREE.Vector3,
  portDirection: THREE.Vector3,
  c: ProbeControls,
  spec: LusProbeSpec = LUS_PROBE
): ProbePose {
  const s = FulcrumKinematics.computeForward(pivot, portDirection, c.shaftPitchDeg, c.shaftYawDeg, 0, c.insertionMm).direction;
  const { e1, e2 } = straightFrame(s, c.rollDeg);
  const theta = THREE.MathUtils.degToRad(Math.hypot(c.flexUpDownDeg, c.flexLeftRightDeg));
  const phi = Math.atan2(c.flexLeftRightDeg, c.flexUpDownDeg);
  const bend = e2.clone().multiplyScalar(Math.cos(phi)).addScaledVector(e1, Math.sin(phi));
  const a = s.clone().multiplyScalar(Math.cos(theta)).addScaledVector(bend, Math.sin(theta)).normalize();
  // Bending toward the face (+up/down) tips the face back toward the shaft: rotate e2 with the tip.
  const q = new THREE.Quaternion().setFromUnitVectors(s, a);
  const b = e2.clone().applyQuaternion(q);
  const joint = pivot.clone().addScaledVector(s, c.insertionMm);
  return poseFromParts(pivot, joint, a, b, spec);
}

/** Controls that reproduce a pose from forwardProbe (round-trips within numerical precision). */
export function inverseProbe(pose: ProbePose, portDirection: THREE.Vector3): ProbeControls {
  const s = pose.shaftDir;
  const aim = FulcrumKinematics.solveAimTarget(pose.pivot, portDirection, pose.joint);
  const a = pose.arrayAxis;
  const qInv = new THREE.Quaternion().setFromUnitVectors(s, a).invert();
  const faceStraight = pose.beamDir.clone().applyQuaternion(qInv); // e2 after roll
  const { e1: e1Zero, e2: e2Zero } = straightFrame(s, 0);
  const rollRad = Math.atan2(faceStraight.dot(e1Zero), faceStraight.dot(e2Zero));
  const { e1, e2 } = straightFrame(s, THREE.MathUtils.radToDeg(rollRad));
  const theta = s.angleTo(a);
  let phi = 0;
  if (theta > 1e-9) {
    const d = a.clone().addScaledVector(s, -a.dot(s)).normalize();
    phi = Math.atan2(d.dot(e1), d.dot(e2));
  }
  const thetaDeg = THREE.MathUtils.radToDeg(theta);
  return {
    shaftPitchDeg: aim.pitch,
    shaftYawDeg: aim.yaw,
    insertionMm: pose.insertionMm,
    rollDeg: THREE.MathUtils.radToDeg(rollRad),
    flexUpDownDeg: thetaDeg * Math.cos(phi),
    flexLeftRightDeg: thetaDeg * Math.sin(phi)
  };
}

/** Image coordinates of a world point: u along the array, v into depth, w off-plane. */
export function toImage(pose: ProbePose, p: THREE.Vector3): { u: number; v: number; w: number } {
  const rel = p.clone().sub(pose.arrayCenter);
  return { u: rel.dot(pose.arrayAxis), v: rel.dot(pose.beamDir), w: rel.dot(pose.planeNormal) };
}

export function isInLinearImage(u: number, v: number, spec: LusProbeSpec = LUS_PROBE, tol = 1e-6): boolean {
  const half = spec.image.widthMm / 2;
  return Math.abs(u) <= half + tol && v >= spec.image.nearDepthMm - tol && v <= spec.image.farDepthMm + tol;
}

/** Guide direction in image coordinates (du, dv), unit length, pointing distal and into depth. */
export function guideDirection2D(spec: LusProbeSpec = LUS_PROBE): { du: number; dv: number } {
  const angle = THREE.MathUtils.degToRad(spec.guide.angleDeg);
  return spec.guide.angleReference === 'array-axis'
    ? { du: Math.cos(angle), dv: Math.sin(angle) }
    : { du: Math.sin(angle), dv: Math.cos(angle) };
}

export interface GuideLine {
  hole: THREE.Vector3;
  direction: THREE.Vector3; // unit, from the hole toward the image
  holeUv: { u: number; v: number };
  /** Depth range over which the guide line stays inside the linear image. */
  visibleDepthMm: { min: number; max: number } | null;
}

export function guideLine(pose: ProbePose, spec: LusProbeSpec = LUS_PROBE): GuideLine {
  const { du, dv } = guideDirection2D(spec);
  const holeUv = { u: -spec.guide.holeOffsetMm, v: -spec.guide.holeHeightMm };
  const hole = pose.arrayCenter.clone()
    .addScaledVector(pose.arrayAxis, holeUv.u)
    .addScaledVector(pose.beamDir, holeUv.v);
  const direction = pose.arrayAxis.clone().multiplyScalar(du).addScaledVector(pose.beamDir, dv).normalize();
  return { hole, direction, holeUv, visibleDepthMm: guideVisibleDepth(spec) };
}

/** Where along the depth axis the guide line is inside the image (independent of pose). */
export function guideVisibleDepth(spec: LusProbeSpec = LUS_PROBE): { min: number; max: number } | null {
  const { du, dv } = guideDirection2D(spec);
  const half = spec.image.widthMm / 2;
  const u0 = -spec.guide.holeOffsetMm;
  const v0 = -spec.guide.holeHeightMm;
  if (du <= 1e-9 || dv <= 1e-9) return null;
  const tEnter = (-half - u0) / du;
  const tExit = (half - u0) / du;
  const lo = Math.max(v0 + dv * Math.max(0, tEnter), spec.image.nearDepthMm);
  const hi = Math.min(v0 + dv * tExit, spec.image.farDepthMm);
  return hi > lo ? { min: lo, max: hi } : null;
}

/** Lateral image position u at which the guide line reaches depth v. */
export function guideLateralAtDepth(v: number, spec: LusProbeSpec = LUS_PROBE): number {
  const { du, dv } = guideDirection2D(spec);
  return -spec.guide.holeOffsetMm + ((v + spec.guide.holeHeightMm) * du) / dv;
}
