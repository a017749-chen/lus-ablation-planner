import * as THREE from 'three';
import './style.css';
import { LESION_PRESETS, LesionPreset, TROCAR_PRESETS } from './config/presets';
import { AnatomyBuilder, AnatomyMeshes } from './scene/AnatomyBuilder';
import { InstrumentBuilder, InstrumentSystem } from './scene/Instruments';
import { MultiViewport, ViewportManager } from './views/MultiViewport';
import { UltrasoundSim } from './views/UltrasoundSim';
import { AlignmentEngine, AlignmentResult } from './math/alignmentEngine';
import { CollisionDetector, CollisionCheckResult } from './math/collision';
import { WedgeOptimizer } from './math/wedgeOptimizer';

class SurgicalPlannerApp {
  private scene: THREE.Scene;
  private viewports!: ViewportManager;
  private anatomy!: AnatomyMeshes;
  private instruments!: InstrumentSystem;
  private ultrasoundSim!: UltrasoundSim;

  // Active surgical state
  private activePreset: LesionPreset = LESION_PRESETS['S5_S6'];
  private activeTrocarId: string = 'subcostal';
  private needleTrocarId: string = 'subcostal';
  private needleMode: 'trocar' | 'percutaneous' = 'trocar';
  private percutaneousPivot: THREE.Vector3 = new THREE.Vector3(65, 0, 70);

  // Probe Kinematics
  private probeDepth: number = 120;
  private probePitch: number = 28;
  private probeYaw: number = 12;
  private probeRoll: number = 0;

  // Needle Kinematics
  private needleDepth: number = 85;
  private needlePitch: number = 42;
  private needleYaw: number = -15;

  // Tumor & Margin
  private tumorDiameter: number = 20;
  private safetyMargin: number = 5.0;

  // Thermal Ablation
  private isAblationSimActive: boolean = false;
  private ablationDiameter: number = 35.0;

  // Latest math results
  private latestAlignment!: AlignmentResult;
  private latestCollision!: CollisionCheckResult;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05080e);

    this.initLights();
    this.initSceneObjects();
    this.initViewports();
    this.initUltrasoundCanvas();
    this.bindUIEvents();
    this.loadPreset('S5_S6');
    this.animate();
  }

  private initLights() {
    // Ambient clinical light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambientLight);

    // Main surgical overhead spotlight
    const overheadLight = new THREE.DirectionalLight(0xe0f7fa, 1.8);
    overheadLight.position.set(50, 150, 120);
    this.scene.add(overheadLight);

    // Rim / Back light for organ contours
    const rimLight = new THREE.DirectionalLight(0x00d2ff, 0.9);
    rimLight.position.set(-80, -100, -80);
    this.scene.add(rimLight);

    // Subtle blue fill light
    const fillLight = new THREE.DirectionalLight(0x7c4dff, 0.6);
    fillLight.position.set(0, -120, 80);
    this.scene.add(fillLight);
  }

  private initSceneObjects() {
    // Build procedural liver anatomy, vessels, dome
    this.anatomy = AnatomyBuilder.build();
    this.scene.add(this.anatomy.group);

    // Build trocars, LUS probe, US plane, ablation needle
    this.instruments = InstrumentBuilder.build();
    this.scene.add(this.instruments.group);
  }

  private initViewports() {
    const mainContainer = document.getElementById('webgl-container')!;
    const lapContainer = document.getElementById('laparoscope-viewport')!;
    this.viewports = MultiViewport.init(mainContainer, lapContainer);
  }

  private initUltrasoundCanvas() {
    const usCanvas = document.getElementById('us-canvas') as HTMLCanvasElement;
    this.ultrasoundSim = new UltrasoundSim(usCanvas);
  }

  /**
   * Load anatomical & surgical configuration presets
   */
  public loadPreset(presetKey: 'S2_S3' | 'S5_S6' | 'S7_S8') {
    const preset = LESION_PRESETS[presetKey];
    if (!preset) return;
    this.activePreset = preset;

    // Update preset UI highlight
    ['s2s3', 's5s6', 's7s8'].forEach(k => {
      const btn = document.getElementById(`preset-btn-${k}`);
      if (btn) {
        btn.className = 'px-2.5 py-1 rounded transition-colors text-slate-400 hover:text-white';
      }
    });

    const activeBtnKey = presetKey === 'S2_S3' ? 's2s3' : presetKey === 'S5_S6' ? 's5s6' : 's7s8';
    const activeBtn = document.getElementById(`preset-btn-${activeBtnKey}`);
    if (activeBtn) {
      activeBtn.className = 'px-2.5 py-1 rounded transition-colors bg-cyan-600 text-white font-semibold shadow-sm';
    }

    // Set segment label
    const labelSeg = document.getElementById('label-active-segment');
    if (labelSeg) labelSeg.textContent = preset.segmentName;

    // ITT Trocar handling for S7/S8 Diaphragm dome
    const ittDef = TROCAR_PRESETS['itt'];
    const ittBtn = document.getElementById('btn-trocar-itt');
    const ittPill = document.getElementById('itt-status-pill');

    if (preset.requiresITT) {
      ittDef.isActive = true;
      this.instruments.setTrocarActive('itt', true);
      this.needleTrocarId = 'itt';
      if (ittBtn) {
        ittBtn.className = 'p-1.5 rounded border border-amber-500 bg-amber-950/40 text-left shadow-sm';
      }
      if (ittPill) {
        ittPill.textContent = '已啟用';
        ittPill.className = 'text-[8px] px-1 bg-amber-500 text-black font-bold rounded animate-pulse';
      }
    } else {
      ittDef.isActive = false;
      this.instruments.setTrocarActive('itt', false);
      if (this.needleTrocarId === 'itt') this.needleTrocarId = 'subcostal';
      if (ittBtn) {
        ittBtn.className = 'p-1.5 rounded border border-amber-800/60 bg-slate-900 text-left opacity-60 hover:opacity-100 transition-opacity';
      }
      if (ittPill) {
        ittPill.textContent = '待命';
        ittPill.className = 'text-[8px] px-1 bg-amber-950 text-amber-300 rounded';
      }
    }

    // Update Probe and Needle parameters
    this.tumorDiameter = preset.tumorDiameter;
    this.safetyMargin = preset.safetyMargin;

    this.probeDepth = preset.probeInitialConfig.depth;
    this.probePitch = preset.probeInitialConfig.pitch;
    this.probeYaw = preset.probeInitialConfig.yaw;
    this.probeRoll = preset.probeInitialConfig.roll;

    this.needleDepth = preset.needleInitialConfig.depth;
    this.needlePitch = preset.needleInitialConfig.pitch;
    this.needleYaw = preset.needleInitialConfig.yaw;

    // Sync input sliders
    this.syncSlidersToState();
    this.updateKinematicsAndMath();
  }

  private syncSlidersToState() {
    (document.getElementById('input-tumor-dia') as HTMLInputElement).value = String(this.tumorDiameter);
    document.getElementById('val-tumor-dia')!.textContent = `${this.tumorDiameter.toFixed(1)} mm`;

    (document.getElementById('input-margin-dist') as HTMLInputElement).value = String(this.safetyMargin);
    document.getElementById('val-margin-dist')!.textContent = `+${this.safetyMargin.toFixed(1)} mm`;

    (document.getElementById('input-probe-depth') as HTMLInputElement).value = String(this.probeDepth);
    document.getElementById('val-probe-depth')!.textContent = `${this.probeDepth} mm`;

    (document.getElementById('input-probe-pitch') as HTMLInputElement).value = String(this.probePitch);
    document.getElementById('val-probe-pitch')!.textContent = `${this.probePitch.toFixed(1)}°`;

    (document.getElementById('input-probe-yaw') as HTMLInputElement).value = String(this.probeYaw);
    document.getElementById('val-probe-yaw')!.textContent = `${this.probeYaw.toFixed(1)}°`;

    (document.getElementById('input-probe-roll') as HTMLInputElement).value = String(this.probeRoll);
    document.getElementById('val-probe-roll')!.textContent = `${this.probeRoll.toFixed(1)}°`;

    (document.getElementById('input-needle-depth') as HTMLInputElement).value = String(this.needleDepth);
    document.getElementById('val-needle-depth')!.textContent = `${this.needleDepth.toFixed(1)} mm`;

    (document.getElementById('input-needle-pitch') as HTMLInputElement).value = String(this.needlePitch);
    document.getElementById('val-needle-pitch')!.textContent = `${this.needlePitch.toFixed(1)}°`;

    (document.getElementById('input-needle-yaw') as HTMLInputElement).value = String(this.needleYaw);
    document.getElementById('val-needle-yaw')!.textContent = `${this.needleYaw.toFixed(1)}°`;
  }

  /**
   * One-Click Auto-Align to US Scan Plane (一鍵自動回正)
   */
  public autoAlignToUSPlane() {
    const probePlane = this.instruments.getProbeUSPlaneData();
    const trocarDef = TROCAR_PRESETS[this.needleTrocarId] || TROCAR_PRESETS['subcostal'];
    const pivot = this.needleMode === 'trocar' ? trocarDef.pivotPosition : this.percutaneousPivot;
    const normal = this.needleMode === 'trocar' ? trocarDef.defaultDirection : new THREE.Vector3(0, 0, -1);

    const solution = WedgeOptimizer.autoAlignNeedle(
      pivot,
      normal,
      probePlane.origin,
      probePlane.normal,
      probePlane.xAxis,
      probePlane.yAxis,
      this.activePreset.tumorPosition,
      this.needleMode === 'percutaneous'
    );

    this.needlePitch = Number(solution.pitch.toFixed(1));
    this.needleYaw = Number(solution.yaw.toFixed(1));
    this.needleDepth = Number(solution.depth.toFixed(1));

    if (solution.adjustedPivot && this.needleMode === 'percutaneous') {
      this.percutaneousPivot.copy(solution.adjustedPivot);
    }

    this.syncSlidersToState();
    this.updateKinematicsAndMath();

    // Trigger visual celebration ripple
    const btn = document.getElementById('btn-auto-align');
    if (btn) {
      btn.classList.add('scale-105', 'ring-4', 'ring-emerald-400');
      setTimeout(() => {
        btn.classList.remove('scale-105', 'ring-4', 'ring-emerald-400');
      }, 400);
    }
  }

  /**
   * Main mathematical update cycle
   */
  private updateKinematicsAndMath() {
    // 1. Update Tumor & Safety Margin geometry
    this.anatomy.updateTumor(this.activePreset.tumorPosition, this.tumorDiameter, this.safetyMargin);

    // 2. Update LUS Probe kinematics
    this.instruments.updateProbe(
      this.activeTrocarId,
      this.probeDepth,
      this.probePitch,
      this.probeYaw,
      this.probeRoll
    );

    // 3. Update Ablation Needle kinematics
    this.instruments.updateNeedle(
      this.needleMode,
      this.needleTrocarId,
      this.percutaneousPivot,
      this.needleDepth,
      this.needlePitch,
      this.needleYaw
    );

    // 4. In-Plane Alignment Calculation
    const planeData = this.instruments.getProbeUSPlaneData();
    const needleSegment = this.instruments.getNeedleSegment();

    this.latestAlignment = AlignmentEngine.evaluate(
      planeData.origin,
      planeData.normal,
      planeData.xAxis,
      planeData.yAxis,
      needleSegment.entry,
      needleSegment.tip
    );

    // Update needle visuals
    this.instruments.setNeedleAlignmentVisuals(this.latestAlignment.status);

    // 5. Collision Detection with Critical Vessels
    this.latestCollision = CollisionDetector.checkCollision(
      needleSegment.entry,
      needleSegment.tip
    );
    this.anatomy.setVesselAlert(this.latestCollision.hasCollision);

    // 6. Update Thermal Ablation Zone & Coverage
    this.instruments.setAblationPreview(this.isAblationSimActive, this.ablationDiameter);
    this.updateThermalCoverage(needleSegment.tip);

    // 7. Update Surgical HUD Telemetry
    this.updateHUDTelemetry(needleSegment.tip);
  }

  /**
   * Compute 3D volumetric thermal margin coverage
   */
  private updateThermalCoverage(needleTip: THREE.Vector3) {
    const tumorCenter = this.activePreset.tumorPosition;
    const tumorRadius = this.tumorDiameter * 0.5;
    const totalTargetRadius = tumorRadius + this.safetyMargin;

    // Ablation center is ~4mm behind needle tip
    const ablationCenter = needleTip.clone().add(new THREE.Vector3(0, -4, 0));
    const distCenterToCenter = ablationCenter.distanceTo(tumorCenter);
    const ablationRadius = this.ablationDiameter * 0.5;

    // Coverage calculation: check if target sphere is fully inside ablation sphere
    let coveragePercent = 0;
    if (this.isAblationSimActive) {
      if (distCenterToCenter + totalTargetRadius <= ablationRadius) {
        coveragePercent = 100;
      } else if (distCenterToCenter >= ablationRadius + totalTargetRadius) {
        coveragePercent = 0;
      } else {
        // Approximate geometric intersection ratio
        const overlap = Math.max(0, ablationRadius - (distCenterToCenter - totalTargetRadius));
        coveragePercent = Math.min(99, Math.max(10, Math.round((overlap / (totalTargetRadius * 2)) * 100)));
      }
    }

    // Telemetry updates
    const coverageText = document.getElementById('hud-coverage-percent');
    const coverageRing = document.getElementById('hud-coverage-ring');
    const coverageStat = document.getElementById('ablation-coverage-stat');
    const radNecrosis = document.getElementById('ablation-rad-necrosis');

    if (radNecrosis) {
      radNecrosis.textContent = `${(this.ablationDiameter * 0.5).toFixed(1)} mm`;
    }

    if (!this.isAblationSimActive) {
      if (coverageText) coverageText.textContent = '0% (PREVIEW OFF)';
      if (coverageRing) coverageRing.setAttribute('stroke-dashoffset', '62.8');
      if (coverageStat) coverageStat.textContent = '未啟用';
    } else {
      if (coverageText) {
        coverageText.textContent = `${coveragePercent}% ${coveragePercent === 100 ? '(COMPLETE)' : '(INCOMPLETE)'}`;
        coverageText.className = `font-bold text-xs ${coveragePercent === 100 ? 'text-emerald-400' : 'text-amber-400'}`;
      }
      if (coverageRing) {
        const offset = 62.8 * (1 - coveragePercent / 100);
        coverageRing.setAttribute('stroke-dashoffset', String(offset));
        coverageRing.setAttribute('class', coveragePercent === 100 ? 'text-emerald-400 transition-all duration-300' : 'text-amber-400 transition-all duration-300');
      }
      if (coverageStat) {
        coverageStat.textContent = coveragePercent === 100 ? '100% (完全根治覆蓋)' : `${coveragePercent}% (消融邊緣未包覆)`;
        coverageStat.className = coveragePercent === 100 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
      }
    }
  }

  /**
   * Update HUD Telemetry Panel
   */
  private updateHUDTelemetry(needleTip: THREE.Vector3) {
    // 1. In-Plane Status Badge
    const card = document.getElementById('hud-alignment-card');
    const dot = document.getElementById('hud-alignment-dot');
    const text = document.getElementById('hud-alignment-text');
    const offset = document.getElementById('hud-alignment-offset');
    const usHudStatus = document.getElementById('us-hud-needle-status');

    if (card && dot && text && offset) {
      if (this.latestAlignment.status === 'IN_PLANE') {
        card.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-md border transition-all duration-300 bg-emerald-950/50 border-emerald-500/80 text-emerald-300 shadow-glow-neon';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm animate-pulse';
        text.className = 'text-xs font-bold font-mono tracking-tight text-emerald-300';
        text.textContent = 'ALIGNED / IN-PLANE';
        offset.className = 'text-[11px] font-mono font-bold ml-1 bg-black/40 px-1.5 py-0.5 rounded text-emerald-300';
        offset.textContent = `Δ ${this.latestAlignment.offsetMm.toFixed(1)} mm`;
        if (usHudStatus) {
          usHudStatus.textContent = 'GUIDE: IN-PLANE ALIGNED';
          usHudStatus.className = 'absolute top-1 right-2 pointer-events-none font-mono text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-500 text-emerald-300';
        }
      } else if (this.latestAlignment.status === 'CROSS_PLANE') {
        card.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-md border transition-all duration-300 bg-amber-950/40 border-amber-500/80 text-amber-300';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 shadow-sm animate-pulse';
        text.className = 'text-xs font-bold font-mono tracking-tight text-amber-300';
        text.textContent = 'CROSS-PLANE (PARTIAL)';
        offset.className = 'text-[11px] font-mono font-bold ml-1 bg-black/40 px-1.5 py-0.5 rounded text-amber-300';
        offset.textContent = `∠ ${this.latestAlignment.angleToPlaneDeg.toFixed(1)}°`;
        if (usHudStatus) {
          usHudStatus.textContent = 'GUIDE: CROSS-PLANE DOT';
          usHudStatus.className = 'absolute top-1 right-2 pointer-events-none font-mono text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500 text-amber-300';
        }
      } else {
        card.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-md border transition-all duration-300 bg-red-950/40 border-red-500/60 text-red-400';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm animate-pulse';
        text.className = 'text-xs font-bold font-mono tracking-tight text-red-400';
        text.textContent = 'OUT-OF-PLANE';
        offset.className = 'text-[11px] font-mono font-bold ml-1 bg-black/40 px-1.5 py-0.5 rounded text-red-300';
        offset.textContent = `Δ ${this.latestAlignment.offsetMm.toFixed(1)} mm`;
        if (usHudStatus) {
          usHudStatus.textContent = 'GUIDE: NO ECHO';
          usHudStatus.className = 'absolute top-1 right-2 pointer-events-none font-mono text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-950/80 border border-red-500 text-red-300';
        }
      }
    }

    // 2. Vessel Distances & Collision Warning
    const ivcElem = document.getElementById('hud-ivc-dist');
    const pvElem = document.getElementById('hud-pv-dist');
    const alertElem = document.getElementById('hud-vessel-alert');

    if (ivcElem) ivcElem.textContent = `${this.latestCollision.ivcMinDist.toFixed(1)} mm`;
    if (pvElem) pvElem.textContent = `${this.latestCollision.pvMinDist.toFixed(1)} mm`;

    if (alertElem) {
      if (this.latestCollision.hasCollision) {
        alertElem.classList.remove('hidden');
        alertElem.textContent = `ALERT: < 5mm to ${this.latestCollision.closestVesselName.split(' ')[0]}`;
      } else {
        alertElem.classList.add('hidden');
      }
    }

    // 3. Floating 3D Tip Coordinates
    const tipCoordElem = document.getElementById('scene-tip-coord');
    const needleDepthElem = document.getElementById('scene-needle-depth');
    if (tipCoordElem) {
      tipCoordElem.textContent = `X: ${needleTip.x.toFixed(1)}, Y: ${needleTip.y.toFixed(1)}, Z: ${needleTip.z.toFixed(1)}`;
    }
    if (needleDepthElem) {
      needleDepthElem.textContent = `${this.needleDepth.toFixed(1)} mm`;
    }
  }

  /**
   * Bind all DOM interactions and sliders
   */
  private bindUIEvents() {
    // Lesion Preset buttons
    document.getElementById('preset-btn-s2s3')?.addEventListener('click', () => this.loadPreset('S2_S3'));
    document.getElementById('preset-btn-s5s6')?.addEventListener('click', () => this.loadPreset('S5_S6'));
    document.getElementById('preset-btn-s7s8')?.addEventListener('click', () => this.loadPreset('S7_S8'));

    // Camera presets
    document.getElementById('btn-cam-ap')?.addEventListener('click', () => this.viewports.setCameraPreset('ap'));
    document.getElementById('btn-cam-lateral')?.addEventListener('click', () => this.viewports.setCameraPreset('lateral'));
    document.getElementById('btn-cam-superior')?.addEventListener('click', () => this.viewports.setCameraPreset('superior'));
    document.getElementById('btn-cam-surgeon')?.addEventListener('click', () => this.viewports.setCameraPreset('surgeon'));
    document.getElementById('btn-cam-reset')?.addEventListener('click', () => this.viewports.setCameraPreset('reset'));

    // Layer toggles
    document.getElementById('layer-dome')?.addEventListener('change', (e) => {
      this.anatomy.abdominalDome.visible = (e.target as HTMLInputElement).checked;
    });
    document.getElementById('layer-liver')?.addEventListener('change', (e) => {
      this.anatomy.liverGroup.visible = (e.target as HTMLInputElement).checked;
    });
    document.getElementById('layer-vessels')?.addEventListener('change', (e) => {
      this.anatomy.vesselsGroup.visible = (e.target as HTMLInputElement).checked;
    });
    document.getElementById('layer-usslice')?.addEventListener('change', (e) => {
      this.instruments.usSliceMesh.visible = (e.target as HTMLInputElement).checked;
    });
    document.getElementById('layer-margin')?.addEventListener('change', (e) => {
      this.anatomy.marginMesh.visible = (e.target as HTMLInputElement).checked;
    });

    // Tumor & Margin Sliders
    const inputTumorDia = document.getElementById('input-tumor-dia') as HTMLInputElement;
    inputTumorDia?.addEventListener('input', (e) => {
      this.tumorDiameter = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-tumor-dia')!.textContent = `${this.tumorDiameter.toFixed(1)} mm`;
      this.updateKinematicsAndMath();
    });

    const inputMarginDist = document.getElementById('input-margin-dist') as HTMLInputElement;
    inputMarginDist?.addEventListener('input', (e) => {
      this.safetyMargin = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-margin-dist')!.textContent = `+${this.safetyMargin.toFixed(1)} mm`;
      this.updateKinematicsAndMath();
    });

    // Trocar selection buttons
    ['umbilical', 'subxiphoid', 'subcostal', 'itt'].forEach(id => {
      document.getElementById(`btn-trocar-${id}`)?.addEventListener('click', () => {
        this.activeTrocarId = id;
        this.needleTrocarId = id;
        this.updateKinematicsAndMath();
      });
    });

    // LUS Probe Articulation Sliders
    const inputProbeDepth = document.getElementById('input-probe-depth') as HTMLInputElement;
    inputProbeDepth?.addEventListener('input', (e) => {
      this.probeDepth = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-depth')!.textContent = `${this.probeDepth} mm`;
      this.updateKinematicsAndMath();
    });

    const inputProbePitch = document.getElementById('input-probe-pitch') as HTMLInputElement;
    inputProbePitch?.addEventListener('input', (e) => {
      this.probePitch = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-pitch')!.textContent = `${this.probePitch.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    const inputProbeYaw = document.getElementById('input-probe-yaw') as HTMLInputElement;
    inputProbeYaw?.addEventListener('input', (e) => {
      this.probeYaw = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-yaw')!.textContent = `${this.probeYaw.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    const inputProbeRoll = document.getElementById('input-probe-roll') as HTMLInputElement;
    inputProbeRoll?.addEventListener('input', (e) => {
      this.probeRoll = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-roll')!.textContent = `${this.probeRoll.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    // Needle Mode buttons
    const btnModeTrocar = document.getElementById('needle-mode-trocar');
    const btnModePerc = document.getElementById('needle-mode-percutaneous');

    btnModeTrocar?.addEventListener('click', () => {
      this.needleMode = 'trocar';
      btnModeTrocar.className = 'px-2 py-0.5 rounded bg-cyan-700 text-white font-bold';
      if (btnModePerc) btnModePerc.className = 'px-2 py-0.5 rounded text-slate-400 hover:text-white';
      this.updateKinematicsAndMath();
    });

    btnModePerc?.addEventListener('click', () => {
      this.needleMode = 'percutaneous';
      btnModePerc.className = 'px-2 py-0.5 rounded bg-cyan-700 text-white font-bold';
      if (btnModeTrocar) btnModeTrocar.className = 'px-2 py-0.5 rounded text-slate-400 hover:text-white';
      this.updateKinematicsAndMath();
    });

    // Needle Kinematics Sliders
    const inputNeedlePitch = document.getElementById('input-needle-pitch') as HTMLInputElement;
    inputNeedlePitch?.addEventListener('input', (e) => {
      this.needlePitch = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-needle-pitch')!.textContent = `${this.needlePitch.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    const inputNeedleYaw = document.getElementById('input-needle-yaw') as HTMLInputElement;
    inputNeedleYaw?.addEventListener('input', (e) => {
      this.needleYaw = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-needle-yaw')!.textContent = `${this.needleYaw.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    const inputNeedleDepth = document.getElementById('input-needle-depth') as HTMLInputElement;
    inputNeedleDepth?.addEventListener('input', (e) => {
      this.needleDepth = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-needle-depth')!.textContent = `${this.needleDepth.toFixed(1)} mm`;
      this.updateKinematicsAndMath();
    });

    // Auto-Align Buttons
    document.getElementById('btn-auto-align')?.addEventListener('click', () => this.autoAlignToUSPlane());
    document.getElementById('btn-quick-auto-align')?.addEventListener('click', () => this.autoAlignToUSPlane());

    // Thermal Ablation Toggle & Slider
    const toggleAblation = document.getElementById('toggle-ablation-sim') as HTMLInputElement;
    toggleAblation?.addEventListener('change', (e) => {
      this.isAblationSimActive = (e.target as HTMLInputElement).checked;
      this.updateKinematicsAndMath();
    });

    const inputAblationDia = document.getElementById('input-ablation-dia') as HTMLInputElement;
    inputAblationDia?.addEventListener('input', (e) => {
      this.ablationDiameter = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-ablation-dia')!.textContent = `${this.ablationDiameter.toFixed(1)} mm`;
      this.updateKinematicsAndMath();
    });

    // Drawer toggle
    document.getElementById('btn-toggle-drawer')?.addEventListener('click', () => {
      const drawer = document.getElementById('control-drawer');
      if (drawer) {
        drawer.classList.toggle('hidden');
        this.viewports.handleResize();
      }
    });
  }

  /**
   * Main Animation & Render loop
   */
  private animate = () => {
    requestAnimationFrame(this.animate);

    // Render 3D Three.js viewports (Main + Laparoscope)
    this.viewports.render(this.scene);

    // Render 2D B-Mode Ultrasound Simulation
    if (this.latestAlignment) {
      const planeData = this.instruments.getProbeUSPlaneData();
      const needleSegment = this.instruments.getNeedleSegment();

      this.ultrasoundSim.render(
        this.latestAlignment,
        this.activePreset.tumorPosition,
        this.tumorDiameter,
        this.safetyMargin,
        planeData,
        needleSegment.entry,
        needleSegment.tip
      );
    }
  };
}

// Instantiate application on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  new SurgicalPlannerApp();
});
