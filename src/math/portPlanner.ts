import * as THREE from 'three';
import { LUS_PROBE, LusProbeSpec, NEEDLE_SPEC, NeedleSpec } from '../config/probe';
import {
  isOverRibCage,
  LiverSurfaceSample,
  raySkinIntersection,
  sampleLiverSurface,
  segmentCrossesLiver
} from './anatomyShapes';
import { CollisionDetector } from './collision';
import { getAnteriorSkinSurfaceNormal, getAnteriorSkinSurfacePoint } from './skinSurface';
import { guideLateralAtDepth, guideLine, poseFromParts, ProbePose } from './sideViewProbe';

/**
 * Skin port planning for LUS-guided ablation.
 *
 * It answers "can this skin point work, and if not, why" - it never ranks or
 * recommends. Where one geometric solution must be picked to pose the probe, the
 * tie-breaker (least tip flex) is stated as a geometric choice, not a clinical one.
 * Illustrative geometry only.
 */

export interface AcousticWindow {
  point: THREE.Vector3; // contact point on the liver surface = array centre
  beam: THREE.Vector3; // into the liver
  depthMm: number; // target depth below the array
  lateral: THREE.Vector3; // target offset along the surface (unit direction * mm)
  lateralMm: number;
}

/**
 * Which liver surface a probe can lie on (outward-normal limits). Illustrative,
 * uncalibrated: excludes the posterior surface and the part of the dome that sits
 * under the diaphragm.
 */
export const ACCESSIBLE_SURFACE = { minNormalZ: -0.3, maxNormalY: 0.85 } as const;

let cachedSurface: LiverSurfaceSample[] | null = null;
export function liverSurface(): LiverSurfaceSample[] {
  cachedSurface ??= sampleLiverSurface(2.5);
  return cachedSurface;
}

/** Surface contact points from which the target lies inside the linear image. */
export function findAcousticWindows(
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  surface: LiverSurfaceSample[] = liverSurface()
): AcousticWindow[] {
  const half = spec.image.widthMm / 2;
  const windows: AcousticWindow[] = [];
  for (const { point, normal } of surface) {
    // The probe reaches the anterior and inferior surfaces from the pneumoperitoneum;
    // the posterior surface lies on the retroperitoneum and the dome under the diaphragm.
    if (normal.z < ACCESSIBLE_SURFACE.minNormalZ || normal.y > ACCESSIBLE_SURFACE.maxNormalY) continue;
    const beam = normal.clone().negate();
    const rel = target.clone().sub(point);
    const depthMm = rel.dot(beam);
    if (depthMm < spec.image.nearDepthMm || depthMm > spec.image.farDepthMm) continue;
    const lateral = rel.addScaledVector(beam, -depthMm);
    const lateralMm = lateral.length();
    if (lateralMm > half) continue;
    windows.push({ point, beam, depthMm, lateral, lateralMm });
  }
  return windows;
}

export type Reason =
  | 'no-window'
  | 'too-far'
  | 'trocar-tilt'
  | 'shaft-outside-body'
  | 'needle-tilt'
  | 'flex-limit'
  | 'shaft-through-liver'
  | 'guide-misses-target'
  | 'guide-too-deep'
  | 'no-skin-exit'
  | 'needle-too-long'
  | 'vessel-too-close'
  | 'needle-crosses-liver-before-hole'
  | 'target-not-centerable';

export type Warning = 'over-rib-cage' | 'needle-near-beam-axis';

export const REASON_TEXT: Record<Reason | Warning, string> = {
  'no-window': '肝表面找不到能讓腫瘤進入影像的聲窗',
  'too-far': '探頭伸不到（超過桿長）',
  'trocar-tilt': '套管需要傾斜超過上限（太貼近腹壁）',
  'shaft-outside-body': '探頭桿會跑出腹壁外',
  'needle-tilt': '針與皮膚夾角太斜',
  'flex-limit': '尖端需要彎超過上限',
  'shaft-through-liver': '探頭桿會穿過肝臟',
  'guide-misses-target': '導引線對不到腫瘤',
  'guide-too-deep': '腫瘤超出導引線在影像內的深度範圍',
  'no-skin-exit': '導引線往回延伸碰不到前腹壁',
  'needle-too-long': '針長不夠',
  'vessel-too-close': '針道距血管太近',
  'needle-crosses-liver-before-hole': '針在到達導引孔前就穿過肝臟',
  'target-not-centerable': '沒有任何聲窗的影像面能同時包含這條針道',
  'over-rib-cage': '在肋骨區上方（需經肋間）',
  'needle-near-beam-axis': '針幾乎與聲束平行，影像上不易看見'
};

export interface ProbeSolution {
  window: AcousticWindow;
  pose: ProbePose;
}

export interface ProbePortResult {
  feasible: boolean;
  reasons: Reason[];
  warnings: Warning[];
  /** Geometric tie-break among feasible poses: the least tip flex. Not a clinical preference. */
  leastFlex?: ProbeSolution;
  feasibleWindowCount: number;
}

/** Angle between a direction entering the body at a skin point and the inward skin normal. */
export function skinTiltDeg(skin: THREE.Vector3, inward: THREE.Vector3): number {
  const normal = getAnteriorSkinSurfaceNormal(skin.x, skin.y);
  if (!normal) return 90;
  return THREE.MathUtils.radToDeg(inward.clone().normalize().angleTo(normal.negate()));
}

/** True when a point lies under the anterior abdominal wall (inside the illustrative body). */
function isUnderSkin(p: THREE.Vector3): boolean {
  const skin = getAnteriorSkinSurfacePoint(p.x, p.y);
  return !!skin && p.z < skin.z - 1;
}

function tangentProjection(v: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
  return v.clone().addScaledVector(normal, -v.dot(normal));
}

/** Probe pose that puts the array on `window` with the given array axis, if the port allows it. */
function tryPose(
  pivot: THREE.Vector3,
  window: AcousticWindow,
  arrayAxis: THREE.Vector3,
  spec: LusProbeSpec
): { pose?: ProbePose; reason?: Reason } {
  const joint = window.point.clone().addScaledVector(arrayAxis, -spec.tipLengthMm);
  const pose = poseFromParts(pivot, joint, arrayAxis, window.beam, spec);
  if (pose.insertionMm > spec.maxShaftLengthMm) return { reason: 'too-far' };
  if (skinTiltDeg(pivot, pose.shaftDir) > spec.maxTrocarTiltDeg) return { reason: 'trocar-tilt' };
  for (let i = 1; i <= 6; i++) {
    if (!isUnderSkin(pivot.clone().lerp(joint, i / 6))) return { reason: 'shaft-outside-body' };
  }
  if (pose.flexDeg > spec.maxFlexDeg) return { reason: 'flex-limit' };
  if (segmentCrossesLiver(pivot, joint) || segmentCrossesLiver(joint, window.point, 8, 1)) {
    return { reason: 'shaft-through-liver' };
  }
  return { pose };
}

/** Array axes that keep the target in the image plane at this window. */
function candidateAxes(pivot: THREE.Vector3, window: AcousticWindow): THREE.Vector3[] {
  if (window.lateralMm > 0.75) {
    const t = window.lateral.clone().normalize();
    return [t, t.clone().negate()];
  }
  // Target straight under the array: the plane may rotate freely about the beam.
  // The axis closest to the shaft direction needs the least flex.
  const toward = tangentProjection(window.point.clone().sub(pivot), window.beam.clone().negate());
  if (toward.lengthSq() < 1e-9) toward.copy(tangentProjection(new THREE.Vector3(0, 1, 0), window.beam));
  const a = toward.normalize();
  return [a, a.clone().negate()];
}

function summarise(counts: Map<Reason, number>): Reason[] {
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([r]) => r);
}

export function evaluateProbePort(
  pivot: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec)
): ProbePortResult {
  const warnings: Warning[] = isOverRibCage(pivot.x, pivot.y) ? ['over-rib-cage'] : [];
  if (!windows.length) return { feasible: false, reasons: ['no-window'], warnings, feasibleWindowCount: 0 };
  const failures = new Map<Reason, number>();
  let best: ProbeSolution | undefined;
  let count = 0;
  for (const window of windows) {
    let ok = false;
    for (const axis of candidateAxes(pivot, window)) {
      const { pose, reason } = tryPose(pivot, window, axis, spec);
      if (!pose) {
        failures.set(reason!, (failures.get(reason!) ?? 0) + 1);
        continue;
      }
      ok = true;
      if (!best || pose.flexDeg < best.pose.flexDeg) best = { window, pose };
    }
    if (ok) count++;
  }
  return {
    feasible: count > 0,
    reasons: count > 0 ? [] : summarise(failures),
    warnings,
    leastFlex: best,
    feasibleWindowCount: count
  };
}

export interface NeedlePathCheck {
  feasible: boolean;
  reasons: Reason[];
  warnings: Warning[];
  lengthMm: number;
  vesselClearanceMm: number;
  closestVessel: string;
}

/** Checks shared by both needle modes, for a straight needle from skin to target. */
export function checkNeedlePath(
  skin: THREE.Vector3,
  target: THREE.Vector3,
  needle: NeedleSpec = NEEDLE_SPEC
): NeedlePathCheck {
  const reasons: Reason[] = [];
  const warnings: Warning[] = [];
  const lengthMm = skin.distanceTo(target);
  if (lengthMm > needle.usableLengthMm) reasons.push('needle-too-long');
  if (skinTiltDeg(skin, target.clone().sub(skin)) > needle.maxSkinTiltDeg) reasons.push('needle-tilt');
  const collision = CollisionDetector.checkCollision(skin, target);
  if (collision.minDistance < needle.vesselClearanceMm) reasons.push('vessel-too-close');
  if (isOverRibCage(skin.x, skin.y)) warnings.push('over-rib-cage');
  return {
    feasible: reasons.length === 0,
    reasons,
    warnings,
    lengthMm,
    vesselClearanceMm: collision.minDistance,
    closestVessel: collision.closestVesselName
  };
}

export interface GuidedSolution extends ProbeSolution {
  skinEntry: THREE.Vector3;
  needle: NeedlePathCheck;
  guideMissMm: number;
}

export interface GuidedResult {
  feasible: boolean;
  reasons: Reason[];
  warnings: Warning[];
  solutions: GuidedSolution[];
  leastFlex?: GuidedSolution;
}

/**
 * Needle through the probe's guide hole. The probe pose fixes the guide line;
 * running it back to the skin fixes the puncture point. Only windows where the
 * guide line passes the target within `toleranceMm` count.
 */
export function solveGuidedNeedle(
  pivot: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec),
  toleranceMm = 1.5
): GuidedResult {
  const failures = new Map<Reason, number>();
  const fail = (r: Reason) => failures.set(r, (failures.get(r) ?? 0) + 1);
  const half = spec.image.widthMm / 2;
  const solutions: GuidedSolution[] = [];
  if (!windows.length) return { feasible: false, reasons: ['no-window'], warnings: [], solutions };

  for (const window of windows) {
    const needU = guideLateralAtDepth(window.depthMm, spec);
    if (Math.abs(needU) > half) { fail('guide-too-deep'); continue; }
    // With axis a, the target sits at u = lateral . a. Off-centre targets fix the axis
    // up to sign; choose the sign that puts the target on the guide's side.
    let axes: THREE.Vector3[];
    let miss: number;
    if (window.lateralMm > 0.75) {
      const side = Math.sign(needU) || 1;
      axes = [window.lateral.clone().normalize().multiplyScalar(side)];
      miss = Math.abs(window.lateralMm * side - needU);
    } else {
      axes = candidateAxes(pivot, window); // target at u = 0; the plane may rotate
      miss = Math.abs(needU);
    }
    if (miss > toleranceMm) { fail('guide-misses-target'); continue; }
    for (const axis of axes) {
      const { pose, reason } = tryPose(pivot, window, axis, spec);
      if (!pose) { fail(reason!); continue; }
      const guide = guideLine(pose, spec);
      const skinEntry = raySkinIntersection(guide.hole, guide.direction.clone().negate());
      if (!skinEntry) { fail('no-skin-exit'); continue; }
      if (segmentCrossesLiver(skinEntry, guide.hole)) { fail('needle-crosses-liver-before-hole'); continue; }
      const needle = checkNeedlePath(skinEntry, target);
      if (!needle.feasible) { needle.reasons.forEach(fail); continue; }
      const toTarget = target.clone().sub(guide.hole);
      const along = toTarget.dot(guide.direction);
      const guideMissMm = toTarget.addScaledVector(guide.direction, -along).length();
      solutions.push({ window, pose, skinEntry, needle, guideMissMm });
    }
  }
  const leastFlex = solutions.reduce<GuidedSolution | undefined>(
    (best, s) => (!best || s.pose.flexDeg < best.pose.flexDeg ? s : best), undefined);
  return {
    feasible: solutions.length > 0,
    reasons: solutions.length ? [] : summarise(failures),
    warnings: leastFlex?.needle.warnings ?? [],
    solutions,
    leastFlex
  };
}

export interface FreehandResult extends NeedlePathCheck {
  /** Angle between the needle and the beam axis (degrees); small = poorly visible. */
  needleBeamAngleDeg?: number;
}

/** Largest angle between the needle and a window's image plane that still counts as in plane. */
export const IN_PLANE_TOLERANCE_DEG = 3;

/**
 * Freehand in-plane needle from a chosen skin point. A window keeps the needle in
 * plane when its image plane contains the needle: always true if the target sits
 * straight under the array (the plane can then rotate about the beam), otherwise
 * only if the needle happens to lie in that window's fixed plane.
 */
export function evaluateFreehandEntry(
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec)
): FreehandResult {
  const path = checkNeedlePath(skin, target);
  const needle = target.clone().sub(skin).normalize();
  const sinTol = Math.sin(THREE.MathUtils.degToRad(IN_PLANE_TOLERANCE_DEG));
  const usable = windows.filter(w => {
    // Within one surface-sample spacing of centred: a slide that small keeps the geometry.
    if (w.lateralMm <= 3) return true;
    const normal = new THREE.Vector3().crossVectors(w.lateral, w.beam).normalize();
    return Math.abs(needle.dot(normal)) <= sinTol;
  });
  if (!usable.length) {
    return { ...path, feasible: false, reasons: [...path.reasons, 'target-not-centerable'] };
  }
  // Best case over usable windows: the needle as far from the beam axis as possible.
  const angle = Math.max(...usable.map(w => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(needle.dot(w.beam)))))));
  const warnings = [...path.warnings];
  if (angle < 20) warnings.push('needle-near-beam-axis');
  return { ...path, warnings, needleBeamAngleDeg: angle };
}

export interface SkinMapCell {
  skin: THREE.Vector3;
  probeOk: boolean;
  needleOk: boolean;
  overRibCage: boolean;
}

/** Feasibility of every skin grid point, for drawing on the skin. */
export function buildSkinMap(
  target: THREE.Vector3,
  stepMm = 10,
  spec: LusProbeSpec = LUS_PROBE
): SkinMapCell[] {
  const windows = findAcousticWindows(target, spec);
  // Thin the windows for the map; the per-click evaluation uses all of them.
  const stride = Math.max(1, Math.floor(windows.length / 250));
  const mapWindows = windows.filter((_, i) => i % stride === 0);
  const cells: SkinMapCell[] = [];
  for (let x = -140; x <= 140; x += stepMm) {
    for (let y = -150; y <= 150; y += stepMm) {
      const skin = getAnteriorSkinSurfacePoint(x, y);
      if (!skin || skin.z < 5) continue; // stay on the anterior abdominal wall
      cells.push({
        skin,
        probeOk: evaluateProbePort(skin, target, spec, mapWindows).feasible,
        needleOk: evaluateFreehandEntry(skin, target, spec, windows).feasible,
        overRibCage: isOverRibCage(x, y)
      });
    }
  }
  return cells;
}

/**
 * Probe pose from `pivot` whose image plane contains the straight needle skin->target,
 * with the target inside the image. Among feasible poses returns the least tip flex
 * (a geometric tie-break). Null with the dominant reason when none exists.
 */
export function poseProbeForNeedle(
  pivot: THREE.Vector3,
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec)
): { solution?: ProbeSolution; reasons: Reason[] } {
  const needle = target.clone().sub(skin).normalize();
  const sinTol = Math.sin(THREE.MathUtils.degToRad(IN_PLANE_TOLERANCE_DEG));
  const failures = new Map<Reason, number>();
  let best: ProbeSolution | undefined;
  for (const window of windows) {
    let axes: THREE.Vector3[];
    if (window.lateralMm <= 3) {
      // Rotate the plane about the beam until it contains the needle.
      const inPlane = tangentProjection(needle, window.beam.clone().negate());
      if (inPlane.lengthSq() < 1e-9) continue; // needle along the beam: any plane, but invisible
      const a = inPlane.normalize();
      axes = [a, a.clone().negate()];
    } else {
      const normal = new THREE.Vector3().crossVectors(window.lateral, window.beam).normalize();
      if (Math.abs(needle.dot(normal)) > sinTol) continue;
      const t = window.lateral.clone().normalize();
      axes = [t, t.clone().negate()];
    }
    for (const axis of axes) {
      const { pose, reason } = tryPose(pivot, window, axis, spec);
      if (!pose) { failures.set(reason!, (failures.get(reason!) ?? 0) + 1); continue; }
      if (!best || pose.flexDeg < best.pose.flexDeg) best = { window, pose };
    }
  }
  if (best) return { solution: best, reasons: [] };
  return { reasons: failures.size ? summarise(failures) : ['target-not-centerable'] };
}
