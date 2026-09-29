import * as THREE from 'three';
import { LUS_PROBE, LusProbeSpec, NEEDLE_SPEC, NeedleSpec } from '../config/probe';
import {
  isOverRibCage,
  liverNormal,
  liverValue,
  LiverSurfaceSample,
  raySkinIntersection,
  sampleLiverSurface,
  segmentCrossesLiver
} from './anatomyShapes';
import { getPatientAnatomyContext } from './anatomyContext';
import { CollisionDetector } from './collision';
import { getAnteriorSkinSurfaceNormal, getAnteriorSkinSurfacePoint } from './skinSurface';
import { guideLateralAtDepth, guideLine, isInLinearImage, poseFromParts, ProbePose, toImage } from './sideViewProbe';

/**
 * Skin port planning for LUS-guided ablation.
 *
 * It answers "can this skin point work, and if not, why" - it never ranks or
 * recommends. Where one geometric solution must be picked to pose the probe, the
 * tie-breaker (least tip flex) is stated as a geometric choice, not a clinical one.
 * Illustrative geometry is the demo default; reviewed patient masks override anatomy
 * queries when patient mode is active.
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
  | 'shaft-through-rib'
  | 'guide-misses-target'
  | 'guide-too-deep'
  | 'no-skin-exit'
  | 'needle-too-long'
  | 'vessel-too-close'
  | 'needle-through-rib'
  | 'needle-crosses-liver-before-hole'
  | 'target-not-centerable'
  | 'needle-hits-probe'
  | 'needle-blind-in-liver'
  | 'needle-too-steep';

export type Warning = 'over-rib-cage' | 'needle-near-beam-axis' | 'rib-path-not-evaluable';

export const REASON_TEXT: Record<Reason | Warning, string> = {
  'no-window': '肝表面找不到能讓腫瘤進入影像的聲窗',
  'too-far': '探頭伸不到（超過桿長）',
  'trocar-tilt': '套管需要傾斜超過上限（太貼近腹壁）',
  'shaft-outside-body': '探頭桿會跑出腹壁外',
  'needle-tilt': '針與皮膚夾角太斜',
  'flex-limit': '尖端需要彎超過上限',
  'shaft-through-liver': '探頭桿會穿過肝臟',
  'shaft-through-rib': '探頭／套管路徑與病人肋骨分割相交',
  'guide-misses-target': '導引線對不到腫瘤',
  'guide-too-deep': '腫瘤超出導引線在影像內的深度範圍',
  'no-skin-exit': '導引線往回延伸碰不到前腹壁',
  'needle-too-long': '針長不夠',
  'vessel-too-close': '針道距血管太近',
  'needle-through-rib': '針道與病人肋骨分割相交',
  'needle-crosses-liver-before-hole': '針在到達導引孔前就穿過肝臟',
  'target-not-centerable': '沒有任何聲窗的影像面能同時包含這條針道',
  'needle-hits-probe': '針會碰到探頭（要從探頭尖端旁邊進肝）',
  'needle-blind-in-liver': '針在肝內有一段跑在影像外，看不到',
  'needle-too-steep': '針太接近聲束方向，影像上看不清楚',
  'over-rib-cage': '在肋骨區上方（需經肋間）',
  'needle-near-beam-axis': '針幾乎與聲束平行，影像上不易看見',
  'rib-path-not-evaluable': '未提供 patient-specific ribs，完整肋骨路徑碰撞不可評估'
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

/** True when a point lies under the active anterior abdominal wall. */
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
  const patient = getPatientAnatomyContext();
  if (patient?.ribPathStatus?.(pivot, joint, spec.shaftDiameterMm / 2) === 'crosses') {
    return { reason: 'shaft-through-rib' };
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
  const patient = getPatientAnatomyContext();
  if (patient) {
    const ribStatus = patient.ribProjectionStatus
      ? patient.ribProjectionStatus(pivot.x, pivot.y)
      : patient.ribCageStatus(pivot);
    if (ribStatus === 'not-evaluable') warnings.push('rib-path-not-evaluable');
  }
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
  const patient = getPatientAnatomyContext();
  if (patient) {
    const ribPath = patient.ribPathStatus
      ? patient.ribPathStatus(skin, target, CollisionDetector.NEEDLE_RADIUS_MM)
      : 'not-evaluable';
    if (ribPath === 'crosses') reasons.push('needle-through-rib');
    else if (ribPath === 'not-evaluable') warnings.push('rib-path-not-evaluable');
  }
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
    let axes: THREE.Vector3[];
    let miss: number;
    if (window.lateralMm > 0.75) {
      const side = Math.sign(needU) || 1;
      axes = [window.lateral.clone().normalize().multiplyScalar(side)];
      miss = Math.abs(window.lateralMm * side - needU);
    } else {
      axes = candidateAxes(pivot, window);
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

export const IN_PLANE_TOLERANCE_DEG = 3;

function inPlaneFrame(
  window: AcousticWindow,
  target: THREE.Vector3,
  needle: THREE.Vector3,
  spec: LusProbeSpec
): { window: AcousticWindow; axes: THREE.Vector3[] } | null {
  const toTarget = target.clone().sub(window.point);
  const n = new THREE.Vector3().crossVectors(toTarget, needle);
  if (n.lengthSq() < 1e-9) return null;
  n.normalize();
  if (Math.abs(n.dot(window.beam)) > Math.sin(THREE.MathUtils.degToRad(IN_PLANE_TOLERANCE_DEG))) return null;
  const beam = window.beam.clone().addScaledVector(n, -window.beam.dot(n)).normalize();
  const axis = new THREE.Vector3().crossVectors(beam, n).normalize();
  const u = toTarget.dot(axis);
  const v = toTarget.dot(beam);
  if (!isInLinearImage(u, v, spec)) return null;
  return {
    window: { point: window.point, beam, depthMm: v, lateral: axis.clone().multiplyScalar(u), lateralMm: Math.abs(u) },
    axes: [axis, axis.clone().negate()]
  };
}

export function evaluateFreehandEntry(
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec)
): FreehandResult {
  const path = checkNeedlePath(skin, target);
  const needle = target.clone().sub(skin).normalize();
  const usable = windows.flatMap(w => inPlaneFrame(w, target, needle, spec)?.window ?? []);
  if (!usable.length) {
    return { ...path, feasible: false, reasons: [...path.reasons, 'target-not-centerable'] };
  }
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

export function buildSkinMap(
  target: THREE.Vector3,
  stepMm = 10,
  spec: LusProbeSpec = LUS_PROBE,
  probePivot?: THREE.Vector3
): SkinMapCell[] {
  const windows = findAcousticWindows(target, spec);
  const stride = Math.max(1, Math.floor(windows.length / 250));
  const mapWindows = windows.filter((_, i) => i % stride === 0);
  const cells: SkinMapCell[] = [];
  for (let x = -140; x <= 140; x += stepMm) {
    for (let y = -150; y <= 150; y += stepMm) {
      const skin = getAnteriorSkinSurfacePoint(x, y);
      if (!skin || skin.z < 5) continue;
      cells.push({
        skin,
        probeOk: evaluateProbePort(skin, target, spec, mapWindows).feasible,
        needleOk: probePivot
          ? !!evaluateFreehandPlan(probePivot, skin, target, spec, windows, FREEHAND_LIMITS,
            REFINEMENT.fineBlindStepMm).entry
          : evaluateFreehandEntry(skin, target, spec, windows).feasible,
        overRibCage: isOverRibCage(x, y)
      });
    }
  }
  return cells;
}

export const FREEHAND_LIMITS = {
  maxBlindMm: 10,
  probeClearanceMm: 3,
  minNeedleBeamDeg: 20
};

export function segmentDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let u = 0;
  if (a < 1e-12 && e < 1e-12) return r.length();
  if (a < 1e-12) {
    u = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e < 1e-12) {
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      u = (b * s + f) / e;
      if (u < 0) { u = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (u > 1) { u = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = p1.clone().addScaledVector(d1, s);
  const c2 = p2.clone().addScaledVector(d2, u);
  return c1.distanceTo(c2);
}

export function needleProbeGapMm(pose: ProbePose, skin: THREE.Vector3, target: THREE.Vector3, spec: LusProbeSpec = LUS_PROBE): number {
  const r = spec.shaftDiameterMm / 2;
  const behind = pose.beamDir.clone().multiplyScalar(-r);
  const tipStart = pose.joint.clone().add(behind);
  const tipEnd = pose.arrayCenter.clone().addScaledVector(pose.arrayAxis, spec.arrayLengthMm / 2).add(behind);
  return Math.min(
    segmentDistance(skin, target, pose.pivot, pose.joint),
    segmentDistance(skin, target, tipStart, tipEnd)
  ) - r;
}

export function blindIntrahepaticMm(
  pose: ProbePose,
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  stepMm = 1
): number {
  const length = skin.distanceTo(target);
  const n = Math.max(2, Math.ceil(length / stepMm));
  const piece = length / n;
  const p = new THREE.Vector3();
  let blind = 0;
  for (let i = 0; i < n; i++) {
    p.lerpVectors(skin, target, (i + 0.5) / n);
    if (liverValue(p) >= 1) continue;
    const { u, v } = toImage(pose, p);
    if (!isInLinearImage(u, v, spec)) blind += piece;
  }
  return blind;
}

export interface FreehandPose extends ProbeSolution {
  needleBeamAngleDeg: number;
  blindMm: number;
  probeGapMm: number;
}

export function poseProbeForNeedle(
  pivot: THREE.Vector3,
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec),
  limits = FREEHAND_LIMITS,
  blindStepMm = 1
): { solution?: FreehandPose; reasons: Reason[] } {
  const needle = target.clone().sub(skin).normalize();
  const failures = new Map<Reason, number>();
  const fail = (r: Reason) => failures.set(r, (failures.get(r) ?? 0) + 1);
  let best: FreehandPose | undefined;
  for (const surfaceWindow of windows) {
    const frame = inPlaneFrame(surfaceWindow, target, needle, spec);
    if (!frame) continue;
    const { window, axes } = frame;
    for (const axis of axes) {
      const { pose, reason } = tryPose(pivot, window, axis, spec);
      if (!pose) { fail(reason!); continue; }
      if (best && pose.flexDeg >= best.pose.flexDeg) continue;
      const probeGapMm = needleProbeGapMm(pose, skin, target, spec);
      if (probeGapMm < limits.probeClearanceMm) { fail('needle-hits-probe'); continue; }
      const needleBeamAngleDeg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(needle.dot(pose.beamDir)))));
      if (needleBeamAngleDeg < limits.minNeedleBeamDeg) { fail('needle-too-steep'); continue; }
      const blindMm = blindIntrahepaticMm(pose, skin, target, spec, blindStepMm);
      if (blindMm > limits.maxBlindMm) { fail('needle-blind-in-liver'); continue; }
      best = { window, pose, needleBeamAngleDeg, blindMm, probeGapMm };
    }
  }
  if (best) return { solution: best, reasons: [] };
  return { reasons: failures.size ? summarise(failures) : ['target-not-centerable'] };
}

export interface FreehandPlanEntry {
  skin: THREE.Vector3;
  needle: NeedlePathCheck;
  probe: FreehandPose;
  warnings: Warning[];
}

export function evaluateFreehandPlan(
  pivot: THREE.Vector3,
  skin: THREE.Vector3,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec),
  limits = FREEHAND_LIMITS,
  blindStepMm = 1
): { entry?: FreehandPlanEntry; needle: NeedlePathCheck; reasons: Reason[] } {
  const needle = checkNeedlePath(skin, target);
  if (!needle.feasible) return { needle, reasons: needle.reasons };
  const { solution, reasons } = poseProbeForNeedle(pivot, skin, target, spec, windows, limits, blindStepMm);
  if (!solution) return { needle, reasons };
  return { entry: { skin, needle, probe: solution, warnings: needle.warnings }, needle, reasons: [] };
}

export const REFINEMENT = {
  skinToleranceMm: 2,
  skinStepMm: 1,
  fineBlindStepMm: 0.1
};

export interface Margin {
  value: number;
  limit: number;
  margin: number;
}

export interface FreehandMargins {
  probeGap: Margin;
  blind: Margin;
  needleBeam: Margin;
  rock: Margin;
  vessel: Margin;
  needleLength: Margin;
  flex: Margin;
}

const atLeast = (value: number, limit: number): Margin => ({ value, limit, margin: value - limit });
const atMost = (value: number, limit: number): Margin => ({ value, limit, margin: limit - value });

export function freehandMargins(
  entry: FreehandPlanEntry,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  limits = FREEHAND_LIMITS,
  needle: NeedleSpec = NEEDLE_SPEC
): FreehandMargins {
  const pose = entry.probe.pose;
  const rock = THREE.MathUtils.radToDeg(pose.beamDir.angleTo(liverNormal(entry.probe.window.point).negate()));
  return {
    probeGap: atLeast(needleProbeGapMm(pose, entry.skin, target, spec), limits.probeClearanceMm),
    blind: atMost(blindIntrahepaticMm(pose, entry.skin, target, spec, REFINEMENT.fineBlindStepMm), limits.maxBlindMm),
    needleBeam: atLeast(entry.probe.needleBeamAngleDeg, limits.minNeedleBeamDeg),
    rock: atMost(rock, IN_PLANE_TOLERANCE_DEG),
    vessel: atLeast(entry.needle.vesselClearanceMm, needle.vesselClearanceMm),
    needleLength: atMost(entry.needle.lengthMm, needle.usableLengthMm),
    flex: atMost(pose.flexDeg, spec.maxFlexDeg)
  };
}

export interface RefinedFreehandEntry extends FreehandPlanEntry {
  margins: FreehandMargins;
  robust: boolean;
}

export function refineFreehandEntry(
  pivot: THREE.Vector3,
  coarse: FreehandPlanEntry,
  target: THREE.Vector3,
  spec: LusProbeSpec = LUS_PROBE,
  windows: AcousticWindow[] = findAcousticWindows(target, spec),
  limits = FREEHAND_LIMITS
): RefinedFreehandEntry | null {
  const fine = evaluateFreehandPlan(pivot, coarse.skin, target, spec, windows, limits, REFINEMENT.fineBlindStepMm);
  if (!fine.entry) return null;
  const { skinToleranceMm: r, skinStepMm: step } = REFINEMENT;
  let robust = true;
  for (let dx = -r; dx <= r + 1e-9 && robust; dx += step) {
    for (let dy = -r; dy <= r + 1e-9 && robust; dy += step) {
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
      const p = getAnteriorSkinSurfacePoint(coarse.skin.x + dx, coarse.skin.y + dy);
      robust = !!p && !!evaluateFreehandPlan(pivot, p, target, spec, windows, limits, REFINEMENT.fineBlindStepMm).entry;
    }
  }
  return { ...fine.entry, margins: freehandMargins(fine.entry, target, spec, limits), robust };
}

export interface FreehandPlan {
  feasible: boolean;
  reasons: Reason[];
  entries: RefinedFreehandEntry[];
  coarseCount: number;
  checkedCount: number;
}

export function solveFreehandNeedle(
  pivot: THREE.Vector3,
  target: THREE.Vector3,
  stepMm = 10,
  spec: LusProbeSpec = LUS_PROBE,
  limits = FREEHAND_LIMITS
): FreehandPlan {
  const windows = findAcousticWindows(target, spec);
  const failures = new Map<Reason, number>();
  const fail = (r: Reason | undefined) => { if (r) failures.set(r, (failures.get(r) ?? 0) + 1); };
  const coarse: FreehandPlanEntry[] = [];
  let checkedCount = 0;
  for (let x = -140; x <= 140; x += stepMm) {
    for (let y = -150; y <= 150; y += stepMm) {
      const skin = getAnteriorSkinSurfacePoint(x, y);
      if (!skin || skin.z < 5) continue;
      checkedCount++;
      const result = evaluateFreehandPlan(pivot, skin, target, spec, windows, limits);
      if (result.entry) coarse.push(result.entry);
      else fail(result.reasons[0]);
    }
  }
  const entries: RefinedFreehandEntry[] = [];
  for (const candidate of coarse) {
    const refined = refineFreehandEntry(pivot, candidate, target, spec, windows, limits);
    if (refined) entries.push(refined);
    else fail('needle-blind-in-liver');
  }
  entries.sort((a, b) => a.needle.lengthMm - b.needle.lengthMm);
  return {
    feasible: entries.length > 0,
    reasons: entries.length ? [] : summarise(failures),
    entries,
    coarseCount: coarse.length,
    checkedCount
  };
}
