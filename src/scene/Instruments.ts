import * as THREE from 'three';
import { TROCAR_PRESETS, TrocarDefinition } from '../config/presets';
import { FulcrumKinematics, FulcrumState } from '../math/kinematics';
import { AlignmentStatus } from '../math/alignmentEngine';
import { AblationEllipsoid } from '../math/coverage';
import { ULTRASOUND_SECTOR } from '../math/ultrasoundGeometry';

export interface ProbeUSPlaneData {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  nearRadiusMm: number;
  farRadiusMm: number;
  sectorAngleDeg: number;
  sliceThicknessMm: number;
}

export interface InstrumentSystem {
  group: THREE.Group;
  trocars: Map<string, THREE.Group>;
  probeGroup: THREE.Group;
  needleGroup: THREE.Group;
  usSliceMesh: THREE.Mesh;
  usGuideLine: THREE.Line;
  ablationSphere: THREE.Mesh;
  getAblationEllipsoid(): AblationEllipsoid;
  getProbeUSPlaneData(): ProbeUSPlaneData;
  getNeedleSegment(): { entry: THREE.Vector3; tip: THREE.Vector3 };
  updateProbe(trocarId: string, depth: number, tipPitch: number, tipYaw: number, roll: number): void;
  updateNeedle(
    mode: 'trocar' | 'percutaneous',
    trocarId: string,
    percutaneousPivot: THREE.Vector3,
    depth: number,
    pitch: number,
    yaw: number,
    roll?: number
  ): void;
  setNeedleAlignmentVisuals(status: AlignmentStatus): void;
  setAblationPreview(visible: boolean, diameterMm: number): void;
  setTrocarActive(trocarId: string, active: boolean): void;
}

export class InstrumentBuilder {
  public static build(): InstrumentSystem {
    const group = new THREE.Group();
    group.name = 'InstrumentsRoot';

    // 1. Build Trocar Sleeves
    const trocars = new Map<string, THREE.Group>();
    for (const key of Object.keys(TROCAR_PRESETS)) {
      const def = TROCAR_PRESETS[key];
      const trocarGroup = InstrumentBuilder.createTrocarMesh(def);
      group.add(trocarGroup);
      trocars.set(def.id, trocarGroup);
    }

    // 2. Build LUS Probe
    const { probeGroup, usSliceMesh, usGuideLine, getProbePlaneData, updateProbeKinematics } =
      InstrumentBuilder.createLUSProbe();
    group.add(probeGroup);

    // 3. Build Ablation Needle & Thermal Zone
    const { needleGroup, ablationSphere, getNeedlePts, getAblationEllipsoid, updateNeedleKinematics, setAlignmentColor } =
      InstrumentBuilder.createAblationNeedle();
    group.add(needleGroup);

    return {
      group,
      trocars,
      probeGroup,
      needleGroup,
      usSliceMesh,
      usGuideLine,
      ablationSphere,
      getAblationEllipsoid,
      getProbeUSPlaneData: getProbePlaneData,
      getNeedleSegment: getNeedlePts,
      updateProbe: updateProbeKinematics,
      updateNeedle: updateNeedleKinematics,
      setNeedleAlignmentVisuals: setAlignmentColor,
      setAblationPreview: (visible: boolean, dia: number) => {
        ablationSphere.visible = visible;
        ablationSphere.scale.setScalar(dia / 35.0);
      },
      setTrocarActive: (trocarId: string, active: boolean) => {
        const tr = trocars.get(trocarId);
        if (tr) {
          tr.visible = active;
        }
      }
    };
  }

  /**
   * Create Trocar Port Assembly
   */
  private static createTrocarMesh(def: TrocarDefinition): THREE.Group {
    const trGroup = new THREE.Group();
    trGroup.name = `Trocar_${def.id}`;
    trGroup.position.copy(def.pivotPosition);

    // Cannula sleeve
    const sleeveGeom = new THREE.CylinderGeometry(def.diameter * 0.5 + 1.2, def.diameter * 0.5, 45, 16);
    sleeveGeom.translate(0, 0, 0);
    const sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x90a4ae,
      metalness: 0.85,
      roughness: 0.25
    });
    const sleeve = new THREE.Mesh(sleeveGeom, sleeveMat);
    // Align with trocar default direction
    sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), def.defaultDirection);
    trGroup.add(sleeve);

    // External valve housing & port ring
    const valveGeom = new THREE.CylinderGeometry(def.diameter * 0.5 + 3.5, def.diameter * 0.5 + 3.0, 12, 16);
    const valveMat = new THREE.MeshStandardMaterial({
      color: def.color,
      metalness: 0.5,
      roughness: 0.3
    });
    const valve = new THREE.Mesh(valveGeom, valveMat);
    valve.position.addScaledVector(def.defaultDirection, -18);
    valve.quaternion.copy(sleeve.quaternion);
    trGroup.add(valve);

    // Pivot ring (visual indicator on abdominal wall)
    const ringGeom = new THREE.TorusGeometry(def.diameter * 0.5 + 2.5, 1.2, 12, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: def.color });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.quaternion.copy(sleeve.quaternion);
    ring.rotateX(Math.PI * 0.5);
    trGroup.add(ring);

    trGroup.visible = def.isActive;
    return trGroup;
  }

  /**
   * Create Laparoscopic Ultrasound (LUS) Probe with Articulating Tip & 1.5mm Sector Slice
   */
  private static createLUSProbe() {
    const probeGroup = new THREE.Group();
    probeGroup.name = 'LUS_Probe';

    // Rigid probe shaft (10mm dia, 320mm length)
    const shaftGeom = new THREE.CylinderGeometry(5.0, 5.0, 300, 24);
    shaftGeom.translate(0, 150, 0); // Origin at shaft base
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x37474f,
      metalness: 0.9,
      roughness: 0.2
    });
    const shaftMesh = new THREE.Mesh(shaftGeom, shaftMat);
    probeGroup.add(shaftMesh);

    // Articulating Head Joint Group
    const headGroup = new THREE.Group();
    headGroup.name = 'LUS_ArticulatingHead';
    probeGroup.add(headGroup);

    // Flexible knuckle joint segments (bellows / articulation links)
    const jointGeom = new THREE.CylinderGeometry(4.8, 4.8, 18, 16);
    jointGeom.translate(0, 9, 0);
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x263238,
      metalness: 0.6,
      roughness: 0.4
    });
    const jointMesh = new THREE.Mesh(jointGeom, jointMat);
    headGroup.add(jointMesh);

    // Acoustic Transducer Tip (Convex array probe)
    const tipGeom = new THREE.BoxGeometry(10, 16, 8);
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0x00d2ff,
      metalness: 0.3,
      roughness: 0.3
    });
    const tipMesh = new THREE.Mesh(tipGeom, tipMat);
    tipMesh.position.set(0, 24, 0);
    headGroup.add(tipMesh);

    // 1.5mm Physical Thickness Ultrasound Scan Plane Mesh (Extruded Sector)
    // Curvilinear / Convex scan sector: 75° angle, 100mm depth, 1.5mm thickness
    const sectorShape = new THREE.Shape();
    const sectorAngle = THREE.MathUtils.degToRad(ULTRASOUND_SECTOR.sectorAngleDeg);
    const halfAngle = sectorAngle * 0.5;
    const scanDepth = ULTRASOUND_SECTOR.farRadiusMm;
    const nearRadius = ULTRASOUND_SECTOR.nearRadiusMm;

    sectorShape.absarc(0, 0, nearRadius, Math.PI * 0.5 - halfAngle, Math.PI * 0.5 + halfAngle, false);
    sectorShape.absarc(0, 0, scanDepth, Math.PI * 0.5 + halfAngle, Math.PI * 0.5 - halfAngle, true);
    sectorShape.closePath();

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: ULTRASOUND_SECTOR.sliceThicknessMm,
      bevelEnabled: false
    };

    const sliceGeom = new THREE.ExtrudeGeometry(sectorShape, extrudeSettings);
    sliceGeom.computeBoundingBox();
    const thicknessCenter = (
      sliceGeom.boundingBox!.min.z + sliceGeom.boundingBox!.max.z
    ) * 0.5;
    sliceGeom.translate(0, 0, -thicknessCenter);
    // Keep the scan plane at the transducer face; only the sector depth extends forward.
    sliceGeom.rotateX(Math.PI * 0.5);
    sliceGeom.translate(0, 24, 0);

    const sliceMat = new THREE.MeshPhysicalMaterial({
      color: 0x00ff88,
      emissive: 0x004422,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.32,
      roughness: 0.2,
      transmission: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const usSliceMesh = new THREE.Mesh(sliceGeom, sliceMat);
    usSliceMesh.name = 'UltrasoundScanPlane';
    headGroup.add(usSliceMesh);

    // Scan plane contour & depth tick lines
    const wireGeom = new THREE.WireframeGeometry(sliceGeom);
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x00ffaa,
      transparent: true,
      opacity: 0.4
    });
    const sliceWire = new THREE.LineSegments(wireGeom, wireMat);
    headGroup.add(sliceWire);

    // Virtual Needle Guide Line (projected dashed trajectory along scan sector)
    const guidePts = [
      new THREE.Vector3(0, 24, nearRadius),
      new THREE.Vector3(0, 24, scanDepth)
    ];
    const guideGeom = new THREE.BufferGeometry().setFromPoints(guidePts);
    const guideMat = new THREE.LineDashedMaterial({
      color: 0x00ff66,
      dashSize: 5,
      gapSize: 3,
      linewidth: 2
    });
    const usGuideLine = new THREE.Line(guideGeom, guideMat);
    usGuideLine.computeLineDistances();
    headGroup.add(usGuideLine);

    // Plane tracking data
    const getProbePlaneData = () => {
      // Transducer face position in world coords
      const origin = new THREE.Vector3();
      tipMesh.getWorldPosition(origin);

      // Normal is perpendicular to slice face (Z axis in local head space)
      const worldDirection = (localDirection: THREE.Vector3) => {
        const start = usSliceMesh.localToWorld(new THREE.Vector3(0, 0, 0));
        const end = usSliceMesh.localToWorld(localDirection.clone());
        return end.sub(start).normalize();
      };

      // ExtrudeGeometry is rotated into the mesh's local X/Z plane; its normal
      // is -Y and its scan-depth axis is +Z after the geometry transform.
      const normal = worldDirection(new THREE.Vector3(0, -1, 0));
      const xAxis = worldDirection(new THREE.Vector3(1, 0, 0));
      const yAxis = worldDirection(new THREE.Vector3(0, 0, 1));

      return {
        origin,
        normal,
        xAxis,
        yAxis,
        nearRadiusMm: ULTRASOUND_SECTOR.nearRadiusMm,
        farRadiusMm: ULTRASOUND_SECTOR.farRadiusMm,
        sectorAngleDeg: ULTRASOUND_SECTOR.sectorAngleDeg,
        sliceThicknessMm: ULTRASOUND_SECTOR.sliceThicknessMm
      };
    };

    const updateProbeKinematics = (
      trocarId: string,
      depth: number,
      tipPitch: number,
      tipYaw: number,
      roll: number
    ) => {
      const def = TROCAR_PRESETS[trocarId] || TROCAR_PRESETS['subcostal'];
      const fulcrum = FulcrumKinematics.computeForward(
        def.pivotPosition,
        def.defaultDirection,
        0, // Base shaft aligned with trocar
        0,
        roll,
        depth,
        320
      );

      probeGroup.position.copy(fulcrum.pivot);
      probeGroup.quaternion.copy(fulcrum.quaternion);
      shaftMesh.scale.y = depth / 300;

      // Move articulating head to distal end of insertion
      headGroup.position.set(0, depth, 0);

      // Articulation at tip (Pitch & Yaw of transducer head)
      const qPitch = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        THREE.MathUtils.degToRad(tipPitch)
      );
      const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        THREE.MathUtils.degToRad(tipYaw)
      );
      headGroup.quaternion.copy(qPitch).multiply(qYaw);
    };

    return { probeGroup, usSliceMesh, usGuideLine, getProbePlaneData, updateProbeKinematics };
  }

  /**
   * Create Ablation Needle with In-Plane Neon Feedback & Thermal Ablation Necrosis Zone
   */
  private static createAblationNeedle() {
    const needleGroup = new THREE.Group();
    needleGroup.name = 'AblationNeedle';

    // Rigid Needle Shaft (17G / 1.47mm diameter, 250mm length)
    const shaftGeom = new THREE.CylinderGeometry(0.8, 0.8, 250, 16);
    shaftGeom.translate(0, 125, 0); // Base at pivot
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30, // Default out-of-plane red
      metalness: 0.9,
      roughness: 0.15
    });
    const shaftMesh = new THREE.Mesh(shaftGeom, shaftMat);
    needleGroup.add(shaftMesh);

    // Echogenic bevel tip (sharpened cone)
    const tipGeom = new THREE.ConeGeometry(0.9, 4, 16);
    tipGeom.translate(0, 2, 0);
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.95,
      roughness: 0.1
    });
    const tipMesh = new THREE.Mesh(tipGeom, tipMat);
    needleGroup.add(tipMesh);

    // Centimeter graduation depth markings along shaft
    const markingsGroup = new THREE.Group();
    for (let d = 20; d <= 200; d += 10) {
      const ringGeom = new THREE.TorusGeometry(0.85, 0.08, 8, 16);
      ringGeom.rotateX(Math.PI * 0.5);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.position.y = d;
      markingsGroup.add(ring);
    }
    needleGroup.add(markingsGroup);

    // Thermal Ablation Zone (RFA/MWA Necrosis Ellipsoid / Sphere)
    const ablationGeom = new THREE.SphereGeometry(17.5, 32, 24); // 35mm diameter default
    ablationGeom.scale(1.0, 1.15, 1.0); // Slightly prolate along needle axis
    const ablationMat = new THREE.MeshPhysicalMaterial({
      color: 0xff1744,
      emissive: 0x990022,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.38,
      roughness: 0.3,
      transmission: 0.3,
      depthWrite: false
    });
    const ablationSphere = new THREE.Mesh(ablationGeom, ablationMat);
    ablationSphere.visible = false; // Enabled via toggle
    needleGroup.add(ablationSphere);

    // Internal state tracking
    const currentEntry = new THREE.Vector3();
    const currentTip = new THREE.Vector3();

    const getNeedlePts = () => ({
      entry: currentEntry.clone(),
      tip: currentTip.clone()
    });

    const getAblationEllipsoid = (): AblationEllipsoid => {
      needleGroup.updateWorldMatrix(true, true);
      const center = ablationSphere.getWorldPosition(new THREE.Vector3());
      const orientation = ablationSphere.getWorldQuaternion(new THREE.Quaternion());
      const scale = ablationSphere.scale.x;
      return {
        center,
        axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(orientation).normalize(),
        axisY: new THREE.Vector3(0, 1, 0).applyQuaternion(orientation).normalize(),
        axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(orientation).normalize(),
        radiusX: 17.5 * scale,
        radiusY: 17.5 * 1.15 * scale,
        radiusZ: 17.5 * scale
      };
    };

    const updateNeedleKinematics = (
      mode: 'trocar' | 'percutaneous',
      trocarId: string,
      percutaneousPivot: THREE.Vector3,
      depth: number,
      pitch: number,
      yaw: number,
      roll: number = 0
    ) => {
      let pivot: THREE.Vector3;
      let normal: THREE.Vector3;

      if (mode === 'trocar') {
        const def = TROCAR_PRESETS[trocarId] || TROCAR_PRESETS['subcostal'];
        pivot = def.pivotPosition;
        normal = def.defaultDirection;
      } else {
        pivot = percutaneousPivot;
        normal = new THREE.Vector3(0, 0, -1);
      }

      const fulcrum = FulcrumKinematics.computeForward(
        pivot,
        normal,
        pitch,
        yaw,
        roll,
        depth,
        250
      );

      needleGroup.position.copy(fulcrum.pivot);
      needleGroup.quaternion.copy(fulcrum.quaternion);
      shaftMesh.scale.y = depth / 250;
      for (const marking of markingsGroup.children) {
        marking.visible = marking.position.y <= depth;
      }

      // The cone's apex is 4 mm past its local origin, so place that apex at
      // the kinematic tip. The ellipsoid center shares the same needle axis.
      tipMesh.position.set(0, depth - 4, 0);
      ablationSphere.position.set(0, depth - 4, 0);

      currentEntry.copy(fulcrum.pivot);
      currentTip.copy(fulcrum.tip);
    };

    const setAlignmentColor = (status: AlignmentStatus) => {
      let hexColor = 0xff3b30; // Red
      let emissive = 0x550010;
      if (status === 'IN_PLANE') {
        hexColor = 0x00ff66; // Neon Green
        emissive = 0x006622;
      } else if (status === 'CROSS_PLANE') {
        hexColor = 0xffb800; // Yellow
        emissive = 0x664400;
      }

      shaftMat.color.setHex(hexColor);
      shaftMat.emissive.setHex(emissive);
      shaftMat.emissiveIntensity = status === 'IN_PLANE' ? 0.7 : 0.2;
    };

    return { needleGroup, ablationSphere, getNeedlePts, getAblationEllipsoid, updateNeedleKinematics, setAlignmentColor };
  }
}
