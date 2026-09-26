import * as THREE from 'three';
import { TROCAR_PRESETS, TrocarDefinition } from '../config/presets';
import { FulcrumKinematics, FulcrumState } from '../math/kinematics';
import { AlignmentStatus } from '../math/alignmentEngine';
import { AblationEllipsoid } from '../math/coverage';
import { LinearImageBounds } from '../math/ultrasoundGeometry';
import { LUS_PROBE } from '../config/probe';
import { guideDirection2D, ProbePose } from '../math/sideViewProbe';

/** The live image plane: origin at the array centre, x along the array, y into depth. */
export interface ProbeUSPlaneData extends LinearImageBounds {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
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
  updateProbe(pose: ProbePose): void;
  getProbePose(): ProbePose | null;
  setGuideExtension(from: THREE.Vector3 | null, to: THREE.Vector3 | null): void;
  updateNeedle(
    mode: 'trocar' | 'percutaneous',
    trocarId: string,
    percutaneousPivot: THREE.Vector3,
    depth: number,
    pitch: number,
    yaw: number,
    roll?: number,
    percutaneousNormal?: THREE.Vector3
  ): void;
  setNeedleAlignmentVisuals(status: AlignmentStatus): void;
  setAblationPreview(visible: boolean, diameterMm: number): void;
  setTrocarActive(trocarId: string, active: boolean): void;
  updateWedgeVisual(
    visible: boolean,
    pointA?: THREE.Vector3,
    pointB?: THREE.Vector3,
    pointC?: THREE.Vector3
  ): void;
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
    const { probeGroup, usSliceMesh, usGuideLine, getProbePlaneData, updateProbePose, setGuideExtension, getPose } =
      InstrumentBuilder.createLUSProbe();
    group.add(probeGroup);

    // 3. Build Ablation Needle & Thermal Zone
    const { needleGroup, ablationSphere, getNeedlePts, getAblationEllipsoid, updateNeedleKinematics, setAlignmentColor } =
      InstrumentBuilder.createAblationNeedle();
    // 4. Build Right-Angle Wedge Visual Guide
    const { wedgeGroup, updateWedge } = InstrumentBuilder.createWedgeGuide();
    group.add(wedgeGroup);

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
      updateProbe: updateProbePose,
      getProbePose: getPose,
      setGuideExtension,
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
      },
      updateWedgeVisual: updateWedge
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
   * Side-viewing linear LUS probe: straight shaft from the trocar pivot to the flex
   * joint, flexible tip to the array, array on the side of the tip, rectangular image
   * in the plane that contains the array axis, and the needle-guide line.
   * Everything is placed in world coordinates from a ProbePose, so the drawn probe
   * and the planning math are the same object.
   */
  private static createLUSProbe() {
    const spec = LUS_PROBE;
    const probeGroup = new THREE.Group();
    probeGroup.name = 'LUS_Probe';

    const metal = new THREE.MeshStandardMaterial({ color: 0x37474f, metalness: 0.9, roughness: 0.2 });
    const flexMat = new THREE.MeshStandardMaterial({ color: 0x263238, metalness: 0.6, roughness: 0.4 });
    const r = spec.shaftDiameterMm / 2;

    const shaftMesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 24), metal);
    shaftMesh.name = 'LUS_Shaft';
    const flexMesh = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 0.96, 1, 16), flexMat);
    flexMesh.name = 'LUS_FlexTip';
    probeGroup.add(shaftMesh, flexMesh);

    // Array head. Local X = array axis, local Y = -plane normal, local Z = beam.
    const headGroup = new THREE.Group();
    headGroup.name = 'LUS_ArrayHead';
    probeGroup.add(headGroup);
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(spec.arrayLengthMm + 6, spec.shaftDiameterMm * 0.9, spec.shaftDiameterMm * 0.8),
      flexMat
    );
    housing.position.set(0, 0, -spec.shaftDiameterMm * 0.4);
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(spec.arrayLengthMm, spec.shaftDiameterMm * 0.7, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x00d2ff, metalness: 0.3, roughness: 0.3 })
    );
    face.name = 'LUS_ArrayFace';
    face.position.set(0, 0, -0.4);
    headGroup.add(housing, face);

    // Rectangular image slab: width = array length, depth near..far, 1.5 mm thick.
    const depthSpan = spec.image.farDepthMm - spec.image.nearDepthMm;
    const sliceGeom = new THREE.BoxGeometry(spec.arrayLengthMm, spec.image.sliceThicknessMm, depthSpan);
    sliceGeom.translate(0, 0, spec.image.nearDepthMm + depthSpan / 2);
    const usSliceMesh = new THREE.Mesh(sliceGeom, new THREE.MeshPhysicalMaterial({
      color: 0x00ff88, emissive: 0x004422, emissiveIntensity: 0.25, transparent: true,
      opacity: 0.32, roughness: 0.2, transmission: 0.4, depthWrite: false, side: THREE.DoubleSide
    }));
    usSliceMesh.name = 'UltrasoundScanPlane';
    headGroup.add(usSliceMesh);
    headGroup.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(sliceGeom),
      new THREE.LineBasicMaterial({ color: 0x00ffaa, transparent: true, opacity: 0.5 })
    ));

    // Needle guide: hole at the proximal end of the array, line across the image.
    // Rebuilt on every pose update so an edited guide spec shows at once.
    const usGuideLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffd400, dashSize: 4, gapSize: 2 })
    );
    usGuideLine.name = 'LUS_GuideLine';
    const holeMarker = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.5, 8, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd400 })
    );
    holeMarker.name = 'LUS_GuideHole';
    headGroup.add(usGuideLine, holeMarker);
    const refreshGuide = () => {
      const { du, dv } = guideDirection2D(spec);
      const hole = new THREE.Vector3(-spec.guide.holeOffsetMm, 0, -spec.guide.holeHeightMm);
      const endT = (spec.image.farDepthMm + spec.guide.holeHeightMm) / Math.max(dv, 1e-6);
      usGuideLine.geometry.setFromPoints([hole, hole.clone().add(new THREE.Vector3(du * endT, 0, dv * endT))]);
      usGuideLine.computeLineDistances();
      holeMarker.position.copy(hole);
    };
    refreshGuide();

    // Guide line run back to the skin (world space, set by the planner).
    const extensionGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const guideExtension = new THREE.Line(extensionGeom, new THREE.LineDashedMaterial({
      color: 0xffd400, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.8
    }));
    guideExtension.name = 'LUS_GuideToSkin';
    guideExtension.visible = false;
    probeGroup.add(guideExtension);

    let currentPose: ProbePose | null = null;

    const placeCylinder = (mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) => {
      const dir = to.clone().sub(from);
      const length = Math.max(dir.length(), 1e-3);
      mesh.position.copy(from).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.scale.set(1, length, 1);
    };

    const updateProbePose = (pose: ProbePose) => {
      currentPose = pose;
      placeCylinder(shaftMesh, pose.pivot, pose.joint);
      placeCylinder(flexMesh, pose.joint, pose.arrayCenter);
      const basis = new THREE.Matrix4().makeBasis(pose.arrayAxis, pose.planeNormal.clone().negate(), pose.beamDir);
      headGroup.position.copy(pose.arrayCenter);
      headGroup.quaternion.setFromRotationMatrix(basis);
      refreshGuide();
      headGroup.updateMatrixWorld(true);
    };

    const setGuideExtension = (from: THREE.Vector3 | null, to: THREE.Vector3 | null) => {
      guideExtension.visible = !!from && !!to;
      if (from && to) {
        extensionGeom.setFromPoints([from, to]);
        guideExtension.computeLineDistances();
      }
    };

    const getProbePlaneData = (): ProbeUSPlaneData => {
      if (!currentPose) throw new Error('Probe pose not set');
      return {
        kind: 'linear',
        origin: currentPose.arrayCenter.clone(),
        normal: currentPose.planeNormal.clone(),
        xAxis: currentPose.arrayAxis.clone(),
        yAxis: currentPose.beamDir.clone(),
        halfWidthMm: spec.arrayLengthMm / 2,
        nearDepthMm: spec.image.nearDepthMm,
        farDepthMm: spec.image.farDepthMm,
        sliceThicknessMm: spec.image.sliceThicknessMm
      };
    };

    const getPose = () => currentPose;

    return { probeGroup, usSliceMesh, usGuideLine, getProbePlaneData, updateProbePose, setGuideExtension, getPose };
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
      roll: number = 0,
      percutaneousNormal?: THREE.Vector3
    ) => {
      let pivot: THREE.Vector3;
      let normal: THREE.Vector3;

      if (mode === 'trocar') {
        const def = TROCAR_PRESETS[trocarId] || TROCAR_PRESETS['subcostal'];
        pivot = def.pivotPosition;
        normal = def.defaultDirection;
      } else {
        pivot = percutaneousPivot;
        normal = percutaneousNormal ? percutaneousNormal.clone().normalize() : new THREE.Vector3(0, 0, -1);
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

  /**
   * Create Right-Angle Wedge Visual Guide (Triangle ABC + Point C Marker)
   */
  private static createWedgeGuide(): {
    wedgeGroup: THREE.Group;
    updateWedge: (
      visible: boolean,
      pointA?: THREE.Vector3,
      pointB?: THREE.Vector3,
      pointC?: THREE.Vector3
    ) => void;
  } {
    const wedgeGroup = new THREE.Group();
    wedgeGroup.name = 'RightAngleWedgeGuide';
    wedgeGroup.visible = false;

    // Glowing Point C entry marker (sphere + ring)
    const markerGeom = new THREE.SphereGeometry(2.5, 16, 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    const markerMesh = new THREE.Mesh(markerGeom, markerMat);
    wedgeGroup.add(markerMesh);

    const ringGeom = new THREE.RingGeometry(3.5, 5.0, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    wedgeGroup.add(ringMesh);

    // Triangle ABC semi-transparent planar surface
    const triGeom = new THREE.BufferGeometry();
    const positions = new Float32Array(9); // 3 vertices * 3 coordinates
    triGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const triMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const triMesh = new THREE.Mesh(triGeom, triMat);
    wedgeGroup.add(triMesh);

    // Triangle ABC perimeter wireframe
    const wireGeom = new THREE.BufferGeometry();
    const wirePositions = new Float32Array(9);
    wireGeom.setAttribute('position', new THREE.BufferAttribute(wirePositions, 3));
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.75
    });
    const wire = new THREE.LineLoop(wireGeom, wireMat);
    wedgeGroup.add(wire);

    const updateWedge = (
      visible: boolean,
      pointA?: THREE.Vector3,
      pointB?: THREE.Vector3,
      pointC?: THREE.Vector3
    ) => {
      if (!visible || !pointA || !pointB || !pointC) {
        wedgeGroup.visible = false;
        return;
      }
      wedgeGroup.visible = true;

      // Position marker at point C
      markerMesh.position.copy(pointC);
      ringMesh.position.copy(pointC);
      ringMesh.lookAt(pointB);

      // Update triangle vertices: Point A (transducer), Point B (tumor), Point C (entry)
      const posAttr = triGeom.getAttribute('position') as THREE.BufferAttribute;
      const wireAttr = wireGeom.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;

      arr[0] = pointA.x; arr[1] = pointA.y; arr[2] = pointA.z;
      arr[3] = pointB.x; arr[4] = pointB.y; arr[5] = pointB.z;
      arr[6] = pointC.x; arr[7] = pointC.y; arr[8] = pointC.z;
      posAttr.needsUpdate = true;
      triGeom.computeVertexNormals();

      const wireArr = wireAttr.array as Float32Array;
      wireArr.set(arr);
      wireAttr.needsUpdate = true;
    };

    return { wedgeGroup, updateWedge };
  }
}
