import * as THREE from 'three';
import { FulcrumKinematics } from './kinematics';

export interface WedgePunctureSolution {
  optimalEntryPoint: THREE.Vector3;
  targetPoint: THREE.Vector3;
  trajectoryDir: THREE.Vector3;
  punctureDepth: number;
  longitudinalAngleDeg: number;
  lateralDivergenceDeg: number;
  guideLinePoints: [THREE.Vector3, THREE.Vector3];
}

/**
 * Right-Angle Wedge Puncture Optimizer & Auto-Align Engine
 * Computes optimal entry geometry based on probe axis OA and tumor center OB,
 * and provides one-click alignment of the needle to the ultrasound scan plane.
 */
export class WedgeOptimizer {
  /**
   * Calculate Right-Angle Wedge puncture path
   * @param probeTransducerPos Point A: LUS probe tip
   * @param probeBeamAxis Vector along ultrasound beam depth axis
   * @param planeNormal Normal vector of ultrasound scan plane
   * @param tumorCenter Point B: Target tumor center
   * @param longitudinalAngle Target angle relative to probe beam (default 60 deg)
   */
  public static computeWedgeGeometry(
    probeTransducerPos: THREE.Vector3,
    probeBeamAxis: THREE.Vector3,
    planeNormal: THREE.Vector3,
    tumorCenter: THREE.Vector3,
    longitudinalAngleDeg: number = 60
  ): WedgePunctureSolution {
    const n = planeNormal.clone().normalize();
    const beamDir = probeBeamAxis.clone().normalize();
    const lateralDir = new THREE.Vector3().crossVectors(n, beamDir).normalize();

    // Project tumor onto US plane
    const toTumor = new THREE.Vector3().subVectors(tumorCenter, probeTransducerPos);
    const normalOffset = toTumor.dot(n);
    const projectedTumor = tumorCenter.clone().addScaledVector(n, -normalOffset);

    // Depth along beam and lateral offset
    const depthAlongBeam = new THREE.Vector3().subVectors(projectedTumor, probeTransducerPos).dot(beamDir);
    const lateralOffset = new THREE.Vector3().subVectors(projectedTumor, probeTransducerPos).dot(lateralDir);

    // Compute entry point C in US plane at specified angle
    const angleRad = THREE.MathUtils.degToRad(longitudinalAngleDeg);
    // Ideal puncture trajectory comes from lateral edge at angle theta
    const entryDistance = depthAlongBeam / Math.tan(angleRad);
    const optimalEntryPoint = projectedTumor.clone()
      .addScaledVector(beamDir, -depthAlongBeam)
      .addScaledVector(lateralDir, Math.sign(lateralOffset || 1) * Math.max(30, Math.abs(lateralOffset) + entryDistance * 0.4));

    // Trajectory vector from entry to tumor
    const trajectoryVec = new THREE.Vector3().subVectors(tumorCenter, optimalEntryPoint);
    const punctureDepth = trajectoryVec.length();
    const trajectoryDir = trajectoryVec.clone().normalize();

    const guideStart = optimalEntryPoint.clone();
    const guideEnd = tumorCenter.clone().addScaledVector(trajectoryDir, 20); // Extends 20mm past tumor

    return {
      optimalEntryPoint,
      targetPoint: tumorCenter.clone(),
      trajectoryDir,
      punctureDepth,
      longitudinalAngleDeg,
      lateralDivergenceDeg: THREE.MathUtils.radToDeg(Math.atan2(Math.abs(normalOffset), depthAlongBeam)),
      guideLinePoints: [guideStart, guideEnd]
    };
  }

  /**
   * One-Click Auto-Align to Ultrasound Plane:
   * Solves needle kinematic adjustments (Pitch, Yaw, Depth) so the needle shaft
   * lies directly inside the ultrasound scan plane and aims toward the tumor.
   */
  public static autoAlignNeedle(
    needlePivot: THREE.Vector3,
    trocarNormal: THREE.Vector3,
    planeOrigin: THREE.Vector3,
    planeNormal: THREE.Vector3,
    planeXAxis: THREE.Vector3,
    planeYAxis: THREE.Vector3,
    tumorCenter: THREE.Vector3,
    isPercutaneous: boolean = false
  ): {
    pitch: number;
    yaw: number;
    depth: number;
    adjustedPivot?: THREE.Vector3;
    targetDir: THREE.Vector3;
  } {
    const n = planeNormal.clone().normalize();

    if (isPercutaneous) {
      // In percutaneous mode, move entry pivot directly onto the plane
      const pivotDist = new THREE.Vector3().subVectors(needlePivot, planeOrigin).dot(n);
      const alignedPivot = needlePivot.clone().addScaledVector(n, -pivotDist);

      // Project tumor to plane
      const tumorDist = new THREE.Vector3().subVectors(tumorCenter, planeOrigin).dot(n);
      const alignedTumor = tumorCenter.clone().addScaledVector(n, -tumorDist);

      const targetDir = new THREE.Vector3().subVectors(alignedTumor, alignedPivot).normalize();
      const depth = new THREE.Vector3().subVectors(alignedTumor, alignedPivot).length();

      const aim = FulcrumKinematics.solveAimTarget(alignedPivot, trocarNormal, alignedTumor);
      return {
        pitch: aim.pitch,
        yaw: aim.yaw,
        depth,
        adjustedPivot: alignedPivot,
        targetDir
      };
    } else {
      // In trocar-constrained mode, find the point in the ultrasound plane that is aligned with the tumor
      // Project the tumor onto the US plane
      const tumorDist = new THREE.Vector3().subVectors(tumorCenter, planeOrigin).dot(n);
      const alignedTumor = tumorCenter.clone().addScaledVector(n, -tumorDist);

      // Aim needle at the aligned tumor point
      const aim = FulcrumKinematics.solveAimTarget(needlePivot, trocarNormal, alignedTumor);
      const depth = new THREE.Vector3().subVectors(alignedTumor, needlePivot).length();

      return {
        pitch: aim.pitch,
        yaw: aim.yaw,
        depth,
        targetDir: aim.dir
      };
    }
  }
}
