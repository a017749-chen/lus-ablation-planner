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

export interface AnatomyContext {
  readonly kind: 'patient';
  readonly label: string;
  readonly clinicalValidated: false;
  liverSurface(spacingMm?: number): LiverSurfaceSample[];
  isInsideLiver(point: THREE.Vector3, marginMm?: number): boolean;
  liverNormal(point: THREE.Vector3): THREE.Vector3;
  segmentCrossesLiver(a: THREE.Vector3, b: THREE.Vector3, steps?: number, endClearanceMm?: number): boolean;
  raySkinIntersection(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Vector3 | null;
  anteriorSkinPoint?(x: number, y: number, offsetMm?: number): THREE.Vector3 | null;
  skinNormal(point: THREE.Vector3): THREE.Vector3 | null;
  isUnderSkin(point: THREE.Vector3): boolean;
  ribCageStatus(point: THREE.Vector3): RibCageStatus;
  vesselClearance(start: THREE.Vector3, end: THREE.Vector3, needleRadiusMm?: number): VesselClearanceResult;
  lesions(): AnatomyLesion[];
}

type ContextListener = (context: AnatomyContext | null) => void;
let patientContext: AnatomyContext | null = null;
const listeners = new Set<ContextListener>();

function publish(): void {
  for (const listener of listeners) listener(patientContext);
}

export function setPatientAnatomyContext(context: AnatomyContext): void {
  patientContext = context;
  publish();
}
export function resetPatientAnatomyContext(): void {
  patientContext = null;
  publish();
}
export function getPatientAnatomyContext(): AnatomyContext | null { return patientContext; }
export function isPatientAnatomyActive(): boolean { return patientContext !== null; }
export function onPatientAnatomyContextChange(listener: ContextListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
