import * as THREE from 'three';
import { FulcrumKinematics } from './kinematics';
import {
  closestPointInUltrasoundSector,
  getSphereSlabIntersection,
  isPointInUltrasoundSector,
  ULTRASOUND_SECTOR,
  UltrasoundSectorBounds
} from './ultrasoundGeometry';

export interface AutoAlignNeedleSolution {
  feasible: boolean;
  pitch?: number;
  yaw?: number;
  depth?: number;
  targetDir?: THREE.Vector3;
  targetPoint?: THREE.Vector3;
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
    tumorRadiusMm: number,
    isPercutaneous: boolean = false,
    sectorBounds: UltrasoundSectorBounds = ULTRASOUND_SECTOR
  ): AutoAlignNeedleSolution {
    const n = planeNormal.clone().normalize();
    const xAxis = planeXAxis.clone().normalize();
    const yAxis = planeYAxis.clone().normalize();
    const pivotOffset = new THREE.Vector3().subVectors(needlePivot, planeOrigin).dot(n);
    const pivotResidual = Math.abs(pivotOffset);

    const fail = (residualDistanceMm: number, residualAngleDeg: number, reason: string): AutoAlignNeedleSolution => ({
      feasible: false,
      residualDistanceMm,
      residualAngleDeg,
      reason
    });

    if (pivotResidual > WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM) {
      const targetDirection = new THREE.Vector3().subVectors(tumorCenter, needlePivot).normalize();
      const angle = Number.isFinite(targetDirection.lengthSq())
        ? THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(Math.abs(targetDirection.dot(n)), 0, 1)))
        : 0;
      const pivotName = isPercutaneous ? 'Fixed percutaneous entry' : 'Fixed trocar pivot';
      return fail(
        pivotResidual,
        angle,
        `${pivotName} is ${pivotResidual.toFixed(1)} mm outside the ultrasound plane; the entry point was not moved.`
      );
    }

    if (!Number.isFinite(tumorRadiusMm) || tumorRadiusMm <= 0) {
      return fail(pivotResidual, 0, 'Tumor radius must be a positive finite value.');
    }

    const tumorOffset = new THREE.Vector3().subVectors(tumorCenter, planeOrigin).dot(n);
    const lesionSlice = getSphereSlabIntersection(tumorRadiusMm, tumorOffset, 0);
    if (!lesionSlice.visible) {
      const gap = Math.abs(tumorOffset) - tumorRadiusMm;
      return fail(
        Math.max(pivotResidual, gap),
        0,
        `The lesion is ${gap.toFixed(1)} mm outside the scan plane; no lesion-plane intersection exists.`
      );
    }

    const projectedTumor = tumorCenter.clone().addScaledVector(n, -tumorOffset);
    const projectedOffset = new THREE.Vector3().subVectors(projectedTumor, planeOrigin);
    const tumorLateral = projectedOffset.dot(xAxis);
    const tumorDepth = projectedOffset.dot(yAxis);
    const fanPoint = closestPointInUltrasoundSector(tumorLateral, tumorDepth, sectorBounds);
    if (fanPoint.distanceMm > lesionSlice.crossSectionRadiusMm + 1e-8) {
      const gap = fanPoint.distanceMm - lesionSlice.crossSectionRadiusMm;
      return fail(
        Math.max(pivotResidual, gap),
        0,
        `The lesion-plane intersection misses the finite ultrasound fan by ${gap.toFixed(1)} mm.`
      );
    }

    const targetPoint = planeOrigin.clone()
      .addScaledVector(xAxis, fanPoint.lateralMm)
      .addScaledVector(yAxis, fanPoint.depthMm);
    if (targetPoint.distanceTo(tumorCenter) > tumorRadiusMm + 1e-6) {
      return fail(pivotResidual, 0, 'No point inside the lesion lies within the finite ultrasound fan.');
    }

    const targetVector = new THREE.Vector3().subVectors(targetPoint, needlePivot);
    const depth = targetVector.length();
    if (depth < 10 || depth > 180) {
      const distanceToRange = depth < 10 ? 10 - depth : depth - 180;
      return fail(
        Math.max(pivotResidual, distanceToRange),
        0,
        `The target requires ${depth.toFixed(1)} mm insertion depth; the available range is 10–180 mm.`
      );
    }

    const aim = FulcrumKinematics.solveAimTarget(needlePivot, trocarNormal, targetPoint);
    if (Math.abs(aim.pitch) > 80 || Math.abs(aim.yaw) > 80) {
      return fail(
        pivotResidual,
        0,
        `The target requires pitch ${aim.pitch.toFixed(1)}° and yaw ${aim.yaw.toFixed(1)}°; each control range is ±80°.`
      );
    }

    const forward = FulcrumKinematics.computeForward(
      needlePivot,
      trocarNormal,
      aim.pitch,
      aim.yaw,
      0,
      depth
    );
    const targetDir = targetVector.normalize();
    const tipOffset = new THREE.Vector3().subVectors(forward.tip, planeOrigin);
    const tipPlaneResidual = Math.abs(tipOffset.dot(n));
    const targetResidual = forward.tip.distanceTo(targetPoint);
    const lesionResidual = Math.max(0, forward.tip.distanceTo(tumorCenter) - tumorRadiusMm);
    const tipLateral = tipOffset.dot(xAxis);
    const tipDepth = tipOffset.dot(yAxis);
    const sectorResidual = isPointInUltrasoundSector(tipLateral, tipDepth, sectorBounds)
      ? 0
      : closestPointInUltrasoundSector(tipLateral, tipDepth, sectorBounds).distanceMm;
    const residualDistanceMm = Math.max(
      pivotResidual,
      tipPlaneResidual,
      targetResidual,
      lesionResidual,
      sectorResidual
    );
    const residualAngleDeg = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(Math.abs(forward.direction.dot(n)), 0, 1))
    );
    const feasible =
      pivotResidual <= WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM &&
      tipPlaneResidual <= WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM &&
      targetResidual <= 1e-6 &&
      lesionResidual <= 1e-6 &&
      sectorResidual <= 1e-6 &&
      residualAngleDeg <= WedgeOptimizer.PLANE_ANGLE_TOLERANCE_DEG;

    return {
      feasible,
      pitch: aim.pitch,
      yaw: aim.yaw,
      depth,
      targetDir,
      targetPoint,
      residualDistanceMm,
      residualAngleDeg,
      ...(feasible
        ? {}
        : { reason: 'The computed needle misses the lesion, finite scan sector, or in-plane tolerance.' })
    };
  }
}
