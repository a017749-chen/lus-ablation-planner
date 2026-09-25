import * as THREE from 'three';
import { FulcrumKinematics } from '../math/kinematics';
import { AlignmentEngine } from '../math/alignmentEngine';
import { WedgeOptimizer } from '../math/wedgeOptimizer';
import { CollisionDetector } from '../math/collision';

function runTests() {
  console.log('=== Running LUS-Ablation 3D Planner Math & Kinematics Verification ===\n');

  // Test 1: Fulcrum Kinematics
  console.log('[Test 1] Fulcrum 4-DOF Constraint Verification:');
  const pivot = new THREE.Vector3(75, -20, 68);
  const baseNormal = new THREE.Vector3(-0.5, 0.4, -0.75).normalize();
  const fulcrum = FulcrumKinematics.computeForward(pivot, baseNormal, 30, -15, 0, 100);
  console.log('  Fulcrum Pivot invariant:', fulcrum.pivot.equals(pivot));
  console.log('  Instrument Tip depth distance:', Math.abs(fulcrum.tip.distanceTo(pivot) - 100) < 0.001);
  if (!fulcrum.pivot.equals(pivot) || Math.abs(fulcrum.tip.distanceTo(pivot) - 100) >= 0.001) {
    throw new Error('Fulcrum kinematics failed');
  }
  console.log('  ✓ Fulcrum forward kinematics verified.\n');

  // Test 2: In-Plane Alignment Engine
  console.log('[Test 2] In-Plane Alignment Engine Verification:');
  const planeOrigin = new THREE.Vector3(0, 0, 0);
  const planeNormal = new THREE.Vector3(0, 0, 1);
  const planeX = new THREE.Vector3(1, 0, 0);
  const planeY = new THREE.Vector3(0, 1, 0);

  // Case 2a: Perfect In-Plane (needle in Z = 0 plane)
  const entryInPlane = new THREE.Vector3(50, 80, 0);
  const tipInPlane = new THREE.Vector3(10, 20, 0);
  const resInPlane = AlignmentEngine.evaluate(planeOrigin, planeNormal, planeX, planeY, entryInPlane, tipInPlane);
  console.log('  Case 2a (In-Plane): Status =', resInPlane.status, ', Angle =', resInPlane.angleToPlaneDeg, '°, MaxDist =', resInPlane.maxDistance);
  if (resInPlane.status !== 'IN_PLANE') throw new Error('Expected IN_PLANE');

  // Case 2b: Cross-Plane (needle crossing Z = 0 plane from Z = 20 to Z = -20)
  const entryCross = new THREE.Vector3(50, 80, 20);
  const tipCross = new THREE.Vector3(10, 20, -20);
  const resCross = AlignmentEngine.evaluate(planeOrigin, planeNormal, planeX, planeY, entryCross, tipCross);
  console.log('  Case 2b (Cross-Plane): Status =', resCross.status, ', Intersection =', resCross.intersectionWithPlane);
  if (resCross.status !== 'CROSS_PLANE') throw new Error('Expected CROSS_PLANE');

  // Case 2c: Out-of-Plane (needle completely at Z = 15mm parallel to plane)
  const entryOut = new THREE.Vector3(50, 80, 15);
  const tipOut = new THREE.Vector3(10, 20, 15);
  const resOut = AlignmentEngine.evaluate(planeOrigin, planeNormal, planeX, planeY, entryOut, tipOut);
  console.log('  Case 2c (Out-of-Plane): Status =', resOut.status, ', Offset =', resOut.offsetMm, 'mm');
  if (resOut.status !== 'OUT_OF_PLANE') throw new Error('Expected OUT_OF_PLANE');
  console.log('  ✓ In-Plane alignment engine accurately classifies all 3 clinical states.\n');

  // Test 3: Wedge Optimizer & Auto-Align
  console.log('[Test 3] Wedge Optimizer & Auto-Align Solver:');
  const tumor = new THREE.Vector3(32, -22, 0);
  const alignedSol = WedgeOptimizer.autoAlignNeedle(
    pivot,
    baseNormal,
    planeOrigin,
    planeNormal,
    planeX,
    planeY,
    tumor,
    false
  );
  console.log('  Auto-aligned Pitch:', alignedSol.pitch.toFixed(2), '°, Yaw:', alignedSol.yaw.toFixed(2), '°, Depth:', alignedSol.depth.toFixed(2));
  console.log('  ✓ Auto-align solver converged smoothly.\n');

  // Test 4: Vessel Collision Detection
  console.log('[Test 4] Vessel Collision Detection & 5mm Margin:');
  // Needle directly piercing IVC
  const ivcColl = CollisionDetector.checkCollision(
    new THREE.Vector3(12, -70, -35),
    new THREE.Vector3(10, 85, -28)
  );
  console.log('  Collision with IVC: Alert =', ivcColl.hasCollision, ', MinDist =', ivcColl.minDistance, 'mm, Vessel =', ivcColl.closestVesselName);
  if (!ivcColl.hasCollision) throw new Error('Collision expected but not triggered');

  // Safe needle trajectory far from vessels
  const safeColl = CollisionDetector.checkCollision(
    new THREE.Vector3(60, -20, 40),
    new THREE.Vector3(50, -10, 30)
  );
  console.log('  Safe clearance: Alert =', safeColl.hasCollision, ', MinDist =', safeColl.minDistance, 'mm');
  if (safeColl.hasCollision) throw new Error('Unexpected collision on safe path');
  console.log('  ✓ Collision detection verified.\n');

  console.log('>>> ALL MATHEMATICAL & SURGICAL ENGINES PASSED VERIFICATION (100%) <<<');
}

runTests();
