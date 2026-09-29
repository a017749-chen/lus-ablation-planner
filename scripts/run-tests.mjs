import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const typescript = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};

// Each file runs even if an earlier one fails, so one broken area cannot hide another.
let failures = 0;
for (const file of [
  '../src/test/verify.ts',
  '../src/test/planner.ts',
  '../src/test/patientAnatomy.ts'
]) {
  console.log(`\n### ${file}`);
  try {
    require(file);
    if (process.exitCode) failures++;
    process.exitCode = 0;
  } catch (error) {
    failures++;
    console.log(`FAIL: ${error.message}`);
  }
}

// The patient module is intentionally browser-only and therefore cannot execute in
// this Node math harness. Still guard the integration point so a green build cannot
// ship the module as unreachable/dead code again.
try {
  const viewport = readFileSync(new URL('../src/views/MultiViewport.ts', import.meta.url), 'utf8');
  if (!viewport.includes("import('../patientMode')")) {
    throw new Error('browser runtime does not load patientMode.ts');
  }
  console.log('\nPASS patientMode browser bootstrap is wired into the runtime graph');
} catch (error) {
  failures++;
  console.log(`\nFAIL patientMode bootstrap: ${error.message}`);
}

// Cross-repository contract guard. This fixture mirrors the JSON shape emitted by
// liverplan-core 0.6.3 build_anatomy_rle(), including optional rib anatomy. It is a
// transport/parser compatibility test, not a segmentation or clinical validation.
try {
  const fixtureText = readFileSync(
    new URL('../src/test/fixtures/core-anatomy-rle-0.6.3.json', import.meta.url),
    'utf8'
  );
  const fixture = JSON.parse(fixtureText);
  const { PatientAnatomyContext, ANATOMY_RLE_SCHEMA } = require('../src/math/patientAnatomy.ts');
  const THREE = require('three');

  if (fixture.schema !== ANATOMY_RLE_SCHEMA) throw new Error(`schema drift: ${fixture.schema}`);
  if (fixture.provenance?.core_version !== '0.6.3') throw new Error('golden fixture core version is not 0.6.3');
  if (fixture.ct_pixels_included !== false) throw new Error('transport fixture unexpectedly contains CT pixels');

  const context = PatientAnatomyContext.fromJson(fixtureText);
  const lesions = context.lesions();
  if (lesions.length !== 1 || lesions[0].id !== 'lesion-001') throw new Error('lesion identity did not survive Core transport');
  if (lesions[0].centroid.distanceTo(new THREE.Vector3(-1, -1, 1)) > 1e-9) {
    throw new Error('LPS lesion centroid did not map to LUS scene coordinates');
  }
  if (!context.displaySurfacePoints('liver', 2).length) throw new Error('liver RLE did not produce patient display geometry');
  if (!context.displaySurfacePoints('ribs', 2).length) throw new Error('rib RLE did not survive transport');
  if (context.ribCageStatus(new THREE.Vector3(0, 4, 0)) !== 'over') {
    throw new Error('patient rib geometry is not used by intercostal proximity check');
  }

  const vessel = context.vesselClearance(
    new THREE.Vector3(2, 0, 5),
    new THREE.Vector3(2, 0, -5)
  );
  if (vessel.closestStructure !== 'portal_vein') {
    throw new Error(`vascular identity drift: expected portal_vein, got ${vessel.closestStructure}`);
  }
  if (!vessel.segmentedStructures.includes('hepatic_vein') || !vessel.segmentedStructures.includes('ivc')) {
    throw new Error('PV/HV/IVC identities were not all indexed from Core transport');
  }
  if (vessel.clinicalSafetyEstablished !== false) throw new Error('transport must not establish clinical safety');

  console.log('\nPASS liverplan-core 0.6.3 anatomy-rle contract -> LUS parser/geometry');
} catch (error) {
  failures++;
  console.log(`\nFAIL Core anatomy-rle contract: ${error.message}`);
}

process.exitCode = failures ? 1 : 0;
if (failures) console.log(`\n${failures} test area(s) failed.`);
