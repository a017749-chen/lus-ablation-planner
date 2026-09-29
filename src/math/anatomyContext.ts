import * as THREE from 'three';

export type RibCageStatus = 'over' | 'clear' | 'not-evaluable';
export type VascularStructure = 'portal_vein' | 'hepatic_vein' | 'ivc';

export interface LiverSurfaceSample {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface AnatomyLesion {
  id: string;
  centroid: THREE.Vector3;
  volumeMl?: number;
}

export interface VesselClearanceResult {
  /** Conservative shaft-to-segmented-vessel surface lower bound in millimetres. */
  minimumLowerBoundMm: number;
  closestStructure: VascularStructure | 'none';
  closestName: string;
  warningThresholdMm: number;
  segmentedStructures: VascularStructure[];
  exactNearestWithinIndexedGeometry: boolean;
  clinicalSafetyEstablished: false;
}

/**
 * Patient anatomy override used by the existing planner geometry helpers.
 *
 * When no override is active, anatomyShapes/skinSurface/collision keep using their
 * original illustrative analytic geometry. This keeps all existing demo and
 * regression behaviour unchanged until a reviewed patient anatomy is loaded.
 */
export interface AnatomyContext {
  readonly kind: 'patient';
  readonly label: string;
  readonly clinicalValidated: false;
  liverSurface(spacingMm?: number): LiverSurfaceSample[];
  isInsideLiver(point: THREE.Vector3, marginMm?: number): boolean;
  liverNormal(point: THREE.Vector3): THREE.Vector3;
  segmentCrossesLiver(a: THREE.Vector3, b: THREE.Vector3, steps?: number, endClearanceMm?: number): boolean;
  raySkinIntersection(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Vector3 | null;
  anteriorSkinPoint(x: number, y: number, offsetMm?: number): THREE.Vector3 | null;
  skinNormal(point: THREE.Vector3): THREE.Vector3 | null;
  isUnderSkin(point: THREE.Vector3): boolean;
  ribCageStatus(point: THREE.Vector3): RibCageStatus;
  vesselClearance(start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm?: number): VesselClearanceResult;
  lesions(): AnatomyLesion[];
}

let patientContext: AnatomyContext | null = null;

export function setPatientAnatomyContext(context: AnatomyContext): void { patientContext = context; }
export function resetPatientAnatomyContext(): void { patientContext = null; }
export function getPatientAnatomyContext(): AnatomyContext | null { return patientContext; }
export function isPatientAnatomyActive(): boolean { return patientContext !== null; }
