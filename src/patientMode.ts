import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LESION_PRESETS } from './config/presets';
import {
  resetPatientAnatomyContext,
  setPatientAnatomyContext
} from './math/anatomyContext';
import { PatientAnatomyContext } from './math/patientAnatomy';
import './math/patientSkinProjection';

const originalTargets = new Map<string, THREE.Vector3>();
for (const [key, preset] of Object.entries(LESION_PRESETS)) originalTargets.set(key, preset.tumorPosition.clone());

class PatientPreview {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private anatomyGroup = new THREE.Group();
  private frame = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x04070d, 1);
    host.appendChild(this.renderer.domElement);
    this.camera.position.set(220, 160, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const light = new THREE.DirectionalLight(0xffffff, 1.8);
    light.position.set(100, 150, 180);
    this.scene.add(light, this.anatomyGroup);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.animate();
  }

  private resize() {
    const width = Math.max(260, this.host.clientWidth || 320);
    const height = 210;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  clear() {
    for (const child of [...this.anatomyGroup.children]) {
      this.anatomyGroup.remove(child);
      const object = child as THREE.Points;
      object.geometry?.dispose();
      const material = object.material as THREE.Material | undefined;
      material?.dispose();
    }
  }

  show(context: PatientAnatomyContext) {
    this.clear();
    const specs: Array<[Parameters<PatientAnatomyContext['displaySurfacePoints']>[0], number, number, number]> = [
      ['liver', 0xf37b62, 4.5, 0.35],
      ['tumor', 0xff3b30, 2.5, 1.0],
      ['portal_vein', 0xba9bff, 2.0, 0.95],
      ['hepatic_vein', 0x74e1c9, 2.0, 0.95],
      ['ivc', 0x74bdfb, 2.0, 0.95],
    ];
    const all: THREE.Vector3[] = [];
    for (const [name, color, spacing, opacity] of specs) {
      const points = context.displaySurfacePoints(name, Math.max(spacing, context.spacingMm));
      if (!points.length) continue;
      all.push(...points);
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.PointsMaterial({ color, size: name === 'liver' ? 1.8 : 2.6, transparent: true, opacity });
      const cloud = new THREE.Points(geometry, material);
      cloud.name = `Patient-${name}`;
      this.anatomyGroup.add(cloud);
    }
    if (!all.length) return;
    const box = new THREE.Box3().setFromPoints(all);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(size * 0.75, size * 0.45, size * 0.85));
    this.camera.near = Math.max(0.5, size / 1000);
    this.camera.far = Math.max(1000, size * 5);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}

function equivalentSphereDiameterMm(volumeMl: number): number {
  const volumeMm3 = volumeMl * 1000;
  return 2 * Math.cbrt((3 * volumeMm3) / (4 * Math.PI));
}

function triggerPlanningRefresh(diameterMm?: number) {
  const input = document.getElementById('input-tumor-dia') as HTMLInputElement | null;
  if (input && diameterMm && Number.isFinite(diameterMm)) input.value = diameterMm.toFixed(1);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
  input?.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildPanel(): {
  panel: HTMLElement;
  file: HTMLInputElement;
  lesion: HTMLSelectElement;
  status: HTMLElement;
  previewHost: HTMLElement;
  reset: HTMLButtonElement;
} {
  const panel = document.createElement('section');
  panel.id = 'patient-anatomy-panel';
  panel.className = 'fixed right-3 top-14 z-50 w-[340px] rounded-lg border border-cyan-700/70 bg-slate-950/95 p-3 shadow-2xl text-slate-100';
  panel.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div><div class="text-[10px] font-bold tracking-widest text-cyan-300">PATIENT ANATOMY</div>
      <div class="text-[9px] text-slate-400">reviewed LiverPlan RLE masks · no CT pixels</div></div>
      <button id="patient-anatomy-reset" type="button" class="rounded border border-slate-600 px-2 py-1 text-[9px]">示範模式</button>
    </div>
    <input id="patient-anatomy-file" class="mt-2 block w-full text-[10px]" type="file" accept=".json,.lpanatomy.json,application/json" />
    <label class="mt-2 block text-[9px] text-slate-400">病灶</label>
    <select id="patient-anatomy-lesion" class="w-full rounded bg-slate-900 p-1 text-[10px]"><option value="">尚未載入</option></select>
    <div id="patient-anatomy-status" class="mt-2 rounded bg-slate-900/80 p-2 text-[9px] leading-4 text-slate-300">目前使用 illustrative anatomy。</div>
    <div id="patient-anatomy-preview" class="mt-2 h-[210px] w-full overflow-hidden rounded border border-slate-800"></div>
    <div class="mt-2 text-[8px] leading-3 text-amber-300">Patient mode 的聲窗、肝內穿越、體表交點與血管距離由 masks 計算；若 bundle 沒有 ribs，肋骨/肋間判定標示為未評估。3D 點雲只供顯示，不是計算幾何。</div>`;
  document.body.appendChild(panel);
  return {
    panel,
    file: panel.querySelector('#patient-anatomy-file') as HTMLInputElement,
    lesion: panel.querySelector('#patient-anatomy-lesion') as HTMLSelectElement,
    status: panel.querySelector('#patient-anatomy-status') as HTMLElement,
    previewHost: panel.querySelector('#patient-anatomy-preview') as HTMLElement,
    reset: panel.querySelector('#patient-anatomy-reset') as HTMLButtonElement,
  };
}

function initialize() {
  if (document.getElementById('patient-anatomy-panel')) return;
  const ui = buildPanel();
  const preview = new PatientPreview(ui.previewHost);
  let context: PatientAnatomyContext | null = null;

  const selectLesion = (id: string) => {
    if (!context) return;
    const lesion = context.lesions().find(item => item.id === id);
    if (!lesion) return;
    for (const preset of Object.values(LESION_PRESETS)) preset.tumorPosition.copy(lesion.centroid);
    const diameter = lesion.volumeMl && lesion.volumeMl > 0 ? equivalentSphereDiameterMm(lesion.volumeMl) : undefined;
    triggerPlanningRefresh(diameter);
    ui.status.textContent = `${context.label} · ${lesion.id}${lesion.volumeMl ? ` · ${lesion.volumeMl.toFixed(2)} mL` : ''}。規劃 target 使用該 lesion centroid；顯示球徑${diameter ? `以等體積球 ${diameter.toFixed(1)} mm 表示` : '沿用目前設定'}。`;
  };

  ui.file.addEventListener('change', async () => {
    const file = ui.file.files?.[0];
    if (!file) return;
    try {
      const next = PatientAnatomyContext.fromJson(await file.text());
      context = next;
      setPatientAnatomyContext(next);
      preview.show(next);
      const lesions = next.lesions();
      ui.lesion.replaceChildren();
      for (const lesion of lesions) {
        const option = new Option(`${lesion.id}${lesion.volumeMl ? ` · ${lesion.volumeMl.toFixed(2)} mL` : ''}`, lesion.id);
        ui.lesion.add(option);
      }
      if (!lesions.length) ui.lesion.add(new Option('沒有 lesion metadata', ''));
      const ribs = next.payload.structures.ribs?.voxels ? 'ribs mask 可用' : 'ribs 未提供：肋骨/肋間判定未評估';
      ui.status.textContent = `${next.label} · ${ribs}。所有 patient geometry 都綁定 volume fingerprint。`;
      if (lesions[0]) { ui.lesion.value = lesions[0].id; selectLesion(lesions[0].id); }
    } catch (error) {
      resetPatientAnatomyContext();
      context = null;
      preview.clear();
      ui.status.textContent = `載入失敗：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  ui.lesion.addEventListener('change', () => selectLesion(ui.lesion.value));

  ui.reset.addEventListener('click', () => {
    resetPatientAnatomyContext();
    context = null;
    preview.clear();
    for (const [key, point] of originalTargets) LESION_PRESETS[key as keyof typeof LESION_PRESETS].tumorPosition.copy(point);
    ui.file.value = '';
    ui.lesion.replaceChildren(new Option('尚未載入', ''));
    ui.status.textContent = '目前使用 illustrative anatomy。';
    const active = document.querySelector<HTMLButtonElement>('[id^="preset-btn-"][class*="bg-cyan-600"]');
    active?.click();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
