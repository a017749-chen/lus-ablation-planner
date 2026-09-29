import * as THREE from 'three';
import { setPatientAnatomyContext, resetPatientAnatomyContext } from '../math/anatomyContext';
import { PatientAnatomyContext, AnatomyRlePayload } from '../math/patientAnatomy';
import '../math/patientSkinProjection';
import {
  isInsideLiver,
  ribCageEvaluationAvailable,
  sampleLiverSurface,
  segmentCrossesLiver
} from '../math/anatomyShapes';
import { getAnteriorSkinSurfacePoint } from '../math/skinSurface';
import { CollisionDetector } from '../math/collision';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string) {
  assert(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertNotEqual<T>(actual: T, expected: T, message: string) {
  assert(actual !== expected, `${message}: both were ${String(actual)}`);
}

const shape: [number, number, number] = [16, 16, 16];
const linear = (i: number, j: number, k: number) => (i * shape[1] + j) * shape[2] + k;

function maskRuns(points: Array<[number, number, number]>) {
  const flat = [...new Set(points.map(([i, j, k]) => linear(i, j, k)))].sort((a, b) => a - b);
  const runs: number[] = [];
  for (let p = 0; p < flat.length;) {
    const start = flat[p];
    let end = p + 1;
    while (end < flat.length && flat[end] === flat[end - 1] + 1) end++;
    runs.push(start, end - p);
    p = end;
  }
  return { encoding: 'binary-flat-c-order-runs-v1', runs, voxels: flat.length };
}

function cube(lo: number, hi: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = lo; i <= hi; i++) for (let j = lo; j <= hi; j++) for (let k = lo; k <= hi; k++) out.push([i, j, k]);
  return out;
}

const portal: Array<[number, number, number]> = [];
const hepatic: Array<[number, number, number]> = [];
for (let j = 4; j <= 11; j++) {
  portal.push([10, j, 8]);
  hepatic.push([6, j, 9]);
}

const payload: AnatomyRlePayload = {
  schema: 'liverplan/anatomy-rle-1',
  anatomy_schema: 'liverplan/anatomy-1',
  coordinate_system: 'DICOM-LPS-mm',
  volume_fingerprint: 'unit-test-fingerprint',
  reviewed: true,
  ct_pixels_included: false,
  planning_grid: {
    shape,
    spacing_mm: 2,
    origin_lps_mm: [-16, -16, -16]
  },
  structures: {
    body: maskRuns(cube(1, 14)),
    liver: maskRuns(cube(4, 11)),
    tumor: maskRuns(cube(7, 8)),
    portal_vein: maskRuns(portal),
    hepatic_vein: maskRuns(hepatic)
  },
  lesions: [{ id: 'lesion-001', ml: 0.064, centroid_lps_mm: [-1, -1, -1] }],
  clinical_validated: false
};

console.log('Patient anatomy context');
const cachedSurface = sampleLiverSurface(2.5);
const illustrativeLength = cachedSurface.length;
assert(illustrativeLength > 0, 'illustrative surface must be non-empty');

const context = new PatientAnatomyContext(payload);
setPatientAnatomyContext(context);

assertEqual(sampleLiverSurface(2.5), cachedSurface, 'cached surface array identity must stay stable');
assertNotEqual(cachedSurface.length, illustrativeLength, 'cached contents must refresh to patient liver surface');
assertEqual(isInsideLiver(new THREE.Vector3(0, 0, 0)), true, 'origin should be inside patient liver cube');
assertEqual(isInsideLiver(new THREE.Vector3(25, 25, 25)), false, 'far point should be outside patient liver');
assertEqual(segmentCrossesLiver(new THREE.Vector3(0, 0, 15), new THREE.Vector3(0, 0, -10)), true, 'segment should cross patient liver');

const skin = getAnteriorSkinSurfacePoint(0, 0);
assert(skin, 'patient body mask must provide an anterior skin point');
assert(Math.abs(skin.z - 15) < 2.5, `unexpected anterior skin z=${skin.z}`);
assertEqual(ribCageEvaluationAvailable(), false, 'ribs absent must be reported as not evaluable');

const collision = CollisionDetector.checkCollision(
  new THREE.Vector3(4, 0, 15),
  new THREE.Vector3(4, 0, -10)
);
assertEqual(collision.patientSpecific, true, 'collision must use patient vessel masks');
assertEqual(collision.closestVesselType, 'portal_vein', 'closest structure should remain portal vein');
assert(collision.minDistance <= 5, `expected near-PV path, got ${collision.minDistance}`);
assertEqual(collision.clinicalSafetyEstablished, false, 'geometry must not establish clinical safety');

const lesions = context.lesions();
assertEqual(lesions.length, 1, 'one patient lesion should be exposed');
assertEqual(lesions[0].id, 'lesion-001', 'lesion identity should be stable');
assert(lesions[0].centroid.distanceTo(new THREE.Vector3(-1, -1, 1)) < 1e-9, 'LPS lesion centroid must map to scene L,S,-P');

resetPatientAnatomyContext();
assertEqual(sampleLiverSurface(2.5), cachedSurface, 'cache array identity must also survive reset');
assertEqual(cachedSurface.length, illustrativeLength, 'reset must repopulate original illustrative surface');
assertEqual(
  CollisionDetector.checkCollision(new THREE.Vector3(4, 0, 15), new THREE.Vector3(4, 0, -10)).patientSpecific,
  false,
  'reset must restore illustrative vessel path'
);
console.log('PASS patient anatomy context, skin projection, vessels and cache invalidation');
