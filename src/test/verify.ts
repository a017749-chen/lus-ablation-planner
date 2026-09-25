import * as THREE from 'three';
import { LESION_PRESETS, getSuggestedPortSelection } from '../config/presets';
import { AlignmentEngine } from '../math/alignmentEngine';
import { CollisionDetector } from '../math/collision';
import { estimateEllipsoidTargetOverlap } from '../math/coverage';
import { FulcrumKinematics } from '../math/kinematics';
import { WedgeOptimizer } from '../math/wedgeOptimizer';
import { InstrumentBuilder } from '../scene/Instruments';

function assert(condition: boolean, message: string): asserts condition {
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

  // A fixed trocar pivot outside the ultrasound plane cannot produce an in-plane shaft.
  const planeOrigin = new THREE.Vector3(0, 0, 0);
  const planeNormal = new THREE.Vector3(0, 0, 1);
  const planeX = new THREE.Vector3(1, 0, 0);
  const planeY = new THREE.Vector3(0, 1, 0);
  const tumorOnPlane = new THREE.Vector3(32, -22, 0);
  const infeasible = WedgeOptimizer.autoAlignNeedle(
    pivot,
    new THREE.Vector3(-0.5, 0.4, -0.75),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorOnPlane,
    false
  );
  assert(!infeasible.feasible, 'Off-plane trocar pivot must report infeasible.');
  assertNear(infeasible.residualDistanceMm, 68, 1e-8, 'Off-plane pivot residual');
  assert(infeasible.pitch === undefined, 'Infeasible result must not expose angles to apply.');

  // A feasible solution must place the computed needle segment in the plane.
  const feasiblePivot = new THREE.Vector3(10, -20, 0);
  const feasible = WedgeOptimizer.autoAlignNeedle(
    feasiblePivot,
    new THREE.Vector3(0, 0, -1),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorOnPlane,
    false
  );
  assert(feasible.feasible, `On-plane pivot should be feasible: ${feasible.reason ?? ''}`);
  assert(feasible.pitch !== undefined && feasible.yaw !== undefined && feasible.depth !== undefined, 'Feasible solution must contain angles and depth.');
  const aligned = FulcrumKinematics.computeForward(
    feasiblePivot,
    new THREE.Vector3(0, 0, -1),
    feasible.pitch,
    feasible.yaw,
    0,
    feasible.depth
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
  assertNear(aligned.tip.distanceTo(tumorOnPlane), 0, 1e-6, 'Auto-align target accuracy');

  const percutaneous = WedgeOptimizer.autoAlignNeedle(
    pivot,
    new THREE.Vector3(0, 0, -1),
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumorOnPlane,
    true
  );
  assert(percutaneous.feasible, 'Percutaneous solution should move its pivot to the plane.');
  assert(percutaneous.adjustedPivot !== undefined, 'Percutaneous solution must return its adjusted pivot.');
  assertNear(percutaneous.adjustedPivot.z, 0, 1e-8, 'Percutaneous pivot plane offset');

  // Preset port recommendations are independent: S7/S8 uses subcostal probe and ITT needle.
  const s7Ports = getSuggestedPortSelection(LESION_PRESETS.S7_S8);
  assert(s7Ports.probePort === 'subcostal', 'S7/S8 preset should select subcostal probe port.');
  assert(s7Ports.needlePort === 'itt' && s7Ports.needleMode === 'trocar', 'S7/S8 preset should select ITT needle port.');
  const percutaneousPorts = getSuggestedPortSelection({
    ...LESION_PRESETS.S2_S3,
    suggestedNeedlePort: 'percutaneous'
  });
  assert(percutaneousPorts.needleMode === 'percutaneous', 'A percutaneous recommendation should select percutaneous needle mode.');

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

  // Preserve threshold collision behavior for vessel clearance.
  const vesselCollision = CollisionDetector.checkCollision(
    new THREE.Vector3(12, -70, -35),
    new THREE.Vector3(10, 85, -28)
  );
  assert(vesselCollision.hasCollision, 'Needle through the IVC should trigger collision.');
  const safePath = CollisionDetector.checkCollision(
    new THREE.Vector3(60, -20, 40),
    new THREE.Vector3(50, -10, 30)
  );
  assert(!safePath.hasCollision, 'A distant path should not trigger vessel collision.');

  console.log('PASS: kinematics round-trip and pitch sign');
  console.log('PASS: rendered needle, ultrasound plane, and ablation ellipsoid share world coordinates');
  console.log('PASS: auto-align feasibility and residual checks');
  console.log('PASS: lesion port recommendations');
  console.log('PASS: ellipsoid geometric overlap estimate');
  console.log('PASS: vessel collision detection');
}

runTests();
