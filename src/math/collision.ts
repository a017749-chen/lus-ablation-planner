import * as THREE from 'three';
import { getPatientAnatomyContext } from './anatomyContext';

export interface VesselSegment {
  name: string;
  type: 'ivc' | 'portal_vein' | 'hepatic_vein';
  start: THREE.Vector3;
  end: THREE.Vector3;
  radius: number;
  color: number;
}

export interface CollisionCheckResult {
  hasCollision: boolean;
  minDistance: number;
  closestVesselName: string;
  closestVesselType?: 'ivc' | 'portal_vein' | 'hepatic_vein' | 'none';
  ivcMinDist: number;
  pvMinDist: number;
  hvMinDist?: number;
  needlePoint: THREE.Vector3;
  vesselPoint: THREE.Vector3;
  patientSpecific?: boolean;
  conservativeLowerBound?: boolean;
  clinicalSafetyEstablished?: false;
}

export class CollisionDetector {
  public static readonly WARNING_THRESHOLD_MM = 5.0;
  public static readonly NEEDLE_RADIUS_MM = 0.8;

  /** Illustrative fallback tree; patient mode never uses these fixed segments. */
  public static getVascularTree(): VesselSegment[] {
    return [
      {
        name: 'IVC (下腔靜脈主幹)', type: 'ivc',
        start: new THREE.Vector3(-12, -70, -35), end: new THREE.Vector3(-10, 85, -28),
        radius: 9.0, color: 0x1e88e5
      },
      {
        name: 'Hepatic Vein (肝靜脈匯合部)', type: 'hepatic_vein',
        start: new THREE.Vector3(-10, 75, -28), end: new THREE.Vector3(15, 60, -10),
        radius: 5.5, color: 0x2196f3
      },
      {
        name: 'Portal Vein Main (門靜脈主幹)', type: 'portal_vein',
        start: new THREE.Vector3(-5, -60, -10), end: new THREE.Vector3(-10, -10, -5),
        radius: 6.5, color: 0x8e24aa
      },
      {
        name: 'Right Portal Vein (門靜脈右前/右後支)', type: 'portal_vein',
        start: new THREE.Vector3(-10, -10, -5), end: new THREE.Vector3(-38, 5, -12),
        radius: 4.8, color: 0xab47bc
      },
      {
        name: 'Left Portal Vein (門靜脈左支)', type: 'portal_vein',
        start: new THREE.Vector3(-10, -10, -5), end: new THREE.Vector3(25, 5, 5),
        radius: 4.5, color: 0xba68c8
      }
    ];
  }

  /**
   * Needle-shaft surface clearance.
   *
   * If reviewed patient anatomy is active and no explicit vessel list is supplied,
   * the result comes from patient PV/HV/IVC masks. Explicit `vessels` keeps the
   * deterministic illustrative/test path.
   */
  public static checkCollision(
    needleStart: THREE.Vector3,
    needleEnd: THREE.Vector3,
    vessels?: VesselSegment[],
    needleRadiusMm: number = CollisionDetector.NEEDLE_RADIUS_MM
  ): CollisionCheckResult {
    if (vessels === undefined) {
      const patient = getPatientAnatomyContext();
      if (patient) {
        const result = patient.vesselClearance(needleStart, needleEnd, needleRadiusMm);
        const min = result.minimumLowerBoundMm;
        return {
          hasCollision: min < CollisionDetector.WARNING_THRESHOLD_MM,
          minDistance: min,
          closestVesselName: result.closestName,
          closestVesselType: result.closestStructure,
          ivcMinDist: result.closestStructure === 'ivc' ? min : Infinity,
          pvMinDist: result.closestStructure === 'portal_vein' ? min : Infinity,
          hvMinDist: result.closestStructure === 'hepatic_vein' ? min : Infinity,
          needlePoint: needleStart.clone(),
          vesselPoint: needleStart.clone(),
          patientSpecific: true,
          conservativeLowerBound: true,
          clinicalSafetyEstablished: false,
        };
      }
      vessels = CollisionDetector.getVascularTree();
    }

    let overallMinDist = Infinity;
    let closestVesselName = 'None';
    let closestVesselType: CollisionCheckResult['closestVesselType'] = 'none';
    let ivcMinDist = Infinity;
    let pvMinDist = Infinity;
    let hvMinDist = Infinity;
    let bestNeedlePt = needleStart.clone();
    let bestVesselPt = needleStart.clone();

    for (const vessel of vessels) {
      const { distCenter, ptNeedle, ptVessel } = CollisionDetector.segmentToSegmentDistance(
        needleStart, needleEnd, vessel.start, vessel.end
      );
      const surfaceDist = Math.max(0, distCenter - vessel.radius - needleRadiusMm);
      if (vessel.type === 'ivc') ivcMinDist = Math.min(ivcMinDist, surfaceDist);
      else if (vessel.type === 'hepatic_vein') hvMinDist = Math.min(hvMinDist, surfaceDist);
      else pvMinDist = Math.min(pvMinDist, surfaceDist);

      if (surfaceDist < overallMinDist) {
        overallMinDist = surfaceDist;
        closestVesselName = vessel.name;
        closestVesselType = vessel.type;
        bestNeedlePt = ptNeedle;
        bestVesselPt = ptVessel;
      }
    }

    return {
      hasCollision: overallMinDist < CollisionDetector.WARNING_THRESHOLD_MM,
      minDistance: Number(overallMinDist.toFixed(1)),
      closestVesselName,
      closestVesselType,
      ivcMinDist: Number(ivcMinDist.toFixed(1)),
      pvMinDist: Number(pvMinDist.toFixed(1)),
      hvMinDist: Number(hvMinDist.toFixed(1)),
      needlePoint: bestNeedlePt,
      vesselPoint: bestVesselPt,
      patientSpecific: false,
      conservativeLowerBound: false,
      clinicalSafetyEstablished: false,
    };
  }

  private static segmentToSegmentDistance(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    q1: THREE.Vector3,
    q2: THREE.Vector3
  ): { distCenter: number; ptNeedle: THREE.Vector3; ptVessel: THREE.Vector3 } {
    const u = new THREE.Vector3().subVectors(p2, p1);
    const v = new THREE.Vector3().subVectors(q2, q1);
    const w = new THREE.Vector3().subVectors(p1, q1);
    const a = u.dot(u), b = u.dot(v), c = v.dot(v), d = u.dot(w), e = v.dot(w);
    const D = a * c - b * b;
    let sc: number, sN: number, sD = D, tc: number, tN: number, tD = D;
    const EPS = 0.00000001;

    if (D < EPS) {
      sN = 0.0; sD = 1.0; tN = e; tD = c;
    } else {
      sN = b * e - c * d;
      tN = a * e - b * d;
      if (sN < 0.0) { sN = 0.0; tN = e; tD = c; }
      else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
    }

    if (tN < 0.0) {
      tN = 0.0;
      if (-d < 0.0) sN = 0.0;
      else if (-d > a) sN = sD;
      else { sN = -d; sD = a; }
    } else if (tN > tD) {
      tN = tD;
      if ((-d + b) < 0.0) sN = 0.0;
      else if ((-d + b) > a) sN = sD;
      else { sN = -d + b; sD = a; }
    }

    sc = Math.abs(sN) < EPS ? 0.0 : sN / sD;
    tc = Math.abs(tN) < EPS ? 0.0 : tN / tD;
    const ptNeedle = new THREE.Vector3().copy(p1).addScaledVector(u, sc);
    const ptVessel = new THREE.Vector3().copy(q1).addScaledVector(v, tc);
    return { distCenter: ptNeedle.distanceTo(ptVessel), ptNeedle, ptVessel };
  }
}
