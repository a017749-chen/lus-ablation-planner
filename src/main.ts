import * as THREE from 'three';
import './style.css';
import {
  getSuggestedPortSelection,
  isProbePort,
  LESION_PRESETS,
  LesionPreset,
  PortSelectionState,
  selectNeedleEntry,
  selectProbePort,
  TROCAR_PRESETS
} from './config/presets';
import { AnatomyBuilder, AnatomyMeshes } from './scene/AnatomyBuilder';
import { InstrumentBuilder, InstrumentSystem } from './scene/Instruments';
import { MultiViewport, ViewportManager } from './views/MultiViewport';
import { UltrasoundSim } from './views/UltrasoundSim';
import { AlignmentEngine, AlignmentResult } from './math/alignmentEngine';
import { FulcrumKinematics } from './math/kinematics';
import { getAnteriorSkinSurfaceNormal, getAnteriorSkinSurfacePoint } from './math/skinSurface';
import { CollisionDetector, CollisionCheckResult } from './math/collision';
import { WedgeOptimizer } from './math/wedgeOptimizer';
import { estimateEllipsoidTargetOverlap } from './math/coverage';
import { isPointInUltrasoundSector } from './math/ultrasoundGeometry';
import { LUS_PROBE } from './config/probe';
import { forwardProbe, guideLine, guideVisibleDepth, inverseProbe, ProbeControls } from './math/sideViewProbe';
import {
  buildSkinMap,
  evaluateFreehandEntry,
  evaluateProbePort,
  REASON_TEXT,
  poseProbeForNeedle,
  solveGuidedNeedle
} from './math/portPlanner';
import { raySkinIntersection } from './math/anatomyShapes';

class SurgicalPlannerApp {
  private scene: THREE.Scene;
  private viewports!: ViewportManager;
  private anatomy!: AnatomyMeshes;
  private instruments!: InstrumentSystem;
  private ultrasoundSim!: UltrasoundSim;

  // Active surgical state
  private activePreset: LesionPreset = LESION_PRESETS['S5_S6'];
  private portSelection: PortSelectionState = getSuggestedPortSelection(LESION_PRESETS['S5_S6']);
  private percutaneousPivot: THREE.Vector3 =
    getAnteriorSkinSurfacePoint(-65, 0) ?? new THREE.Vector3(-65, 0, 70);
  private percutaneousNormal: THREE.Vector3 = new THREE.Vector3(0, 0, -1);
  private isWedgeGuideVisible: boolean = true;

  private get activeTrocarId() {
    return this.portSelection.probePort;
  }

  private get needleTrocarId() {
    return this.portSelection.needlePort === 'percutaneous'
      ? this.portSelection.probePort
      : this.portSelection.needlePort;
  }

  private get needleMode() {
    return this.portSelection.needleMode;
  }

  // Probe Kinematics
  private probeDepth: number = 120;
  private probePitch: number = 28;
  private probeYaw: number = 12;
  private probeRoll: number = 0;
  private probeFlexUD: number = 30;
  private probeFlexLR: number = 0;

  // Skin port planning
  private customProbePort: { pivot: THREE.Vector3; direction: THREE.Vector3 } | null = null;
  private plannerClickMode: 'off' | 'probe' | 'needle' = 'off';
  private plannerNeedleMode: 'guided' | 'freehand' = 'guided';
  private skinMapVisible = false;
  private skinMapGroup = new THREE.Group();

  // Needle Kinematics
  private needleDepth: number = 85;
  private needlePitch: number = 42;
  private needleYaw: number = -15;

  // Dynamic Needle Insertion Simulation
  private isInsertingAnimation: boolean = false;
  private lastAnimTimestamp: number = 0;

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
    this.portSelection = getSuggestedPortSelection(preset);
    this.syncTrocarSelectionUI();

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

    if (preset.needleInitialConfig.percutaneousEntry) {
      const entry = preset.needleInitialConfig.percutaneousEntry;
      this.percutaneousPivot.copy(getAnteriorSkinSurfacePoint(entry.x, entry.y) ?? entry);
    } else {
      this.percutaneousPivot.copy(
        getAnteriorSkinSurfacePoint(-65, 0) ?? new THREE.Vector3(-65, 0, 70)
      );
    }
    this.percutaneousNormal.set(0, 0, -1);

    this.customProbePort = null;
    this.poseProbeByPlanner(true);

    // Sync input sliders
    this.syncSlidersToState();
    this.updateKinematicsAndMath();
    this.refreshSkinMap();
  }


  private syncTrocarSelectionUI() {
    const ittInUse =
      this.activeTrocarId === 'itt' ||
      (this.needleMode === 'trocar' && this.needleTrocarId === 'itt') ||
      this.activePreset.requiresITT;
    TROCAR_PRESETS['itt'].isActive = ittInUse;
    this.instruments.setTrocarActive('itt', ittInUse);

    const probePortSelect = document.getElementById('probe-port-select') as HTMLSelectElement | null;
    const needleEntrySelect = document.getElementById('needle-entry-select') as HTMLSelectElement | null;
    if (probePortSelect) probePortSelect.value = this.customProbePort ? 'custom' : this.portSelection.probePort;
    if (needleEntrySelect) needleEntrySelect.value = this.portSelection.needlePort;

    const portSummary = document.getElementById('port-selection-summary');
    if (portSummary) {
      const probeName = TROCAR_PRESETS[this.activeTrocarId]?.name ?? this.activeTrocarId;
      const needleName = this.needleMode === 'percutaneous'
        ? '經皮固定示意入口'
        : TROCAR_PRESETS[this.needleTrocarId]?.name ?? this.needleTrocarId;
      portSummary.textContent = `超音波探頭：${probeName}｜穿刺入口：${needleName}`;
    }

    const ittPill = document.getElementById('itt-status-pill');
    if (ittPill) {
      ittPill.textContent = ittInUse ? '已啟用' : '待命';
      ittPill.className = ittInUse
        ? 'text-[8px] px-1 bg-amber-500 text-black font-bold rounded animate-pulse'
        : 'text-[8px] px-1 bg-amber-950 text-amber-300 rounded';
    }
  }

  private syncSlidersToState() {
    (document.getElementById('input-tumor-dia') as HTMLInputElement).value = String(this.tumorDiameter);
    document.getElementById('val-tumor-dia')!.textContent = `${this.tumorDiameter.toFixed(1)} mm`;

    (document.getElementById('input-margin-dist') as HTMLInputElement).value = String(this.safetyMargin);
    document.getElementById('val-margin-dist')!.textContent = `+${this.safetyMargin.toFixed(1)} mm`;

    (document.getElementById('input-probe-depth') as HTMLInputElement).value = String(this.probeDepth);
    document.getElementById('val-probe-depth')!.textContent = `${this.probeDepth.toFixed(0)} mm`;

    (document.getElementById('input-probe-pitch') as HTMLInputElement).value = String(this.probePitch);
    document.getElementById('val-probe-pitch')!.textContent = `${this.probePitch.toFixed(1)}°`;

    (document.getElementById('input-probe-yaw') as HTMLInputElement).value = String(this.probeYaw);
    document.getElementById('val-probe-yaw')!.textContent = `${this.probeYaw.toFixed(1)}°`;

    (document.getElementById('input-probe-roll') as HTMLInputElement).value = String(this.probeRoll);
    document.getElementById('val-probe-roll')!.textContent = `${this.probeRoll.toFixed(1)}°`;

    (document.getElementById('input-probe-flexud') as HTMLInputElement).value = String(this.probeFlexUD);
    document.getElementById('val-probe-flexud')!.textContent = `${this.probeFlexUD.toFixed(1)}°`;

    (document.getElementById('input-probe-flexlr') as HTMLInputElement).value = String(this.probeFlexLR);
    document.getElementById('val-probe-flexlr')!.textContent = `${this.probeFlexLR.toFixed(1)}°`;

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

    // In percutaneous mode: if current pivot is off-plane, automatically calculate Wedge Entry Point C on the US plane
    if (this.needleMode === 'percutaneous') {
      const planeDistance = Math.abs(new THREE.Vector3().subVectors(this.percutaneousPivot, probePlane.origin).dot(probePlane.normal));
      if (planeDistance > WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM) {
        const wedge = WedgeOptimizer.computeWedgeGeometry(
          probePlane.origin,
          probePlane.yAxis,
          probePlane.normal,
          this.activePreset.tumorPosition
        );
        this.percutaneousPivot.copy(wedge.optimalEntryPoint);
        this.percutaneousNormal.copy(wedge.trajectoryDir);
      }
    }

    const pivot = this.needleMode === 'trocar' ? trocarDef.pivotPosition : this.percutaneousPivot;
    const normal = this.needleMode === 'trocar' ? trocarDef.defaultDirection : this.percutaneousNormal;
    const tumorRadiusMm = this.tumorDiameter * 0.5;

    const solution = WedgeOptimizer.autoAlignNeedle(
      pivot,
      normal,
      probePlane.origin,
      probePlane.normal,
      probePlane.xAxis,
      probePlane.yAxis,
      this.activePreset.tumorPosition,
      tumorRadiusMm,
      this.needleMode === 'percutaneous',
      probePlane
    );

    const status = document.getElementById('auto-align-status');
    if (
      !solution.feasible ||
      solution.pitch === undefined ||
      solution.yaw === undefined ||
      solution.depth === undefined
    ) {
      if (status) {
        const isTrocar = this.needleMode === 'trocar';
        status.innerHTML =
          `無可行解：${solution.reason ?? '幾何條件不成立'}（距離殘差 ${solution.residualDistanceMm.toFixed(1)} mm；角度殘差 ${solution.residualAngleDeg.toFixed(1)}°）。` +
          (isTrocar
            ? `<div class="mt-1.5"><button id="btn-quick-switch-wedge" type="button" class="w-full py-1 px-2 rounded bg-cyan-900/80 border border-cyan-500 hover:bg-cyan-800 text-cyan-200 text-[10px] font-bold transition-colors">切換經皮最佳進針點 C 並回正</button></div>`
            : '');
        status.className = 'text-[9px] text-amber-300 text-center mt-1';
        status.dataset.autoAlignResult = 'failed';
        document.getElementById('btn-quick-switch-wedge')?.addEventListener('click', () => {
          this.optimizeWedgeEntryPointC();
        });
      }
      return;
    }

    this.needlePitch = solution.pitch;
    this.needleYaw = solution.yaw;
    this.needleDepth = solution.depth;

    this.syncSlidersToState();
    this.updateKinematicsAndMath();

    const needleSegment = this.instruments.getNeedleSegment();
    const tipOffset = new THREE.Vector3().subVectors(needleSegment.tip, probePlane.origin);
    const tipInFan = isPointInUltrasoundSector(
      tipOffset.dot(probePlane.xAxis),
      tipOffset.dot(probePlane.yAxis),
      probePlane
    );
    const targetErrorMm = needleSegment.tip.distanceTo(this.activePreset.tumorPosition);
    const appliedSolutionValid =
      this.latestAlignment.status === 'IN_PLANE' &&
      this.latestAlignment.maxDistance <= WedgeOptimizer.PLANE_DISTANCE_TOLERANCE_MM &&
      targetErrorMm <= tumorRadiusMm + 1e-6 &&
      tipInFan;

    if (status) {
      if (!appliedSolutionValid) {
        status.textContent =
          `未通過套用後檢查：針尖距病灶 ${targetErrorMm.toFixed(1)} mm；請調整入口或掃描面後重試。`;
        status.className = 'text-[9px] text-amber-300 text-center mt-1';
        status.dataset.autoAlignResult = 'failed';
        return;
      }

      status.textContent =
        `幾何示意回正已套用：針尖位於病灶內、切面偏差 ${this.latestAlignment.maxDistance.toFixed(1)} mm，角差 ${this.latestAlignment.angleToPlaneDeg.toFixed(1)}°。`;
      status.className = 'text-[9px] text-emerald-300 text-center mt-1';
      status.dataset.autoAlignResult = 'success';
    }

    const btn = document.getElementById('btn-auto-align');
    if (btn) {
      btn.classList.add('scale-105', 'ring-4', 'ring-emerald-400');
      setTimeout(() => {
        btn.classList.remove('scale-105', 'ring-4', 'ring-emerald-400');
      }, 400);
    }
  }

  /**
   * Plan Right-Angle Wedge Entry Point C & Auto-Align (楔形幾何最佳化穿刺規劃)
   */
  public optimizeWedgeEntryPointC() {
    const probePlane = this.instruments.getProbeUSPlaneData();
    const wedge = WedgeOptimizer.computeWedgeGeometry(
      probePlane.origin,
      probePlane.yAxis,
      probePlane.normal,
      this.activePreset.tumorPosition
    );

    // Run the in-plane trajectory back from the target to the skin: point C is a skin
    // puncture, not a point floating in the scan plane.
    const onSkin = raySkinIntersection(wedge.targetPoint, wedge.trajectoryDir.clone().negate());
    if (!onSkin) {
      this.plannerReport('楔形軌跡往回延伸碰不到前腹壁，無法在皮膚上定出 C 點。');
      return;
    }
    wedge.optimalEntryPoint.copy(onSkin);
    this.percutaneousPivot.copy(onSkin);
    this.percutaneousNormal.copy(wedge.trajectoryDir);

    if (this.needleMode !== 'percutaneous') {
      this.portSelection = selectNeedleEntry(this.portSelection, 'percutaneous');
      this.syncTrocarSelectionUI();
    }

    this.autoAlignToUSPlane();

    const status = document.getElementById('auto-align-status');
    if (status && status.dataset.autoAlignResult === 'success') {
      status.textContent =
        `楔形最佳進針點 C 已定位 (X:${wedge.optimalEntryPoint.x.toFixed(0)}, Y:${wedge.optimalEntryPoint.y.toFixed(0)}, Z:${wedge.optimalEntryPoint.z.toFixed(0)})，針尖已成功共面回正！`;
    }
  }

  /**
   * Return the first insertion depth where the current needle trajectory enters the target sphere.
   * A null result means the current trajectory misses the tumor.
   */
  public getTargetNeedleDepth(): number | null {
    const trocar = TROCAR_PRESETS[this.needleTrocarId];
    const pivot = this.needleMode === 'trocar'
      ? (trocar?.pivotPosition || new THREE.Vector3(0, -90, 85))
      : this.percutaneousPivot;
    const baseNormal = this.needleMode === 'trocar'
      ? (trocar?.defaultDirection || new THREE.Vector3(0, 0, -1))
      : this.percutaneousNormal;
    const direction = FulcrumKinematics.computeForward(
      pivot,
      baseNormal,
      this.needlePitch,
      this.needleYaw,
      0,
      0
    ).direction;

    return FulcrumKinematics.raySphereEntryDepth(
      pivot,
      direction,
      this.activePreset.tumorPosition,
      this.tumorDiameter * 0.5
    );
  }

  /**
   * Toggle dynamic needle insertion animation
   */
  public toggleInsertionAnimation() {
    if (this.isInsertingAnimation) {
      this.stopInsertionAnimation();
    } else {
      const targetDepth = this.getTargetNeedleDepth();
      if (targetDepth === null) return;
      if (this.needleDepth >= targetDepth - 0.5) {
        this.needleDepth = 0;
        this.syncSlidersToState();
        this.updateKinematicsAndMath();
      }
      this.isInsertingAnimation = true;
      this.updateInsertionPlayButtonUI();
    }
  }

  public stopInsertionAnimation() {
    this.isInsertingAnimation = false;
    this.updateInsertionPlayButtonUI();
  }

  private updateInsertionPlayButtonUI() {
    const btn = document.getElementById('btn-play-puncture');
    const text = document.getElementById('text-play-puncture');
    const icon = document.getElementById('icon-play-puncture');
    if (btn && text) {
      if (this.isInsertingAnimation) {
        btn.className = 'py-1 px-1 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold font-mono transition-all text-center flex items-center justify-center space-x-1 animate-pulse';
        text.textContent = '暫停進針';
        if (icon) {
          icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
        }
      } else {
        btn.className = 'py-1 px-1 rounded bg-emerald-600 hover:bg-emerald-500 text-black font-bold font-mono transition-all text-center flex items-center justify-center space-x-1';
        text.textContent = '動態進針';
        if (icon) {
          icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
        }
      }
    }
  }

  /**
   * Main mathematical update cycle
   */
  // ===================== Skin port planning =====================

  /** The trocar the probe pivots at: a preset port, or a point picked on the skin. */
  private probePort(): { pivot: THREE.Vector3; direction: THREE.Vector3 } {
    if (this.customProbePort) return this.customProbePort;
    const def = TROCAR_PRESETS[this.activeTrocarId] ?? TROCAR_PRESETS['subcostal'];
    return { pivot: def.pivotPosition, direction: def.defaultDirection };
  }

  private probeControls(): ProbeControls {
    return {
      shaftPitchDeg: this.probePitch,
      shaftYawDeg: this.probeYaw,
      insertionMm: this.probeDepth,
      rollDeg: this.probeRoll,
      flexUpDownDeg: this.probeFlexUD,
      flexLeftRightDeg: this.probeFlexLR
    };
  }

  /** Exact values are kept: rounding to slider steps would tilt the plane off the target. */
  private setProbeControls(c: ProbeControls) {
    this.probePitch = c.shaftPitchDeg;
    this.probeYaw = c.shaftYawDeg;
    this.probeDepth = c.insertionMm;
    this.probeRoll = c.rollDeg;
    this.probeFlexUD = c.flexUpDownDeg;
    this.probeFlexLR = c.flexLeftRightDeg;
  }

  private plannerReport(html: string) {
    const el = document.getElementById('planner-report');
    if (el) el.innerHTML = html;
  }

  private reasonList(reasons: string[], warnings: string[] = []): string {
    const r = reasons.map(k => `<li class="text-rose-300">✘ ${REASON_TEXT[k as keyof typeof REASON_TEXT] ?? k}</li>`);
    const w = warnings.map(k => `<li class="text-amber-300">⚠ ${REASON_TEXT[k as keyof typeof REASON_TEXT] ?? k}</li>`);
    return r.length || w.length ? `<ul class="mt-1 space-y-0.5">${[...r, ...w].join('')}</ul>` : '';
  }

  private fmt(v: THREE.Vector3): string {
    return `(${v.x.toFixed(0)}, ${v.y.toFixed(0)}, ${v.z.toFixed(0)})`;
  }

  /** Put the probe on a window that images the target from the current port. */
  private poseProbeByPlanner(quiet: boolean): boolean {
    const port = this.probePort();
    const result = evaluateProbePort(port.pivot, this.activePreset.tumorPosition);
    if (!result.feasible || !result.leastFlex) {
      if (!quiet) this.plannerReport(`<b class="text-rose-300">這個探頭孔無法掃到腫瘤</b>${this.reasonList(result.reasons, result.warnings)}`);
      return false;
    }
    this.setProbeControls(inverseProbe(result.leastFlex.pose, port.direction));
    if (!quiet) {
      const pose = result.leastFlex.pose;
      this.plannerReport(
        `<b class="text-emerald-300">✔ 探頭可從這裡掃到腫瘤</b>（${result.feasibleWindowCount} 個可行聲窗）<br>` +
        `目前擺放：插入 ${pose.insertionMm.toFixed(0)} mm、尖端彎 ${pose.flexDeg.toFixed(0)}°、腫瘤深 ${result.leastFlex.window.depthMm.toFixed(0)} mm<br>` +
        `<span class="text-slate-500">取彎曲最小的一組只是幾何上的選法，不是臨床建議。</span>` +
        this.reasonList([], result.warnings)
      );
    }
    return true;
  }

  /** Needle from a skin point, aimed at a point; sets the needle to percutaneous mode. */
  private setPercutaneousNeedle(skin: THREE.Vector3, aim: THREE.Vector3) {
    const inward = getAnteriorSkinSurfaceNormal(skin.x, skin.y)?.negate() ?? new THREE.Vector3(0, 0, -1);
    this.percutaneousPivot.copy(skin);
    this.percutaneousNormal.copy(inward);
    const solution = FulcrumKinematics.solveAimTarget(skin, inward, aim);
    this.needlePitch = solution.pitch;
    this.needleYaw = solution.yaw;
    this.needleDepth = solution.insertionDepth;
    if (this.needleMode !== 'percutaneous') {
      this.portSelection = selectNeedleEntry(this.portSelection, 'percutaneous');
      this.syncTrocarSelectionUI();
    }
  }

  /** Needle through the probe's guide hole: pose the probe, then the skin entry follows. */
  private applyGuidedPlan() {
    const port = this.probePort();
    const target = this.activePreset.tumorPosition;
    const result = solveGuidedNeedle(port.pivot, target);
    const depth = guideVisibleDepth();
    if (!result.feasible || !result.leastFlex) {
      const range = depth ? `導引線在影像內只到 ${depth.min.toFixed(0)}–${depth.max.toFixed(0)} mm 深。` : '導引線不經過影像。';
      this.plannerReport(`<b class="text-rose-300">從這個探頭孔無法用導引孔打到腫瘤</b><br><span class="text-slate-400">${range}</span>${this.reasonList(result.reasons)}`);
      return;
    }
    const s = result.leastFlex;
    this.setProbeControls(inverseProbe(s.pose, port.direction));
    const guide = guideLine(s.pose);
    const along = target.clone().sub(guide.hole).dot(guide.direction);
    this.setPercutaneousNeedle(s.skinEntry, guide.hole.clone().addScaledVector(guide.direction, along));
    this.plannerReport(
      `<b class="text-emerald-300">✔ 可經導引孔進針</b>（${result.solutions.length} 組探頭擺法）<br>` +
      `皮膚穿刺點 ${this.fmt(s.skinEntry)}，針長 ${s.needle.lengthMm.toFixed(0)} mm<br>` +
      `針道距血管 ${s.needle.vesselClearanceMm.toFixed(1)} mm（${s.needle.closestVessel}）<br>` +
      `探頭：插入 ${s.pose.insertionMm.toFixed(0)} mm、尖端彎 ${s.pose.flexDeg.toFixed(0)}°；導引線離腫瘤中心 ${s.guideMissMm.toFixed(1)} mm<br>` +
      `<span class="text-slate-500">皮膚點由探頭姿態決定。取彎曲最小的一組只是幾何選法。</span>` +
      this.reasonList([], s.needle.warnings)
    );
  }

  private onSkinPicked(hit: THREE.Vector3) {
    const skin = getAnteriorSkinSurfacePoint(hit.x, hit.y);
    const normal = getAnteriorSkinSurfaceNormal(hit.x, hit.y);
    if (!skin || !normal) return;
    const target = this.activePreset.tumorPosition;

    if (this.plannerClickMode === 'probe') {
      this.customProbePort = { pivot: skin, direction: normal.clone().negate() };
      this.syncTrocarSelectionUI();
      const ok = this.poseProbeByPlanner(false);
      if (ok && this.plannerNeedleMode === 'guided') {
        const guided = solveGuidedNeedle(skin, target);
        const el = document.getElementById('planner-report');
        if (el) el.innerHTML += guided.feasible
          ? `<div class="mt-1 text-amber-200">導引孔進針：可行（${guided.solutions.length} 組）。按「套用導引孔進針」。</div>`
          : `<div class="mt-1 text-amber-200">導引孔進針：不可行${this.reasonList(guided.reasons)}</div>`;
      }
    } else if (this.plannerClickMode === 'needle') {
      const result = evaluateFreehandEntry(skin, target);
      this.setPercutaneousNeedle(skin, target);
      let probeLine = '';
      if (result.feasible) {
        const aligned = poseProbeForNeedle(this.probePort().pivot, skin, target);
        if (aligned.solution) {
          this.setProbeControls(inverseProbe(aligned.solution.pose, this.probePort().direction));
          probeLine = `<br>探頭已轉到讓影像面包含這條針道（尖端彎 ${aligned.solution.pose.flexDeg.toFixed(0)}°）。`;
        } else {
          probeLine = `<div class="text-amber-200">目前的探頭孔無法讓影像面包含這條針道${this.reasonList(aligned.reasons)}</div>`;
        }
      }
      this.plannerReport(
        (result.feasible
          ? `<b class="text-emerald-300">✔ 這個進針點可行</b><br>`
          : `<b class="text-rose-300">這個進針點不可行</b><br>`) +
        `皮膚點 ${this.fmt(skin)}，針長 ${result.lengthMm.toFixed(0)} mm，距血管 ${result.vesselClearanceMm.toFixed(1)} mm` +
        (result.needleBeamAngleDeg !== undefined ? `，針與聲束夾角 ${result.needleBeamAngleDeg.toFixed(0)}°` : '') +
        probeLine + this.reasonList(result.reasons, result.warnings)
      );
    }
    this.syncSlidersToState();
    this.updateKinematicsAndMath();
  }

  /** Coloured dots on the skin: where a probe port / a freehand needle entry can work. */
  private refreshSkinMap() {
    this.skinMapGroup.clear();
    if (!this.skinMapVisible) return;
    const cells = buildSkinMap(this.activePreset.tumorPosition, 10);
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    for (const cell of cells) {
      const n = getAnteriorSkinSurfaceNormal(cell.skin.x, cell.skin.y)!;
      const p = cell.skin.clone().addScaledVector(n, 2);
      positions.push(p.x, p.y, p.z);
      if (cell.probeOk && cell.needleOk) color.set(0x22d3ee);
      else if (cell.probeOk) color.set(0x34d399);
      else if (cell.needleOk) color.set(0x60a5fa);
      else color.set(0x475569);
      if (cell.overRibCage) color.multiplyScalar(0.6);
      colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 6, vertexColors: true, sizeAttenuation: true }));
    points.name = 'SkinFeasibilityMap';
    this.skinMapGroup.add(points);
  }

  private updateGuideDepthLabel() {
    const label = document.getElementById('planner-guide-depth');
    const depth = guideVisibleDepth();
    if (label) label.textContent = depth ? `${depth.min.toFixed(0)}–${depth.max.toFixed(0)} mm` : '導引線不經過影像';
    const badge = document.getElementById('planner-calibration-badge');
    if (badge) badge.textContent = LUS_PROBE.calibrated ? '探頭規格已校正' : '探頭規格未校正';
  }

  private bindPlannerEvents() {
    this.scene.add(this.skinMapGroup);
    this.updateGuideDepthLabel();

    document.getElementById('planner-click-mode')?.addEventListener('change', (e) => {
      this.plannerClickMode = (e.target as HTMLSelectElement).value as typeof this.plannerClickMode;
      this.plannerReport(this.plannerClickMode === 'off'
        ? '選擇「點皮膚設定」後在 3D 畫面的皮膚上點一下。'
        : `在 3D 畫面的皮膚上點一下設定${this.plannerClickMode === 'probe' ? '探頭套管位置' : '徒手進針點'}（拖曳仍可旋轉畫面）。`);
    });
    document.getElementById('planner-needle-mode')?.addEventListener('change', (e) => {
      this.plannerNeedleMode = (e.target as HTMLSelectElement).value as typeof this.plannerNeedleMode;
    });
    document.getElementById('planner-guide-angle')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0 && value < 90) LUS_PROBE.guide.angleDeg = value;
      this.updateGuideDepthLabel();
      this.updateKinematicsAndMath();
    });
    document.getElementById('planner-guide-ref')?.addEventListener('change', (e) => {
      LUS_PROBE.guide.angleReference = (e.target as HTMLSelectElement).value as typeof LUS_PROBE.guide.angleReference;
      this.updateGuideDepthLabel();
      this.updateKinematicsAndMath();
    });
    document.getElementById('toggle-skin-map')?.addEventListener('change', (e) => {
      this.skinMapVisible = (e.target as HTMLInputElement).checked;
      this.refreshSkinMap();
    });
    document.getElementById('btn-planner-pose-probe')?.addEventListener('click', () => {
      this.poseProbeByPlanner(false);
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });
    document.getElementById('btn-planner-apply-guided')?.addEventListener('click', () => {
      this.applyGuidedPlan();
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });

    // A click (not a drag) on the skin sets a port or needle entry.
    const canvas = this.viewports.mainRenderer.domElement;
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || this.plannerClickMode === 'off') return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, this.viewports.mainCamera);
      const hit = raycaster.intersectObject(this.anatomy.skinDome, false)[0];
      if (hit) this.onSkinPicked(hit.point);
    });
  }

  private updateKinematicsAndMath() {
    const autoAlignStatus = document.getElementById('auto-align-status');
    if (autoAlignStatus?.dataset.autoAlignResult) {
      autoAlignStatus.textContent = '配置已變更，請重新執行幾何示意回正。';
      autoAlignStatus.className = 'text-[9px] text-slate-400 text-center mt-1';
      delete autoAlignStatus.dataset.autoAlignResult;
    }

    // 1. Update Tumor & Safety Margin geometry
    this.anatomy.updateTumor(this.activePreset.tumorPosition, this.tumorDiameter, this.safetyMargin);

    // 1b. Update Percutaneous Entry Marker on Skin
    this.anatomy.updatePercutaneousIncision(this.percutaneousPivot);

    // 2. Update LUS Probe kinematics
    const port = this.probePort();
    const probePose = forwardProbe(port.pivot, port.direction, this.probeControls());
    this.instruments.updateProbe(probePose);
    // Where a needle through the guide hole would have to enter the skin for this pose.
    const guide = guideLine(probePose);
    this.instruments.setGuideExtension(
      raySkinIntersection(guide.hole, guide.direction.clone().negate()),
      guide.hole
    );

    // 3. Update Ablation Needle kinematics
    this.instruments.updateNeedle(
      this.needleMode,
      this.needleTrocarId,
      this.percutaneousPivot,
      this.needleDepth,
      this.needlePitch,
      this.needleYaw,
      0,
      this.percutaneousNormal
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

    // 4b. Update Right-Angle Wedge Visual Guide (Triangle ABC)
    this.instruments.updateWedgeVisual(
      this.isWedgeGuideVisible,
      planeData.origin,
      this.activePreset.tumorPosition,
      this.needleMode === 'percutaneous' ? this.percutaneousPivot : undefined
    );

    // 4c. Update Needle Target Distance Indicator
    const targetDepth = this.getTargetNeedleDepth();
    const labelDist = document.getElementById('label-puncture-target-dist');
    if (labelDist) {
      if (targetDepth === null) {
        labelDist.textContent = '目前針軌跡未穿過腫瘤';
        labelDist.className = 'text-rose-400 font-bold';
      } else {
        const distRemaining = targetDepth - this.needleDepth;
        if (Math.abs(distRemaining) <= 1.0) {
          labelDist.textContent = '0.0 mm (已進入腫瘤範圍)';
          labelDist.className = 'text-emerald-400 font-bold';
        } else if (distRemaining > 1.0) {
          labelDist.textContent = `+${distRemaining.toFixed(1)} mm (逼近靶區)`;
          labelDist.className = 'text-cyan-300 font-bold';
        } else {
          labelDist.textContent = `${distRemaining.toFixed(1)} mm (已越過靶區入口)`;
          labelDist.className = 'text-rose-400 font-bold';
        }
      }
    }

    // 5. Collision Detection with Critical Vessels
    this.latestCollision = CollisionDetector.checkCollision(
      needleSegment.entry,
      needleSegment.tip
    );
    this.anatomy.setVesselAlert(this.latestCollision.hasCollision);

    // 6. Update Thermal Ablation Zone & Coverage
    this.instruments.setAblationPreview(this.isAblationSimActive, this.ablationDiameter);
    this.updateThermalCoverage();

    // 7. Update Surgical HUD Telemetry
    this.updateHUDTelemetry(needleSegment.tip);
  }

  /**
   * Estimate the geometric overlap between the target-plus-margin sphere and
   * the same world-space ellipsoid shown in the 3D scene.
   */
  private updateThermalCoverage() {
    const targetCenter = this.activePreset.tumorPosition;
    const targetRadius = this.tumorDiameter * 0.5 + this.safetyMargin;
    const coveragePercent = this.isAblationSimActive
      ? estimateEllipsoidTargetOverlap(
          targetCenter,
          targetRadius,
          this.instruments.getAblationEllipsoid()
        )
      : 0;

    // Telemetry updates
    const coverageText = document.getElementById('hud-coverage-percent');
    const coverageRing = document.getElementById('hud-coverage-ring');
    const coverageStat = document.getElementById('ablation-coverage-stat');
    const radNecrosis = document.getElementById('ablation-rad-necrosis');

    if (radNecrosis) {
      radNecrosis.textContent = `${(this.ablationDiameter * 0.5).toFixed(1)} mm`;
    }

    if (!this.isAblationSimActive) {
      if (coverageText) coverageText.textContent = '— (SIMULATION OFF)';
      if (coverageRing) coverageRing.setAttribute('stroke-dashoffset', '62.8');
      if (coverageStat) coverageStat.textContent = '未啟用';
    } else {
      if (coverageText) {
        coverageText.textContent = `${coveragePercent}% (GEOMETRIC ESTIMATE)`;
        coverageText.className = 'font-bold text-xs text-amber-400';
      }
      if (coverageRing) {
        const offset = 62.8 * (1 - coveragePercent / 100);
        coverageRing.setAttribute('stroke-dashoffset', String(offset));
        coverageRing.setAttribute('class', 'text-amber-400 transition-all duration-300');
      }
      if (coverageStat) {
        coverageStat.textContent = `${coveragePercent}% (目標體積幾何重疊估計)`;
        coverageStat.className = 'text-amber-400 font-bold';
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
        alertElem.textContent = `針身表面間距 <5 mm：${this.latestCollision.closestVesselName.split(' ')[0]}`;
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
    document.getElementById('btn-camera-umbilical')?.addEventListener('click', () => this.viewports.setCameraPreset('surgeon'));
    document.getElementById('btn-cam-reset')?.addEventListener('click', () => this.viewports.setCameraPreset('reset'));

    // Layer toggles
    document.getElementById('layer-skin')?.addEventListener('change', (e) => {
      const isChecked = (e.target as HTMLInputElement).checked;
      this.anatomy.skinDome.visible = isChecked;
      this.anatomy.skinIncisionMarkers.visible = isChecked;
    });

    const inputSkinOpacity = document.getElementById('input-skin-opacity') as HTMLInputElement | null;
    const valSkinOpacity = document.getElementById('val-skin-opacity');
    inputSkinOpacity?.addEventListener('input', (e) => {
      const opacityVal = Number((e.target as HTMLInputElement).value);
      if (valSkinOpacity) valSkinOpacity.textContent = `${opacityVal}%`;
      this.anatomy.setSkinOpacity(opacityVal / 100);
    });
    document.getElementById('btn-skin-translucent')?.addEventListener('click', () => {
      if (inputSkinOpacity) inputSkinOpacity.value = '25';
      if (valSkinOpacity) valSkinOpacity.textContent = '25%';
      this.anatomy.setSkinOpacity(0.25);
    });
    document.getElementById('btn-skin-opaque')?.addEventListener('click', () => {
      if (inputSkinOpacity) inputSkinOpacity.value = '88';
      if (valSkinOpacity) valSkinOpacity.textContent = '88%';
      this.anatomy.setSkinOpacity(0.88);
    });

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

    const probePortSelect = document.getElementById('probe-port-select') as HTMLSelectElement | null;
    probePortSelect?.addEventListener('change', (event) => {
      const port = (event.target as HTMLSelectElement).value;
      if (port === 'custom') {
        if (!this.customProbePort) {
          this.plannerReport('先把「點皮膚設定」切到「探頭套管位置」，再點皮膚。');
          this.syncTrocarSelectionUI();
        }
        return;
      }
      if (!isProbePort(port)) return;
      this.customProbePort = null;
      this.portSelection = selectProbePort(this.portSelection, port);
      this.poseProbeByPlanner(false);
      this.syncSlidersToState();
      this.syncTrocarSelectionUI();
      this.updateKinematicsAndMath();
    });

    const needleEntrySelect = document.getElementById('needle-entry-select') as HTMLSelectElement | null;
    needleEntrySelect?.addEventListener('change', (event) => {
      const entry = (event.target as HTMLSelectElement).value as PortSelectionState['needlePort'];
      this.portSelection = selectNeedleEntry(this.portSelection, entry);
      this.syncTrocarSelectionUI();
      this.updateKinematicsAndMath();
    });

    // LUS Probe Articulation Sliders
    const inputProbeDepth = document.getElementById('input-probe-depth') as HTMLInputElement;
    inputProbeDepth?.addEventListener('input', (e) => {
      this.probeDepth = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-depth')!.textContent = `${this.probeDepth.toFixed(0)} mm`;
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

    document.getElementById('input-probe-flexud')?.addEventListener('input', (e) => {
      this.probeFlexUD = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-flexud')!.textContent = `${this.probeFlexUD.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });
    document.getElementById('input-probe-flexlr')?.addEventListener('input', (e) => {
      this.probeFlexLR = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-probe-flexlr')!.textContent = `${this.probeFlexLR.toFixed(1)}°`;
      this.updateKinematicsAndMath();
    });

    this.bindPlannerEvents();

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
      this.stopInsertionAnimation();
      this.needleDepth = Number((e.target as HTMLInputElement).value);
      document.getElementById('val-needle-depth')!.textContent = `${this.needleDepth.toFixed(1)} mm`;
      this.updateKinematicsAndMath();
    });

    // Needle Insertion Simulation Controls
    document.getElementById('btn-play-puncture')?.addEventListener('click', () => this.toggleInsertionAnimation());
    document.getElementById('btn-needle-retract-5')?.addEventListener('click', () => {
      this.stopInsertionAnimation();
      this.needleDepth = Math.max(0, this.needleDepth - 5);
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });
    document.getElementById('btn-needle-advance-5')?.addEventListener('click', () => {
      this.stopInsertionAnimation();
      this.needleDepth = Math.min(160, this.needleDepth + 5);
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });
    document.getElementById('btn-needle-reset-skin')?.addEventListener('click', () => {
      this.stopInsertionAnimation();
      this.needleDepth = 0;
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });
    document.getElementById('btn-needle-target-depth')?.addEventListener('click', () => {
      this.stopInsertionAnimation();
      const targetDepth = this.getTargetNeedleDepth();
      if (targetDepth === null) return;
      this.needleDepth = targetDepth;
      this.syncSlidersToState();
      this.updateKinematicsAndMath();
    });

    // Auto-Align & Wedge Buttons
    document.getElementById('btn-auto-align')?.addEventListener('click', () => this.autoAlignToUSPlane());
    document.getElementById('btn-quick-auto-align')?.addEventListener('click', () => this.autoAlignToUSPlane());
    document.getElementById('btn-wedge-optimize')?.addEventListener('click', () => this.optimizeWedgeEntryPointC());

    const toggleWedge = document.getElementById('toggle-wedge-guide') as HTMLInputElement | null;
    toggleWedge?.addEventListener('change', (e) => {
      this.isWedgeGuideVisible = (e.target as HTMLInputElement).checked;
      this.updateKinematicsAndMath();
    });

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
  private animate = (timestamp: number = 0) => {
    requestAnimationFrame(this.animate);

    // Dynamic Needle Insertion Animation Advance
    if (this.isInsertingAnimation) {
      if (!this.lastAnimTimestamp) this.lastAnimTimestamp = timestamp;
      const dt = Math.min(0.05, (timestamp - this.lastAnimTimestamp) / 1000);
      this.lastAnimTimestamp = timestamp;

      const speedMmPerSec = 16.0; // ~16 mm/s realistic clinical puncture velocity
      const targetDepth = this.getTargetNeedleDepth();
      if (targetDepth === null) {
        this.stopInsertionAnimation();
      } else if (this.needleDepth < targetDepth) {
        this.needleDepth = Math.min(targetDepth, this.needleDepth + speedMmPerSec * dt);
        this.syncSlidersToState();
        this.updateKinematicsAndMath();
        if (this.needleDepth >= targetDepth) {
          this.stopInsertionAnimation();
        }
      } else {
        this.stopInsertionAnimation();
      }
    } else {
      this.lastAnimTimestamp = timestamp;
    }

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
  const app = new SurgicalPlannerApp();
  // Development builds expose the app for debugging in the browser console.
  if (import.meta.env.DEV) (window as unknown as { __planner?: SurgicalPlannerApp }).__planner = app;
});
