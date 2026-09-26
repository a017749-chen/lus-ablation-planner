import * as THREE from 'three';
import { LESION_PRESETS, TROCAR_PRESETS } from '../config/presets';
import { LUS_PROBE, LusProbeSpec } from '../config/probe';
import {
  costalMarginPoint,
  isOverRibCage,
  liverValue,
  raySkinIntersection,
  sampleLiverSurface,
  segmentCrossesLiver
} from '../math/anatomyShapes';
import {
  checkNeedlePath,
  evaluateFreehandEntry,
  evaluateProbePort,
  findAcousticWindows,
  solveGuidedNeedle
} from '../math/portPlanner';
import {
  forwardProbe,
  guideLateralAtDepth,
  guideLine,
  guideVisibleDepth,
  inverseProbe,
  isInLinearImage,
  toImage
} from '../math/sideViewProbe';
import { ANTERIOR_SKIN_SURFACE as SKIN, getAnteriorSkinSurfacePoint } from '../math/skinSurface';

type Test = [name: string, body: () => void];
const tests: Test[] = [];
const test = (name: string, body: () => void) => tests.push([name, body]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function near(actual: number, expected: number, tol: number, message: string) {
  assert(Math.abs(actual - expected) <= tol, `${message}: ${actual} vs ${expected}`);
}

const BEAM_30: LusProbeSpec = { ...LUS_PROBE, guide: { ...LUS_PROBE.guide, angleReference: 'beam-axis' } };
const S5 = LESION_PRESETS['S5_S6'].tumorPosition;
const SUBCOSTAL = TROCAR_PRESETS.subcostal;

test('probe forward/inverse kinematics round-trip, including roll and four-way flex', () => {
  let seed = 7;
  const rand = (lo: number, hi: number) => {
    seed = (seed * 16807) % 2147483647;
    return lo + ((seed - 1) / 2147483646) * (hi - lo);
  };
  for (let i = 0; i < 200; i++) {
    const controls = {
      shaftPitchDeg: rand(-50, 50), shaftYawDeg: rand(-50, 50), insertionMm: rand(40, 250),
      rollDeg: rand(-170, 170), flexUpDownDeg: rand(-60, 60), flexLeftRightDeg: rand(-60, 60)
    };
    const pose = forwardProbe(SUBCOSTAL.pivotPosition, SUBCOSTAL.defaultDirection, controls);
    near(pose.arrayAxis.dot(pose.beamDir), 0, 1e-9, 'beam must be perpendicular to the array');
    near(pose.flexDeg, Math.hypot(controls.flexUpDownDeg, controls.flexLeftRightDeg), 1e-6, 'flex angle');
    const back = forwardProbe(SUBCOSTAL.pivotPosition, SUBCOSTAL.defaultDirection,
      inverseProbe(pose, SUBCOSTAL.defaultDirection));
    assert(back.arrayCenter.distanceTo(pose.arrayCenter) < 1e-6, 'array centre round-trip');
    assert(back.beamDir.distanceTo(pose.beamDir) < 1e-6, 'beam direction round-trip');
    assert(back.arrayAxis.distanceTo(pose.arrayAxis) < 1e-6, 'array axis round-trip');
  }
});

test('image plane contains the array axis (side-viewing), unlike the old transverse fan', () => {
  const pose = forwardProbe(SUBCOSTAL.pivotPosition, SUBCOSTAL.defaultDirection,
    { shaftPitchDeg: 0, shaftYawDeg: 0, insertionMm: 100, rollDeg: 0, flexUpDownDeg: 0, flexLeftRightDeg: 0 });
  near(pose.planeNormal.dot(pose.shaftDir), 0, 1e-9, 'a straight probe lies in its own image plane');
  const alongShaft = pose.arrayCenter.clone().addScaledVector(pose.shaftDir, 10);
  near(toImage(pose, alongShaft).w, 0, 1e-9, 'points along the shaft are in plane');
});

test('guide visible depth follows hole offset, image width and angle', () => {
  // Hole 30 mm behind the array centre, 50 mm image, 30 deg from the tip axis:
  // the line enters the image 5 mm from the hole and leaves it 55 mm from it.
  const tip = guideVisibleDepth(LUS_PROBE)!;
  near(tip.min, 5 * Math.tan(Math.PI / 6), 1e-9, 'enters the image');
  near(tip.max, 55 * Math.tan(Math.PI / 6), 1e-9, 'leaves the image');
  near(guideVisibleDepth(BEAM_30)!.max, LUS_PROBE.image.farDepthMm, 1e-9, 'beam-referenced line reaches the far edge');
});

test('guide line in world space matches its image-coordinate formula', () => {
  const pose = forwardProbe(SUBCOSTAL.pivotPosition, SUBCOSTAL.defaultDirection,
    { shaftPitchDeg: 10, shaftYawDeg: -20, insertionMm: 90, rollDeg: 35, flexUpDownDeg: 25, flexLeftRightDeg: -10 });
  for (const spec of [LUS_PROBE, BEAM_30]) {
    const g = guideLine(pose, spec);
    for (const v of [2, 10, 16]) {
      const u = guideLateralAtDepth(v, spec);
      const p = pose.arrayCenter.clone().addScaledVector(pose.arrayAxis, u).addScaledVector(pose.beamDir, v);
      const rel = p.clone().sub(g.hole);
      const off = rel.clone().addScaledVector(g.direction, -rel.dot(g.direction)).length();
      near(off, 0, 1e-9, 'point from the formula lies on the guide line');
      near(toImage(pose, p).w, 0, 1e-9, 'guide line lies in the image plane');
    }
  }
});

test('ray to skin lands on the anterior skin ellipsoid', () => {
  const origin = new THREE.Vector3(-20, 10, 0);
  for (const dir of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(-0.5, 0.3, 0.8), new THREE.Vector3(0.2, -0.6, 0.7)]) {
    const hit = raySkinIntersection(origin, dir);
    assert(hit, 'ray must reach the skin');
    const onSkin = getAnteriorSkinSurfacePoint(hit.x, hit.y);
    assert(onSkin && onSkin.distanceTo(hit) < 1e-6, 'hit lies on the skin surface');
  }
  assert(raySkinIntersection(origin, new THREE.Vector3(0, 0, -1)) === null, 'posterior rays are not modelled');
  assert(SKIN.baseZ < 0, 'sanity');
});

test('analytic liver matches the drawn lobes and detects shafts through it', () => {
  for (const { point, normal } of sampleLiverSurface(10)) {
    near(liverValue(point), 1, 1e-9, 'sample on surface');
    near(normal.length(), 1, 1e-9, 'unit normal');
    assert(liverValue(point.clone().addScaledVector(normal, 2)) > 1, 'normal points outward');
  }
  assert(segmentCrossesLiver(new THREE.Vector3(-200, 25, -10), new THREE.Vector3(80, 25, -10)), 'through the centre');
  assert(!segmentCrossesLiver(new THREE.Vector3(-100, 25, 60), new THREE.Vector3(40, 25, 60)), 'above the liver');
});

test('rib-cage check follows the drawn costal margin', () => {
  for (const t of [-1.2, -0.6, 0, 0.6, 1.2]) {
    const { x, y } = costalMarginPoint(t);
    assert(isOverRibCage(x, y + 3), 'just cranial to the margin is over the ribs');
    assert(!isOverRibCage(x, y - 3), 'just caudal to the margin is abdominal wall');
  }
});

test('every acoustic window really images the target', () => {
  const windows = findAcousticWindows(S5);
  assert(windows.length > 0, 'S5/S6 has windows');
  for (const w of windows) {
    near(liverValue(w.point), 1, 1e-9, 'window on the liver surface');
    assert(w.depthMm >= LUS_PROBE.image.nearDepthMm && w.depthMm <= LUS_PROBE.image.farDepthMm, 'depth in image');
    assert(w.lateralMm <= LUS_PROBE.image.widthMm / 2, 'lateral in image');
  }
});

test('a feasible probe port yields a pose that images the target without crossing the liver', () => {
  const result = evaluateProbePort(SUBCOSTAL.pivotPosition, S5);
  assert(result.feasible && result.leastFlex, 'subcostal reaches S5/S6');
  const { pose } = result.leastFlex;
  const t = toImage(pose, S5);
  assert(Math.abs(t.w) < 0.5, `target in plane (off by ${t.w.toFixed(2)} mm)`);
  assert(isInLinearImage(t.u, t.v), 'target inside the linear image');
  near(liverValue(pose.arrayCenter), 1, 1e-9, 'array lies on the liver surface');
  assert(pose.flexDeg <= LUS_PROBE.maxFlexDeg, 'flex within limit');
  assert(!segmentCrossesLiver(pose.pivot, pose.joint), 'shaft stays outside the liver');
});

test('guided needle: skin entry, hole and target are collinear and the needle reaches the target', () => {
  const result = solveGuidedNeedle(SUBCOSTAL.pivotPosition, S5, BEAM_30);
  assert(result.feasible && result.leastFlex, 'beam-referenced 30 deg guide reaches S5/S6');
  for (const s of result.solutions) {
    const g = guideLine(s.pose, BEAM_30);
    const onSkin = getAnteriorSkinSurfacePoint(s.skinEntry.x, s.skinEntry.y);
    assert(onSkin && onSkin.distanceTo(s.skinEntry) < 1e-6, 'entry on the skin');
    const fromHole = s.skinEntry.clone().sub(g.hole).normalize();
    near(fromHole.dot(g.direction), -1, 1e-9, 'skin entry lies behind the hole on the guide line');
    assert(s.guideMissMm <= 1.5 + 1e-9, `guide passes the target (miss ${s.guideMissMm.toFixed(2)} mm)`);
    const t = toImage(s.pose, S5);
    assert(isInLinearImage(t.u, t.v), 'target visible in the image');
  }
});

test('guided needle with the measured probe reaches S5/S6 and refuses a target deeper than the guide', () => {
  const ok = solveGuidedNeedle(SUBCOSTAL.pivotPosition, S5, LUS_PROBE);
  assert(ok.feasible, 'S5/S6 lies within the 3-32 mm the guide line covers');
  const shallow = { ...LUS_PROBE, image: { ...LUS_PROBE.image, widthMm: 30 },
    guide: { ...LUS_PROBE.guide, holeOffsetMm: 15 } };
  const refused = solveGuidedNeedle(SUBCOSTAL.pivotPosition, S5, shallow);
  assert(!refused.feasible && refused.reasons[0] === 'guide-too-deep', `reason: ${refused.reasons.join(', ')}`);
});

test('needle path checks: length, vessel clearance and tilt fail independently', () => {
  const far = getAnteriorSkinSurfacePoint(100, -100)!;
  assert(checkNeedlePath(far, S5, { usableLengthMm: 50, vesselClearanceMm: 5, maxSkinTiltDeg: 89 }).reasons
    .includes('needle-too-long'), 'short needle');
  const straight = getAnteriorSkinSurfacePoint(S5.x, S5.y)!;
  const r = checkNeedlePath(straight, S5);
  assert(!r.reasons.includes('needle-tilt'), 'a needle straight down is not tilted');
  const free = evaluateFreehandEntry(straight, S5);
  assert(free.needleBeamAngleDeg !== undefined || free.reasons.length > 0, 'result explains itself');
});

let failed = 0;
for (const [name, body] of tests) {
  try {
    body();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL: ${name}\n      ${(error as Error).message}`);
  }
}
if (failed) {
  console.log(`\n${failed} of ${tests.length} planner tests failed.`);
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
}
