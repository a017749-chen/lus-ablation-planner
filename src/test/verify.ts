import * as THREE from 'three';
import {
  LESION_PRESETS,
  TROCAR_PRESETS,
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
import {
  ANTERIOR_VIEW,
  dicomLpsToScene,
  sceneToDicomLps
} from '../math/patientCoordinates';
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

function getClosedMeshVolume(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const vertexCount = index?.count ?? position.count;
  mesh.updateMatrixWorld(true);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let signedVolume = 0;

  for (let i = 0; i < vertexCount; i += 3) {
    const indexA = index ? index.getX(i) : i;
    const indexB = index ? index.getX(i + 1) : i + 1;
    const indexC = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, indexA).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, indexB).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, indexC).applyMatrix4(mesh.matrixWorld);
    signedVolume += a.dot(cross.crossVectors(b, c)) / 6;
  }

  return Math.abs(signedVolume);
}

function containsSphereWithinEllipsoid(mesh: THREE.Mesh, center: THREE.Vector3, radius: number): boolean {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  if (!bounds) return false;

  const radii = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  if (Math.min(radii.x, radii.y, radii.z) <= 0) return false;

  mesh.updateMatrixWorld(true);
  const localCenter = center.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
  const localScales = new THREE.Vector3();
  mesh.getWorldScale(localScales);
  const localRadius = radius / Math.min(
    Math.abs(localScales.x),
    Math.abs(localScales.y),
    Math.abs(localScales.z)
  );
  const normalizedCenterDistance = Math.sqrt(
    (localCenter.x / radii.x) ** 2 +
    (localCenter.y / radii.y) ** 2 +
    (localCenter.z / radii.z) ** 2
  );

  // Conservative bound: a sphere is contained if its center plus its largest normalized radius fits.
  return normalizedCenterDistance + localRadius / Math.min(radii.x, radii.y, radii.z) < 1;
}

function runTests() {
  console.log('=== LUS-Ablation geometry verification ===');

  const dicomLpsPoint = new THREE.Vector3(-40, 25, 120);
  const scenePoint = dicomLpsToScene(dicomLpsPoint);
  assertVectorNear(scenePoint, new THREE.Vector3(-40, 120, -25), 1e-8, 'DICOM LPS to planner scene frame');
  assert(scenePoint.x < 0, 'DICOM patient-right points must map to negative scene X.');
  assert(scenePoint.y > 0, 'DICOM headward points must map to positive scene Y.');
  assert(scenePoint.z < 0, 'DICOM posterior points must map to negative scene Z.');
  assertVectorNear(sceneToDicomLps(scenePoint), dicomLpsPoint, 1e-8, 'Planner scene / DICOM LPS round-trip');

  const anteriorCamera = new THREE.PerspectiveCamera(45, 1, 1, 1500);
  anteriorCamera.position.set(...ANTERIOR_VIEW.position);
  anteriorCamera.up.set(...ANTERIOR_VIEW.up);
  anteriorCamera.lookAt(new THREE.Vector3(...ANTERIOR_VIEW.target));
  anteriorCamera.updateMatrixWorld(true);
  const rightSideScreenX = new THREE.Vector3(-20, 10, 10).project(anteriorCamera).x;
  const leftSideScreenX = new THREE.Vector3(40, 10, 10).project(anteriorCamera).x;
  assert(rightSideScreenX < 0, 'Patient-right must appear on the left of the anterior view.');
  assert(leftSideScreenX > 0, 'Patient-left must appear on the right of the anterior view.');

  const vessels = CollisionDetector.getVascularTree();
  const rightPortalBranch = vessels.find((vessel) => vessel.name.startsWith('Right Portal'));
  const leftPortalBranch = vessels.find((vessel) => vessel.name.startsWith('Left Portal'));
  assert(rightPortalBranch !== undefined && rightPortalBranch.end.x < 0, 'Right portal branch must lie on patient-right (negative scene X).');
  assert(leftPortalBranch !== undefined && leftPortalBranch.end.x > 0, 'Left portal branch must lie on patient-left (positive scene X).');
  assert(TROCAR_PRESETS.subcostal.pivotPosition.x < 0, 'Right subcostal port must lie on patient-right.');
  assert(TROCAR_PRESETS.itt.pivotPosition.x < 0, 'Right-sided ITT port must lie on patient-right.');

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
    new THREE.Vector3(-12, -70, -35),
    new THREE.Vector3(-10, 85, -28)
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

  // Compare rendered ellipsoid meshes, not hard-coded radii. Their 70:30 standalone
  // mesh-volume ratio is a shape cue only because the translucent lobes overlap.
  const anatomy = AnatomyBuilder.build();
  const rightLobeMesh = anatomy.liverGroup.getObjectByName('IllustrativeRightLobe');
  const leftLobeMesh = anatomy.liverGroup.getObjectByName('IllustrativeLeftLobe');
  const rightSideLabel = anatomy.landmarks.getObjectByName('PatientRightLabel');
  const leftSideLabel = anatomy.landmarks.getObjectByName('PatientLeftLabel');
  assert(rightLobeMesh instanceof THREE.Mesh, 'Illustrative right lobe mesh must exist.');
  assert(leftLobeMesh instanceof THREE.Mesh, 'Illustrative left lobe mesh must exist.');
  assert(rightSideLabel instanceof THREE.Group, 'Patient-right marker must exist.');
  assert(leftSideLabel instanceof THREE.Group, 'Patient-left marker must exist.');
  anatomy.group.updateMatrixWorld(true);

  assert(rightLobeMesh.position.x < 0, 'Illustrative right lobe must be on negative scene X.');
  assert(leftLobeMesh.position.x > 0, 'Illustrative left lobe must be on positive scene X.');
  assert(rightSideLabel.position.x < 0, 'R marker must be on the patient-right side.');
  assert(leftSideLabel.position.x > 0, 'L marker must be on the patient-left side.');

  const volRightMesh = getClosedMeshVolume(rightLobeMesh);
  const volLeftMesh = getClosedMeshVolume(leftLobeMesh);
  const rightMeshRatio = volRightMesh / (volRightMesh + volLeftMesh);
  const leftMeshRatio = volLeftMesh / (volRightMesh + volLeftMesh);
  assert(rightMeshRatio >= 0.65 && rightMeshRatio <= 0.75, `Standalone right-lobe mesh volume should be ~70% of the two ellipsoid volumes (got ${(rightMeshRatio * 100).toFixed(1)}%)`);
  assert(leftMeshRatio >= 0.25 && leftMeshRatio <= 0.35, `Standalone left-lobe mesh volume should be ~30% of the two ellipsoid volumes (got ${(leftMeshRatio * 100).toFixed(1)}%)`);

  const lobeForPreset: Record<string, THREE.Mesh> = {
    S2_S3: leftLobeMesh,
    S5_S6: rightLobeMesh,
    S7_S8: rightLobeMesh
  };
  assert(Object.keys(lobeForPreset).length === Object.keys(LESION_PRESETS).length, 'Every lesion preset must have an explicit illustrative lobe mapping.');
  for (const [presetId, preset] of Object.entries(LESION_PRESETS)) {
    const lobe = lobeForPreset[presetId];
    assert(lobe instanceof THREE.Mesh, `${presetId} must map to an illustrative lobe mesh.`);
    assert(
      containsSphereWithinEllipsoid(lobe, preset.tumorPosition, preset.tumorDiameter * 0.5),
      `${presetId} full tumor sphere must fit within its illustrative lobe.`
    );
  }

  console.log('PASS: kinematics round-trip and pitch sign');
  console.log('PASS: rendered needle, ultrasound plane, and ablation ellipsoid share world coordinates');
  console.log('PASS: lesion intersection, finite fan, and fixed-entry auto-align feasibility');
  console.log('PASS: 1.5mm ultrasound slab visibility and cross-section geometry');
  console.log('PASS: independent probe and needle-entry selectors');
  console.log('PASS: lesion port recommendations');
  console.log('PASS: ellipsoid geometric overlap estimate');
  console.log('PASS: needle-shaft surface clearance and vessel warnings');
  console.log('PASS: right-angle wedge optimizer point C calculation and in-plane coplanarity');
  console.log('PASS: DICOM LPS conversion and patient right/left scene orientation');
  console.log('PASS: illustrative lobe mesh proportions and complete tumor containment for every preset');
}

runTests();
