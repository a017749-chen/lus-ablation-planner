import * as THREE from 'three';
import {
  isInsideLiver,
  isOverRibCage,
  liverNormal,
  LiverSurfaceSample,
  raySkinIntersection,
  sampleLiverSurface,
  segmentCrossesLiver
} from './anatomyShapes';
import { CollisionDetector } from './collision';
import { getAnteriorSkinSurfaceNormal, getAnteriorSkinSurfacePoint } from './skinSurface';

export type RibCageStatus = 'over' | 'clear' | 'not-evaluable';
export type VascularStructure = 'portal_vein' | 'hepatic_vein' | 'ivc' | 'illustrative_vessel';

export interface AnatomyLesion {
  id: string;
  centroid: THREE.Vector3;
  volumeMl?: number;
}

export interface VesselClearanceResult {
  /** Conservative surface-to-surface lower bound in millimetres. */
  minimumLowerBoundMm: number;
  closestStructure: VascularStructure | 'none';
  closestName: string;
  warningThresholdMm: number;
  segmentedStructures: VascularStructure[];
  exactNearestWithinIndexedGeometry: boolean;
  clinicalSafetyEstablished: false;
}

export interface AnatomyContext {
  readonly kind: 'illustrative' | 'patient';
  readonly label: string;
  readonly clinicalValidated: false;
  liverSurface(spacingMm?: number): LiverSurfaceSample[];
  isInsideLiver(point: THREE.Vector3, marginMm?: number): boolean;
  liverNormal(point: THREE.Vector3): THREE.Vector3;
  segmentCrossesLiver(a: THREE.Vector3, b: THREE.Vector3, steps?: number, endClearanceMm?: number): boolean;
  raySkinIntersection(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Vector3 | null;
  skinNormal(point: THREE.Vector3): THREE.Vector3 | null;
  isUnderSkin(point: THREE.Vector3): boolean;
  ribCageStatus(point: THREE.Vector3): RibCageStatus;
  vesselClearance(start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm?: number): VesselClearanceResult;
  lesions(): AnatomyLesion[];
}

class IllustrativeAnatomyContext implements AnatomyContext {
  readonly kind = 'illustrative' as const;
  readonly label = 'Illustrative analytic anatomy';
  readonly clinicalValidated = false as const;

  liverSurface(spacingMm = 2.5) { return sampleLiverSurface(spacingMm); }
  isInsideLiver(point: THREE.Vector3, marginMm = 0) { return isInsideLiver(point, marginMm); }
  liverNormal(point: THREE.Vector3) { return liverNormal(point); }
  segmentCrossesLiver(a: THREE.Vector3, b: THREE.Vector3, steps = 24, endClearanceMm = 2) {
    return segmentCrossesLiver(a, b, steps, endClearanceMm);
  }
  raySkinIntersection(origin: THREE.Vector3, direction: THREE.Vector3) {
    return raySkinIntersection(origin, direction);
  }
  skinNormal(point: THREE.Vector3) {
    return getAnteriorSkinSurfaceNormal(point.x, point.y);
  }
  isUnderSkin(point: THREE.Vector3) {
    const skin = getAnteriorSkinSurfacePoint(point.x, point.y);
    return !!skin && point.z < skin.z - 1;
  }
  ribCageStatus(point: THREE.Vector3): RibCageStatus {
    return isOverRibCage(point.x, point.y) ? 'over' : 'clear';
  }
  vesselClearance(start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm = CollisionDetector.NEEDLE_RADIUS_MM): VesselClearanceResult {
    const out = CollisionDetector.checkCollision(start, end, undefined, needleRadiusMm);
    return {
      minimumLowerBoundMm: out.minDistance,
      closestStructure: 'illustrative_vessel',
      closestName: out.closestVesselName,
      warningThresholdMm: CollisionDetector.WARNING_THRESHOLD_MM,
      segmentedStructures: ['illustrative_vessel'],
      exactNearestWithinIndexedGeometry: true,
      clinicalSafetyEstablished: false,
    };
  }
  lesions(): AnatomyLesion[] { return []; }
}

const illustrative = new IllustrativeAnatomyContext();
let active: AnatomyContext = illustrative;

/** Explicitly switch the single-user planner between illustrative and patient anatomy. */
export function setAnatomyContext(context: AnatomyContext): void { active = context; }
export function resetAnatomyContext(): void { active = illustrative; }
export function getAnatomyContext(): AnatomyContext { return active; }

// Thin dispatch helpers keep the existing planner API stable while all geometric
// questions are routed through one explicit context.
export const activeLiverSurface = (spacingMm = 2.5) => active.liverSurface(spacingMm);
export const activeLiverNormal = (point: THREE.Vector3) => active.liverNormal(point);
export const activeSegmentCrossesLiver = (a: THREE.Vector3, b: THREE.Vector3, steps = 24, endClearanceMm = 2) =>
  active.segmentCrossesLiver(a, b, steps, endClearanceMm);
export const activeRaySkinIntersection = (origin: THREE.Vector3, direction: THREE.Vector3) =>
  active.raySkinIntersection(origin, direction);
export const activeSkinNormal = (point: THREE.Vector3) => active.skinNormal(point);
export const activeIsUnderSkin = (point: THREE.Vector3) => active.isUnderSkin(point);
export const activeRibCageStatus = (point: THREE.Vector3) => active.ribCageStatus(point);
export const activeVesselClearance = (start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm?: number) =>
  active.vesselClearance(start, end, needleRadiusMm);
