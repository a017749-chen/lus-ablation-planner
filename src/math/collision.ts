import * as THREE from 'three';

export interface VesselSegment {
  name: string;
  type: 'ivc' | 'portal_vein';
  start: THREE.Vector3;
  end: THREE.Vector3;
  radius: number; // mm
  color: number;
}

export interface CollisionCheckResult {
  hasCollision: boolean; // needle shaft-to-vessel surface clearance < 5mm
  minDistance: number;   // mm (needle shaft surface to vessel surface)
  closestVesselName: string;
  ivcMinDist: number;
  pvMinDist: number;
  needlePoint: THREE.Vector3;
  vesselPoint: THREE.Vector3;
}

export class CollisionDetector {
  public static readonly WARNING_THRESHOLD_MM = 5.0; // geometric warning threshold
  public static readonly NEEDLE_RADIUS_MM = 0.8; // 1.6mm diameter simulated shaft

  /**
   * Defines standard hepatic vascular anatomy segments
   */
  public static getVascularTree(): VesselSegment[] {
    return [
      // IVC (Inferior Vena Cava) - Retrohepatic large blue venous column
      {
        name: 'IVC (下腔靜脈主幹)',
        type: 'ivc',
        start: new THREE.Vector3(12, -70, -35),
        end: new THREE.Vector3(10, 85, -28),
        radius: 9.0, // 18mm diameter
        color: 0x1e88e5
      },
      // Middle & Left Hepatic Vein confluence into IVC
      {
        name: 'Hepatic Vein (肝靜脈匯合部)',
        type: 'ivc',
        start: new THREE.Vector3(10, 75, -28),
        end: new THREE.Vector3(-15, 60, -10),
        radius: 5.5,
        color: 0x2196f3
      },
      // Portal Vein Main Trunk (門靜脈主幹)
      {
        name: 'Portal Vein Main (門靜脈主幹)',
        type: 'portal_vein',
        start: new THREE.Vector3(5, -60, -10),
        end: new THREE.Vector3(10, -10, -5),
        radius: 6.5, // 13mm diameter
        color: 0x8e24aa
      },
      // Right Portal Vein Branch (門靜脈右支)
      {
        name: 'Right Portal Vein (門靜脈右前/右後支)',
        type: 'portal_vein',
        start: new THREE.Vector3(10, -10, -5),
        end: new THREE.Vector3(38, 5, -12),
        radius: 4.8,
        color: 0xab47bc
      },
      // Left Portal Vein Branch (門靜脈左支)
      {
        name: 'Left Portal Vein (門靜脈左支)',
        type: 'portal_vein',
        start: new THREE.Vector3(10, -10, -5),
        end: new THREE.Vector3(-25, 5, 5),
        radius: 4.5,
        color: 0xba68c8
      }
    ];
  }

  /**
   * Calculates needle-shaft surface clearance from the simulated vascular segments.
   */
  public static checkCollision(
    needleStart: THREE.Vector3,
    needleEnd: THREE.Vector3,
    vessels: VesselSegment[] = CollisionDetector.getVascularTree(),
    needleRadiusMm: number = CollisionDetector.NEEDLE_RADIUS_MM
  ): CollisionCheckResult {
    let overallMinDist = Infinity;
    let closestVesselName = 'None';
    let ivcMinDist = Infinity;
    let pvMinDist = Infinity;
    let bestNeedlePt = needleStart.clone();
    let bestVesselPt = needleStart.clone();

    for (const vessel of vessels) {
      const { distCenter, ptNeedle, ptVessel } = CollisionDetector.segmentToSegmentDistance(
        needleStart,
        needleEnd,
        vessel.start,
        vessel.end
      );

      // Distance between the vessel surface and the outer shaft surface.
      const surfaceDist = Math.max(0, distCenter - vessel.radius - needleRadiusMm);

      if (vessel.type === 'ivc') {
        ivcMinDist = Math.min(ivcMinDist, surfaceDist);
      } else {
        pvMinDist = Math.min(pvMinDist, surfaceDist);
      }

      if (surfaceDist < overallMinDist) {
        overallMinDist = surfaceDist;
        closestVesselName = vessel.name;
        bestNeedlePt = ptNeedle;
        bestVesselPt = ptVessel;
      }
    }

    const hasCollision = overallMinDist < CollisionDetector.WARNING_THRESHOLD_MM;

    return {
      hasCollision,
      minDistance: Number(overallMinDist.toFixed(1)),
      closestVesselName,
      ivcMinDist: Number(ivcMinDist.toFixed(1)),
      pvMinDist: Number(pvMinDist.toFixed(1)),
      needlePoint: bestNeedlePt,
      vesselPoint: bestVesselPt
    };
  }

  /**
   * Robust analytical minimum distance between two 3D line segments
   */
  private static segmentToSegmentDistance(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    q1: THREE.Vector3,
    q2: THREE.Vector3
  ): { distCenter: number; ptNeedle: THREE.Vector3; ptVessel: THREE.Vector3 } {
    const u = new THREE.Vector3().subVectors(p2, p1);
    const v = new THREE.Vector3().subVectors(q2, q1);
    const w = new THREE.Vector3().subVectors(p1, q1);

    const a = u.dot(u); // always >= 0
    const b = u.dot(v);
    const c = v.dot(v); // always >= 0
    const d = u.dot(w);
    const e = v.dot(w);
    const D = a * c - b * b; // always >= 0

    let sc: number;
    let sN: number;
    let sD = D;
    let tc: number;
    let tN: number;
    let tD = D;

    const EPS = 0.00000001;

    // Compute the line parameters of the two closest points
    if (D < EPS) {
      // The lines are almost parallel
      sN = 0.0;
      sD = 1.0;
      tN = e;
      tD = c;
    } else {
      sN = b * e - c * d;
      tN = a * e - b * d;
      if (sN < 0.0) {
        sN = 0.0;
        tN = e;
        tD = c;
      } else if (sN > sD) {
        sN = sD;
        tN = e + b;
        tD = c;
      }
    }

    if (tN < 0.0) {
      tN = 0.0;
      // Recompute sN for t = 0
      if (-d < 0.0) sN = 0.0;
      else if (-d > a) sN = sD;
      else {
        sN = -d;
        sD = a;
      }
    } else if (tN > tD) {
      tN = tD;
      // Recompute sN for t = 1
      if ((-d + b) < 0.0) sN = 0.0;
      else if ((-d + b) > a) sN = sD;
      else {
        sN = -d + b;
        sD = a;
      }
    }

    sc = Math.abs(sN) < EPS ? 0.0 : sN / sD;
    tc = Math.abs(tN) < EPS ? 0.0 : tN / tD;

    const ptNeedle = new THREE.Vector3().copy(p1).addScaledVector(u, sc);
    const ptVessel = new THREE.Vector3().copy(q1).addScaledVector(v, tc);
    const distCenter = ptNeedle.distanceTo(ptVessel);

    return { distCenter, ptNeedle, ptVessel };
  }
}
