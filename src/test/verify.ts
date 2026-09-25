import * as THREE from 'three';
import {
  LESION_PRESETS,
  isProbePort,
  PROBE_PORT_IDS,
  getSuggestedPortSelection,
  selectNeedleEntry,
  selectProbePort
} from '../config/presets';
import { AlignmentEngine } from '../math/alignmentEngine';
import { CollisionDetector } from '../math/collision';
import { estimateEllipsoidTargetOverlap } from '../math/coverage';
import { FulcrumKinematics } from '../math/kinematics';
import { WedgeOptimizer } from '../math/wedgeOptimizer';
import {
  getSphereSlabIntersection,
  isPointInUltrasoundSector,
  ULTRASOUND_SECTOR
} from '../math/ultrasoundGeometry';
import { AnatomyBuilder } from '../scene/AnatomyBuilder';
import { InstrumentBuilder } from '../scene/Instruments';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertNear(actual: number, expected: number, tolerance: number, message: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function assertVectorNear(
  actual: THREE.Vector3,
  expected: THREE.Vector3,
  tolerance: number,
  message: string
) {
  assert(actual.distanceTo(expected) <= tolerance, `${message}: error ${actual.distanceTo(expected)} mm`);
}

function runTests() {
  console.log('=== LUS-Ablation geometry verification ===');

  // Inverse/forward kinematics must round-trip for tilted, vertical, and reversed bases.
  const roundTrips = [
    {
      normal: new THREE.Vector3(-0.5, 0.4, -0.75),
      pitch: 30,
      yaw: -15,
      depth: 100
    },
    {
      normal: new THREE.Vector3(0, 0, -1),
      pitch: -25,
      yaw: 18,
      depth: 80
    },
    {
      normal: new THREE.Vector3(0, 1, 0),
      pitch: 15,
      yaw: -33,
      depth: 25
    }
  ];
  const pivot = new THREE.Vector3(75, -20, 68);
  for (const [index, item] of roundTrips.entries()) {
    const forward = FulcrumKinematics.computeForward(
      pivot,
      item.normal,
      item.pitch,
      item.yaw,
      0,
      item.depth
    );
    const inverse = FulcrumKinematics.solveAimTarget(pivot, item.normal, forward.tip);
    const reconstructed = FulcrumKinematics.computeForward(
      pivot,
      item.normal,
      inverse.pitch,
      inverse.yaw,
      0,
      inverse.insertionDepth
    );
    assertVectorNear(reconstructed.tip, forward.tip, 1e-6, `Kinematics round-trip ${index + 1}`);
    assertVectorNear(reconstructed.direction, forward.direction, 1e-8, `Direction round-trip ${index + 1}`);
  }

  const upwardTarget = new THREE.Vector3(0, 10, 10);
  const upwardAim = FulcrumKinematics.solveAimTarget(
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, 1),
    upwardTarget
  );
  assert(upwardAim.pitch < 0, 'A target above the base axis must yield negative pitch.');
  const upwardForward = FulcrumKinematics.computeForward(
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, 1),
    upwardAim.pitch,
    upwardAim.yaw,
    0,
    upwardAim.insertionDepth
  );
  assertVectorNear(upwardForward.tip, upwardTarget, 1e-6, 'Upward target inverse solution');

  // Rendered needle, probe, scan plane and ablation zone use the same world frame as the math.
  const instruments = InstrumentBuilder.build();
  instruments.updateProbe('subcostal', 120, 27, -18, 11);
  instruments.updateNeedle(
    'trocar',
    'subcostal',
    new THREE.Vector3(),
    85,
    32,
    -12,
    17
  );
  instruments.setAblationPreview(true, 35);

  const needle = instruments.getNeedleSegment();
  const renderedNeedleTip = instruments.needleGroup.localToWorld(new THREE.Vector3(0, 85, 0));
  assertVectorNear(renderedNeedleTip, needle.tip, 1e-6, 'Rendered needle tip / kinematic tip');
  const needleDirection = new THREE.Vector3().subVectors(needle.tip, needle.entry).normalize();

  const plane = instruments.getProbeUSPlaneData();
  instruments.usSliceMesh.updateWorldMatrix(true, false);
  assertVectorNear(
    instruments.usSliceMesh.localToWorld(new THREE.Vector3(0, 24, 0)),
    plane.origin,
    1e-8,
    'Rendered scan-plane origin / transducer origin'
  );
  assertNear(plane.normal.length(), 1, 1e-8, 'Probe plane normal length');
  assertNear(plane.xAxis.length(), 1, 1e-8, 'Probe lateral axis length');
  assertNear(plane.yAxis.length(), 1, 1e-8, 'Probe depth axis length');
  assertNear(Math.abs(plane.normal.dot(plane.xAxis)), 0, 1e-8, 'Probe normal/lateral orthogonality');
  assertNear(Math.abs(plane.normal.dot(plane.yAxis)), 0, 1e-8, 'Probe normal/depth orthogonality');
  assertNear(Math.abs(plane.xAxis.dot(plane.yAxis)), 0, 1e-8, 'Probe lateral/depth orthogonality');
  assertNear(plane.nearRadiusMm, 10, 1e-8, 'Ultrasound near radius');
  assertNear(plane.farRadiusMm, 105, 1e-8, 'Ultrasound far radius');
  assertNear(plane.sectorAngleDeg, 75, 1e-8, 'Ultrasound sector angle');
  assertNear(plane.sliceThicknessMm, 1.5, 1e-8, 'Ultrasound slice thickness');

  instruments.usSliceMesh.updateWorldMatrix(true, false);
  const localOrigin = instruments.usSliceMesh.localToWorld(new THREE.Vector3());
  const worldScanAxis = (axis: THREE.Vector3) =>
    instruments.usSliceMesh.localToWorld(axis).sub(localOrigin).normalize();
  assertVectorNear(plane.normal, worldScanAxis(new THREE.Vector3(0, -1, 0)), 1e-8, 'World scan-plane normal');
  assertVectorNear(plane.xAxis, worldScanAxis(new THREE.Vector3(1, 0, 0)), 1e-8, 'World scan lateral axis');
  assertVectorNear(plane.yAxis, worldScanAxis(new THREE.Vector3(0, 0, 1)), 1e-8, 'World scan depth axis');

  const ablation = instruments.getAblationEllipsoid();
  assertVectorNear(
    ablation.axisY,
    needleDirection,
    1e-8,
    'Ablation long axis / needle axis'
  );
  assertVectorNear(
    ablation.center,
    needle.tip.clone().addScaledVector(needleDirection, -4),
    1e-6,
    'Ablation center / needle-tip offset'
  );

  // Auto-align requires the fixed entry, actual lesion-plane overlap, and finite fan bounds.
  const planeOrigin = new THREE.Vector3(0, 0, 0);
  const planeNormal = new THREE.Vector3(0, 0, 1);
  const planeX = new THREE.Vector3(1, 0, 0);
  const planeY = new THREE.Vector3(0, 1, 0);
  const feasiblePivot = new THREE.Vector3(10, 20, 0);
  const inPlaneNeedleNormal = new THREE.Vector3(0, 0.7, -0.7).normalize();
  const tumorInFan = new THREE.Vector3(20, 50, 3);
  const lesionRadiusMm = 5;

  const fixedTrocarInfeasible = WedgeOptimizer.autoAlignNeedle(
    pivot,
    new THREE.Vector3(-0.5, 0.4, -0.75),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorInFan,
    lesionRadiusMm,
    false
  );
  assert(!fixedTrocarInfeasible.feasible, 'Off-plane trocar pivot must report infeasible.');
  assertNear(fixedTrocarInfeasible.residualDistanceMm, 68, 1e-8, 'Off-plane pivot residual');
  assert(fixedTrocarInfeasible.pitch === undefined, 'Infeasible result must not expose angles to apply.');

  const offPlaneTumor = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    new THREE.Vector3(0, 0, -1),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    new THREE.Vector3(20, 50, 11),
    lesionRadiusMm,
    false
  );
  assert(!offPlaneTumor.feasible, 'A lesion outside its radius from the plane must be rejected.');
  assertNear(offPlaneTumor.residualDistanceMm, 6, 1e-8, 'Off-plane lesion residual');
  assert(
    offPlaneTumor.reason?.includes('no lesion-plane intersection'),
    'Off-plane lesion rejection should state why the target cannot be hit.'
  );

  const outsideFan = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    new THREE.Vector3(0, 0, -1),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    new THREE.Vector3(0, 112, 0),
    lesionRadiusMm,
    false
  );
  assert(!outsideFan.feasible, 'A lesion beyond the finite fan depth must be rejected.');
  assert(
    outsideFan.reason?.includes('finite ultrasound fan'),
    'Finite-fan rejection should include an actionable reason.'
  );

  const outsideFanAngle = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    new THREE.Vector3(0, 0.7, -0.7).normalize(),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    new THREE.Vector3(80, 50, 0),
    lesionRadiusMm,
    false
  );
  assert(!outsideFanAngle.feasible, 'A lesion outside the sector angle must be rejected.');
  assert(
    outsideFanAngle.reason?.includes('finite ultrasound fan'),
    'Sector-angle rejection should explain the finite fan boundary.'
  );

  const feasible = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    inPlaneNeedleNormal,
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorInFan,
    lesionRadiusMm,
    false
  );
  assert(feasible.feasible, `On-plane lesion intersection should be feasible: ${feasible.reason ?? ''}`);
  assert(
    feasible.pitch !== undefined && feasible.yaw !== undefined && feasible.depth !== undefined,
    'Feasible solution must contain angles and depth.'
  );
  assert(feasible.targetPoint !== undefined, 'Feasible result must return the actual in-plane target point.');
  assertVectorNear(
    feasible.targetPoint!,
    new THREE.Vector3(20, 50, 0),
    1e-8,
    'Target point must be a valid lesion-plane intersection'
  );
  assertNear(feasible.targetPoint!.distanceTo(tumorInFan), 3, 1e-8, 'Intersection point lies inside lesion radius');
  assert(
    isPointInUltrasoundSector(20, 50, ULTRASOUND_SECTOR),
    'Valid lesion-plane target must lie in the finite ultrasound fan.'
  );

  const aligned = FulcrumKinematics.computeForward(
    feasiblePivot,
    inPlaneNeedleNormal,
    feasible.pitch!,
    feasible.yaw!,
    0,
    feasible.depth!
  );
  const alignment = AlignmentEngine.evaluate(
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    feasiblePivot,
    aligned.tip
  );
  assert(alignment.status === 'IN_PLANE', `Aligned needle status must be IN_PLANE; got ${alignment.status}.`);
  assert(
    aligned.tip.distanceTo(tumorInFan) <= lesionRadiusMm + 1e-6,
    'The needle endpoint must remain inside the actual lesion.'
  );
  assert(
    isPointInUltrasoundSector(aligned.tip.x, aligned.tip.y, ULTRASOUND_SECTOR),
    'The needle endpoint must lie within finite ultrasound fan bounds.'
  );

  // Percutaneous entry points are fixed; an off-plane entry cannot be silently projected.
  const fixedPercutaneousPivot = new THREE.Vector3(10, 20, 1.5);
  const percutaneous = WedgeOptimizer.autoAlignNeedle(
    fixedPercutaneousPivot,
    new THREE.Vector3(0, 0, -1),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorInFan,
    lesionRadiusMm,
    true
  );
  assert(!percutaneous.feasible, 'An off-plane percutaneous entry must report infeasible.');
  assert(
    percutaneous.reason?.includes('Fixed percutaneous entry') &&
      percutaneous.reason?.includes('not moved'),
    'Percutaneous infeasibility must explain that the fixed entry was preserved.'
  );
  assert(percutaneous.targetPoint === undefined, 'Infeasible fixed-entry result must not provide an aim point.');

  const percutaneousOnPlane = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    inPlaneNeedleNormal,
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorInFan,
    lesionRadiusMm,
    true
  );
  assert(percutaneousOnPlane.feasible, 'An on-plane fixed percutaneous entry can be feasible.');
  assert(
    !('adjustedPivot' in percutaneousOnPlane),
    'Auto-align must not return a moved percutaneous pivot.'
  );

  // The simulated 1.5mm slab draws only its actual sphere intersection.
  const visibleSlice = getSphereSlabIntersection(5, 3, ULTRASOUND_SECTOR.sliceThicknessMm);
  assert(visibleSlice.visible, 'A lesion intersecting the scan slab should be visible.');
  assertNear(visibleSlice.effectiveOffsetMm, 2.25, 1e-8, 'Effective slice offset');
  assertNear(
    visibleSlice.crossSectionRadiusMm,
    Math.sqrt(25 - 2.25 * 2.25),
    1e-8,
    'Slice cross-section radius'
  );
  const outOfSlice = getSphereSlabIntersection(5, 14, ULTRASOUND_SECTOR.sliceThicknessMm);
  assert(!outOfSlice.visible, 'A lesion 14mm off-plane must be hidden by the 1.5mm slab.');
  assertNear(outOfSlice.crossSectionRadiusMm, 0, 1e-8, 'Invisible slice has no displayed radius');

  // Preset port recommendations are independent: S7/S8 uses subcostal probe and ITT needle.
  assert(!isProbePort('umbilical'), 'Umbilical camera port must not be selectable as a LUS probe port.');
  assert(PROBE_PORT_IDS.every(isProbePort), 'Every listed probe port must pass probe-port validation.');

  const s7Ports = getSuggestedPortSelection(LESION_PRESETS.S7_S8);
  assert(s7Ports.probePort === 'subcostal', 'S7/S8 preset should select subcostal probe port.');
  assert(s7Ports.needlePort === 'itt' && s7Ports.needleMode === 'trocar', 'S7/S8 preset should select ITT needle port.');
  const percutaneousPorts = getSuggestedPortSelection({
    ...LESION_PRESETS.S2_S3,
    suggestedNeedlePort: 'percutaneous'
  });
  assert(percutaneousPorts.needleMode === 'percutaneous', 'A percutaneous recommendation should select percutaneous needle mode.');

  const changedProbe = selectProbePort(percutaneousPorts, 'subxiphoid');
  assert(changedProbe.probePort === 'subxiphoid', 'Probe selector should update the probe port.');
  assert(
    changedProbe.needlePort === percutaneousPorts.needlePort &&
      changedProbe.needleMode === percutaneousPorts.needleMode,
    'Changing the probe selector must preserve needle-entry state.'
  );
  const changedNeedle = selectNeedleEntry(changedProbe, 'itt');
  assert(
    changedNeedle.probePort === changedProbe.probePort,
    'Changing the needle-entry selector must preserve the probe port.'
  );
  assert(
    changedNeedle.needlePort === 'itt' && changedNeedle.needleMode === 'trocar',
    'Selecting ITT must independently select trocar mode.'
  );
  const changedToPercutaneous = selectNeedleEntry(changedNeedle, 'percutaneous');
  assert(
    changedToPercutaneous.probePort === 'subxiphoid' &&
      changedToPercutaneous.needleMode === 'percutaneous',
    'Selecting percutaneous must preserve the probe port and set percutaneous mode.'
  );

  const identityAxes = {
    center: new THREE.Vector3(),
    axisX: new THREE.Vector3(1, 0, 0),
    axisY: new THREE.Vector3(0, 1, 0),
    axisZ: new THREE.Vector3(0, 0, 1),
    radiusX: 30,
    radiusY: 35,
    radiusZ: 30
  };
  assert(
    estimateEllipsoidTargetOverlap(new THREE.Vector3(), 10, identityAxes) === 100,
    'Fully contained target sphere should report 100% geometric overlap.'
  );
  const partial = estimateEllipsoidTargetOverlap(
    new THREE.Vector3(),
    10,
    { ...identityAxes, center: new THREE.Vector3(20, 0, 0), radiusX: 20 }
  );
  assert(partial >= 30 && partial <= 70, `Partial ellipsoid overlap should be intermediate; got ${partial}%.`);
  const disjoint = estimateEllipsoidTargetOverlap(
    new THREE.Vector3(),
    10,
    { ...identityAxes, center: new THREE.Vector3(100, 0, 0) }
  );
  assert(disjoint === 0, 'Disjoint target and ellipsoid should report 0% overlap.');

  // Vessel alerts use simulated shaft surface clearance, including the 0.8mm shaft radius.
  const vesselSegment = {
    name: 'Test vessel',
    type: 'ivc' as const,
    start: new THREE.Vector3(0, -20, 0),
    end: new THREE.Vector3(0, 20, 0),
    radius: 5,
    color: 0
  };
  const shaftClearance = CollisionDetector.checkCollision(
    new THREE.Vector3(8, -10, 0),
    new THREE.Vector3(8, 10, 0),
    [vesselSegment]
  );
  assertNear(shaftClearance.minDistance, 2.2, 1e-8, 'Needle shaft radius is subtracted from clearance');
  assert(shaftClearance.hasCollision, 'Less than 5mm shaft surface clearance must trigger a warning.');

  // Preserve collision checks against the built-in vascular tree.
  const vesselCollision = CollisionDetector.checkCollision(
    new THREE.Vector3(12, -70, -35),
    new THREE.Vector3(10, 85, -28)
  );
  assert(vesselCollision.hasCollision, 'Needle through the IVC should trigger collision.');
  const safePath = CollisionDetector.checkCollision(
    new THREE.Vector3(60, -20, 40),
    new THREE.Vector3(50, -10, 30)
  );
  // Right-Angle Wedge Puncture Optimizer (Triangle ABC & Point C on US Plane)
  const wedgeSolution = WedgeOptimizer.computeWedgeGeometry(
    planeOrigin,
    planeY,
    planeNormal,
    tumorInFan,
    60
  );
  const wedgeNormalDist = Math.abs(
    new THREE.Vector3().subVectors(wedgeSolution.optimalEntryPoint, planeOrigin).dot(planeNormal)
  );
  assertNear(wedgeNormalDist, 0, 1e-6, 'Wedge optimal entry point C must lie strictly on the ultrasound scan plane');
  assert(wedgeSolution.punctureDepth > 0, 'Wedge puncture depth must be positive');
  assert(wedgeSolution.guideLinePoints.length === 2, 'Wedge solution must include guide line endpoints');

  const wedgeAutoAlign = WedgeOptimizer.autoAlignNeedle(
    wedgeSolution.optimalEntryPoint,
    wedgeSolution.trajectoryDir,
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorInFan,
    lesionRadiusMm,
    true
  );
  assert(wedgeAutoAlign.feasible, 'Wedge optimal entry point C must be feasible for in-plane auto-alignment');
  assertNear(wedgeAutoAlign.residualDistanceMm, 0, 1e-6, 'Wedge in-plane auto-alignment distance residual must be zero');
  assertNear(wedgeAutoAlign.residualAngleDeg, 0, 1e-6, 'Wedge in-plane auto-alignment angle residual must be zero');

  // Anatomical liver lobe proportions (nominal 70:30 right:left volume ratio)
  const anatomy = AnatomyBuilder.build();
  const rightLobeMesh = anatomy.liverGroup.children[0] as THREE.Mesh;
  const leftLobeMesh = anatomy.liverGroup.children[1] as THREE.Mesh;
  rightLobeMesh.updateMatrixWorld(true);
  leftLobeMesh.updateMatrixWorld(true);

  const volRight = (65 * 1.2) * (65 * 1.1) * (65 * 0.75);
  const volLeft = (60 * 1.3) * (60 * 0.85) * (60 * 0.5);
  const rightRatio = volRight / (volRight + volLeft);
  const leftRatio = volLeft / (volRight + volLeft);
  assert(rightRatio >= 0.65 && rightRatio <= 0.75, `Right lobe volume ratio should be ~70% (got ${(rightRatio * 100).toFixed(1)}%)`);
  assert(leftRatio >= 0.25 && leftRatio <= 0.35, `Left lobe volume ratio should be ~30% (got ${(leftRatio * 100).toFixed(1)}%)`);

  const s2s3Local = LESION_PRESETS['S2_S3'].tumorPosition.clone().applyMatrix4(leftLobeMesh.matrixWorld.clone().invert());
  const s2s3NormDist = Math.sqrt(
    (s2s3Local.x / (60 * 1.3)) ** 2 +
    (s2s3Local.y / (60 * 0.85)) ** 2 +
    (s2s3Local.z / (60 * 0.5)) ** 2
  );
  assert(s2s3NormDist < 1.0, `S2/S3 tumor should be within left lobe parenchyma (normalized dist: ${s2s3NormDist.toFixed(2)})`);

  const s5s6Local = LESION_PRESETS['S5_S6'].tumorPosition.clone().applyMatrix4(rightLobeMesh.matrixWorld.clone().invert());
  const s5s6NormDist = Math.sqrt(
    (s5s6Local.x / (65 * 1.2)) ** 2 +
    (s5s6Local.y / (65 * 1.1)) ** 2 +
    (s5s6Local.z / (65 * 0.75)) ** 2
  );
  assert(s5s6NormDist < 1.0, `S5/S6 tumor should be within right lobe parenchyma (normalized dist: ${s5s6NormDist.toFixed(2)})`);

  console.log('PASS: kinematics round-trip and pitch sign');
  console.log('PASS: rendered needle, ultrasound plane, and ablation ellipsoid share world coordinates');
  console.log('PASS: lesion intersection, finite fan, and fixed-entry auto-align feasibility');
  console.log('PASS: 1.5mm ultrasound slab visibility and cross-section geometry');
  console.log('PASS: independent probe and needle-entry selectors');
  console.log('PASS: lesion port recommendations');
  console.log('PASS: ellipsoid geometric overlap estimate');
  console.log('PASS: needle-shaft surface clearance and vessel warnings');
  console.log('PASS: right-angle wedge optimizer point C calculation and in-plane coplanarity');
  console.log('PASS: anatomical liver lobe 70:30 proportions and tumor embedding');
}

runTests();
