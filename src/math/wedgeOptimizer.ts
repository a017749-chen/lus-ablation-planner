import * as THREE from 'three';
import { FulcrumKinematics } from './kinematics';

export interface AutoAlignNeedleSolution {
  feasible: boolean;
  pitch?: number;
  yaw?: number;
  depth?: number;
  adjustedPivot?: THREE.Vector3;
  targetDir?: THREE.Vector3;
  residualDistanceMm: number;
  residualAngleDeg: number;
  reason?: string;
}

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
  public static readonly PLANE_DISTANCE_TOLERANCE_MM = 1.0;
  public static readonly PLANE_ANGLE_TOLERANCE_DEG = 2.0;
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
  ): AutoAlignNeedleSolution {
    const n = planeNormal.clone().normalize();
    const pivotOffset = new THREE.Vector3().subVectors(needlePivot, planeOrigin).dot(n);
    const tumorOffset = new THREE.Vector3().subVectors(tumorCenter, planeOrigin).dot(n);
    const alignedTumor = tumorCenter.clone().addScaledVector(n, -tumorOffset);

    if (!isPercutaneous && Math.abs(pivotOffset) > WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM) {
      const direction = new THREE.Vector3().subVectors(alignedTumor, needlePivot).normalize();
      const residualAngleDeg = Number.isFinite(direction.lengthSq())
        ? THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(Math.abs(direction.dot(n)), 0, 1)))
        : 0;
      return {
        feasible: false,
        residualDistanceMm: Math.abs(pivotOffset),
        residualAngleDeg,
        reason: `Fixed trocar pivot is ${Math.abs(pivotOffset).toFixed(1)} mm outside the ultrasound plane.`
      };
    }

    // In percutaneous mode, the entry point may move onto the scan plane.
    const alignedPivot = isPercutaneous
      ? needlePivot.clone().addScaledVector(n, -pivotOffset)
      : needlePivot.clone();
    const targetVector = new THREE.Vector3().subVectors(alignedTumor, alignedPivot);
    const depth = targetVector.length();
    if (depth <= 0.001) {
      return {
        feasible: false,
        residualDistanceMm: Math.max(Math.abs(pivotOffset), Math.abs(tumorOffset)),
        residualAngleDeg: 0,
        reason: 'The projected target coincides with the needle pivot.'
      };
    }

    const aim = FulcrumKinematics.solveAimTarget(alignedPivot, trocarNormal, alignedTumor);
    const forward = FulcrumKinematics.computeForward(
      alignedPivot,
      trocarNormal,
      aim.pitch,
      aim.yaw,
      0,
      depth
    );
    const targetDir = targetVector.normalize();
    const pivotResidual = Math.abs(new THREE.Vector3().subVectors(alignedPivot, planeOrigin).dot(n));
    const tipResidual = Math.abs(new THREE.Vector3().subVectors(forward.tip, planeOrigin).dot(n));
    const residualDistanceMm = Math.max(pivotResidual, tipResidual);
    const residualAngleDeg = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(Math.abs(forward.direction.dot(n)), 0, 1))
    );
    const feasible =
      residualDistanceMm <= WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM &&
      residualAngleDeg <= WedgeOptimizer.PLANE_ANGLE_TOLERANCE_DEG;

    return {
      feasible,
      pitch: aim.pitch,
      yaw: aim.yaw,
      depth,
      ...(isPercutaneous ? { adjustedPivot: alignedPivot } : {}),
      targetDir,
      residualDistanceMm,
      residualAngleDeg,
      ...(feasible ? {} : { reason: 'The computed needle does not meet the in-plane tolerances.' })
    };
  }
}
