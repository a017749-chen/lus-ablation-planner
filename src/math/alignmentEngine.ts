import * as THREE from 'three';

export type AlignmentStatus = 'IN_PLANE' | 'CROSS_PLANE' | 'OUT_OF_PLANE';

export interface AlignmentResult {
  status: AlignmentStatus;
  angleToPlaneDeg: number;
  tipDistance: number; // mm
  entryDistance: number; // mm
  maxDistance: number; // mm
  minDistance: number; // mm
  offsetMm: number; // Primary deviation indicator
  isAngleAligned: boolean;
  isDistanceAligned: boolean;
  intersectionWithPlane?: THREE.Vector3;
  // Normalized 2D projection on the ultrasound scan sector (for B-mode rendering)
  usLocalTip?: { x: number; y: number; depth: number };
  usLocalEntry?: { x: number; y: number; depth: number };
  usIntersection?: { x: number; y: number; depth: number };
}

export class AlignmentEngine {
  // Visualization thresholds; these values are not validated clinical criteria.
  public static readonly ANGLE_TOLERANCE_DEG = 2.0; // 2 degrees
  public static readonly DISTANCE_TOLERANCE_MM = 1.0; // 1.0 mm (inside 1.5mm slice thickness)
  public static readonly SIN_2_DEG = Math.sin(THREE.MathUtils.degToRad(2.0));

  /**
   * Evaluate co-planarity between needle shaft and ultrasound beam plane
   * @param planeOrigin A point on the ultrasound plane (e.g. transducer face center)
   * @param planeNormal Unit normal vector of ultrasound scan plane
   * @param planeXAxis Unit vector along lateral scan direction
   * @param planeYAxis Unit vector along ultrasound beam depth axis
   * @param needleEntry Needle entry point
   * @param needleTip Needle tip point
   */
  public static evaluate(
    planeOrigin: THREE.Vector3,
    planeNormal: THREE.Vector3,
    planeXAxis: THREE.Vector3,
    planeYAxis: THREE.Vector3,
    needleEntry: THREE.Vector3,
    needleTip: THREE.Vector3
  ): AlignmentResult {
    const n = planeNormal.clone().normalize();
    const needleVec = new THREE.Vector3().subVectors(needleTip, needleEntry);
    const needleLength = needleVec.length();
    const vNeedle = needleLength > 0.001 ? needleVec.clone().normalize() : new THREE.Vector3(0, 1, 0);

    // Signed distances from plane
    const signedDistTip = new THREE.Vector3().subVectors(needleTip, planeOrigin).dot(n);
    const signedDistEntry = new THREE.Vector3().subVectors(needleEntry, planeOrigin).dot(n);

    const dTip = Math.abs(signedDistTip);
    const dEntry = Math.abs(signedDistEntry);
    const maxDist = Math.max(dTip, dEntry);
    const minDist = Math.min(dTip, dEntry);

    // Angle of needle with plane: sin(theta) = |v_needle . n|
    const dotProduct = Math.abs(vNeedle.dot(n));
    const angleToPlaneRad = Math.asin(THREE.MathUtils.clamp(dotProduct, 0, 1));
    const angleToPlaneDeg = THREE.MathUtils.radToDeg(angleToPlaneRad);

    const isAngleAligned = dotProduct < AlignmentEngine.SIN_2_DEG;
    const isDistanceAligned = maxDist < AlignmentEngine.DISTANCE_TOLERANCE_MM;

    // Check intersection with plane (if signs of signed distances differ)
    let intersectionWithPlane: THREE.Vector3 | undefined = undefined;
    if (signedDistTip * signedDistEntry <= 0 && Math.abs(signedDistTip - signedDistEntry) > 0.0001) {
      const t = Math.abs(signedDistEntry) / (Math.abs(signedDistEntry) + Math.abs(signedDistTip));
      intersectionWithPlane = new THREE.Vector3().lerpVectors(needleEntry, needleTip, t);
    }

    // Determine status
    let status: AlignmentStatus = 'OUT_OF_PLANE';
    if (isAngleAligned && isDistanceAligned) {
      status = 'IN_PLANE';
    } else if (intersectionWithPlane !== undefined || minDist < AlignmentEngine.DISTANCE_TOLERANCE_MM * 1.5) {
      status = 'CROSS_PLANE';
    } else {
      status = 'OUT_OF_PLANE';
    }

    // Helper to project 3D point onto ultrasound local 2D coordinate system
    const projectToUS = (pt: THREE.Vector3) => {
      const rel = new THREE.Vector3().subVectors(pt, planeOrigin);
      const x = rel.dot(planeXAxis);
      const y = rel.dot(planeYAxis);
      return { x, y, depth: y };
    };

    const usLocalTip = projectToUS(needleTip);
    const usLocalEntry = projectToUS(needleEntry);
    const usIntersection = intersectionWithPlane ? projectToUS(intersectionWithPlane) : undefined;

    return {
      status,
      angleToPlaneDeg,
      tipDistance: dTip,
      entryDistance: dEntry,
      maxDistance: maxDist,
      minDistance: minDist,
      offsetMm: Number(dTip.toFixed(1)),
      isAngleAligned,
      isDistanceAligned,
      intersectionWithPlane,
      usLocalTip,
      usLocalEntry,
      usIntersection
    };
  }
}
