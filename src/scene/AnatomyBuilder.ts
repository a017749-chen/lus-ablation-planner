import * as THREE from 'three';
import { CollisionDetector, VesselSegment } from '../math/collision';

export interface AnatomyMeshes {
  group: THREE.Group;
  abdominalDome: THREE.Mesh;
  skinDome: THREE.Mesh;
  skinIncisionMarkers: THREE.Group;
  costalMarginLine: THREE.Line;
  intercostalRibs: THREE.Group;
  landmarks: THREE.Group;
  liverGroup: THREE.Group;
  tumorMesh: THREE.Mesh;
  marginMesh: THREE.Mesh;
  vesselsGroup: THREE.Group;
  vesselMeshes: Map<string, THREE.Mesh>;
  updateTumor(position: THREE.Vector3, diameter: number, margin: number): void;
  setVesselAlert(isAlert: boolean): void;
  setSkinOpacity(opacity: number): void;
  updatePercutaneousIncision(position: THREE.Vector3): void;
}

export class AnatomyBuilder {
  /**
   * Build complete procedural anatomy
   */
  public static build(): AnatomyMeshes {
    const group = new THREE.Group();
    group.name = 'AnatomyRoot';

    // 1. Abdominal Wall Dome (Pneumoperitoneum ~14mmHg)
    const domeGeom = new THREE.SphereGeometry(140, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.48);
    domeGeom.rotateX(Math.PI);
    domeGeom.scale(1.0, 1.15, 0.7);
    domeGeom.translate(10, 0, 45);

    const domeMat = new THREE.MeshPhysicalMaterial({
      color: 0x244265,
      transparent: true,
      opacity: 0.15,
      roughness: 0.2,
      metalness: 0.1,
      transmission: 0.6,
      thickness: 3.0,
      wireframe: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const abdominalDome = new THREE.Mesh(domeGeom, domeMat);
    abdominalDome.name = 'AbdominalWallDome';
    group.add(abdominalDome);

    // Subtle dome wireframe grid
    const domeWireMat = new THREE.MeshBasicMaterial({
      color: 0x00d2ff,
      wireframe: true,
      transparent: true,
      opacity: 0.08
    });
    const domeWire = new THREE.Mesh(domeGeom, domeWireMat);
    group.add(domeWire);

    // 1b. Realistic Epidermal Skin Layer (Human skin tone PBR with subcutaneous depth)
    const skinGeom = new THREE.SphereGeometry(142, 54, 30, 0, Math.PI * 2, 0, Math.PI * 0.48);
    skinGeom.rotateX(Math.PI);
    skinGeom.scale(1.0, 1.15, 0.7);
    skinGeom.translate(10, 0, 46);

    const skinMat = new THREE.MeshPhysicalMaterial({
      color: 0xdfaa8b, // Natural warm epidermal skin tone
      roughness: 0.55,
      metalness: 0.02,
      transmission: 0.25,
      thickness: 2.5,
      transparent: true,
      opacity: 0.25, // default in translucent MIS planning mode
      depthWrite: false,
      side: THREE.DoubleSide,
      clearcoat: 0.15,
      clearcoatRoughness: 0.3
    });
    const skinDome = new THREE.Mesh(skinGeom, skinMat);
    skinDome.name = 'RealisticEpidermalSkin';
    group.add(skinDome);

    // Skin Incision Markers (Trocar and needle entry sites on skin surface)
    const skinIncisionMarkers = new THREE.Group();
    skinIncisionMarkers.name = 'SkinIncisionMarkers';

    const createIncisionMarker = (name: string, pos: THREE.Vector3, color: number, radius: number = 5) => {
      const markerGroup = new THREE.Group();
      markerGroup.name = name;
      markerGroup.position.copy(pos);

      // Incision ring
      const ringGeom = new THREE.RingGeometry(radius - 1.2, radius + 1.2, 24);
      const ringMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.rotateX(-Math.PI * 0.15);
      markerGroup.add(ring);

      // Incision slit line
      const slitPts = [new THREE.Vector3(-radius, 0, 0.5), new THREE.Vector3(radius, 0, 0.5)];
      const slitLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(slitPts),
        new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })
      );
      slitLine.rotateX(-Math.PI * 0.15);
      markerGroup.add(slitLine);

      return markerGroup;
    };

    skinIncisionMarkers.add(createIncisionMarker('UmbilicalIncision', new THREE.Vector3(0, -90, 86), 0x00d2ff, 6));
    skinIncisionMarkers.add(createIncisionMarker('SubxiphoidIncision', new THREE.Vector3(15, 80, 81), 0x9d4edd, 4));
    skinIncisionMarkers.add(createIncisionMarker('SubcostalIncision', new THREE.Vector3(-75, -20, 69), 0x00ff66, 7));
    skinIncisionMarkers.add(createIncisionMarker('ITTIncision', new THREE.Vector3(-105, 55, 21), 0xffb800, 6));

    const percutaneousIncision = createIncisionMarker('PercutaneousIncision', new THREE.Vector3(-65, 0, 71), 0xff3b30, 3.5);
    skinIncisionMarkers.add(percutaneousIncision);
    group.add(skinIncisionMarkers);

    // 2. Costal Margin Line & Ribs
    const costalMarginPoints: THREE.Vector3[] = [];
    // Arc tracing xiphoid down along both costal margins
    for (let t = -Math.PI * 0.45; t <= Math.PI * 0.45; t += 0.05) {
      const x = Math.sin(t) * 115;
      const y = Math.cos(t) * 95 - 20;
      const z = Math.cos(t * 1.5) * 45 + 30;
      costalMarginPoints.push(new THREE.Vector3(x, y, z));
    }
    const costalGeom = new THREE.BufferGeometry().setFromPoints(costalMarginPoints);
    const costalMat = new THREE.LineBasicMaterial({
      color: 0x00d2ff,
      transparent: true,
      opacity: 0.65,
      linewidth: 2
    });
    const costalMarginLine = new THREE.Line(costalGeom, costalMat);
    group.add(costalMarginLine);

    // Intercostal Rib Arcs (focused on right 7th, 8th, 9th ribs for ITT context)
    const intercostalRibs = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const ribPts: THREE.Vector3[] = [];
      const yOffset = 25 + i * 18;
      for (let theta = 0.1; theta <= 1.4; theta += 0.08) {
        const x = -Math.cos(theta) * (110 - i * 4);
        const y = yOffset - theta * 12;
        const z = Math.sin(theta) * 60 + 5;
        ribPts.push(new THREE.Vector3(x, y, z));
      }
      const ribCurve = new THREE.CatmullRomCurve3(ribPts);
      const ribTubeGeom = new THREE.TubeGeometry(ribCurve, 20, 3.2, 8, false);
      const ribMat = new THREE.MeshStandardMaterial({
        color: 0x78909c,
        roughness: 0.5,
        transparent: true,
        opacity: 0.45
      });
      const ribMesh = new THREE.Mesh(ribTubeGeom, ribMat);
      intercostalRibs.add(ribMesh);
    }
    group.add(intercostalRibs);

    // 3. Anatomical Landmarks
    const landmarks = new THREE.Group();
    // Umbilicus marker
    const umbilicusRingGeom = new THREE.RingGeometry(4, 7, 24);
    const umbilicusMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff, side: THREE.DoubleSide });
    const umbilicusMesh = new THREE.Mesh(umbilicusRingGeom, umbilicusMat);
    umbilicusMesh.position.set(0, -90, 85);
    umbilicusMesh.rotateX(-Math.PI * 0.15);
    landmarks.add(umbilicusMesh);

    // Xiphoid Process marker
    const xiphoidGeom = new THREE.ConeGeometry(5, 12, 16);
    const xiphoidMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.3 });
    const xiphoidMesh = new THREE.Mesh(xiphoidGeom, xiphoidMat);
    xiphoidMesh.position.set(0, 90, 78);
    xiphoidMesh.rotateZ(Math.PI);
    landmarks.add(xiphoidMesh);

    // Patient-side badges are anchored to anatomy and face each active camera.
    const addPatientSideLabel = (side: 'R' | 'L', x: number) => {
      const labelGroup = new THREE.Group();
      labelGroup.name = side === 'R' ? 'PatientRightLabel' : 'PatientLeftLabel';
      labelGroup.userData.isPatientSideBillboard = true;
      labelGroup.position.set(x, 58, 28);

      const color = side === 'R' ? 0x5ce1e6 : 0xffb800;
      const badge = new THREE.Mesh(
        new THREE.CircleGeometry(10, 24),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.24,
          depthTest: false,
          depthWrite: false
        })
      );
      badge.renderOrder = 10;
      labelGroup.add(badge);

      const strokes: Array<[number, number]> = side === 'R'
        ? [
            [-4, -6], [-4, 6], [-4, 6], [2, 6], [2, 6], [5, 4],
            [5, 4], [5, 2], [5, 2], [2, 0], [2, 0], [-4, 0],
            [-4, 0], [5, -6]
          ]
        : [
            [-4, 6], [-4, -6], [-4, -6], [5, -6]
          ];
      const points: THREE.Vector3[] = [];
      for (const [xPoint, yPoint] of strokes) {
        points.push(new THREE.Vector3(xPoint, yPoint, 0.25));
      }
      const glyph = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false })
      );
      glyph.renderOrder = 11;
      labelGroup.add(glyph);
      landmarks.add(labelGroup);
    };

    addPatientSideLabel('R', -128);
    addPatientSideLabel('L', 128);
    group.add(landmarks);

    // 4. Illustrative hepatic lobes; these are not Couinaud segment masks.
    const liverGroup = new THREE.Group();
    liverGroup.name = 'LiverParenchyma';

    // These overlapping ellipsoids suggest gross lobe shape only. Their separate mesh volumes
    // do not represent a non-overlapping 70:30 partition or patient-specific liver anatomy.
    const rightLobeGeom = new THREE.SphereGeometry(65, 32, 24);
    rightLobeGeom.scale(1.2, 1.1, 0.75);

    const rightLobeMat = new THREE.MeshPhysicalMaterial({
      color: 0xa8422b, // Realistic liver reddish-brown
      roughness: 0.35,
      metalness: 0.05,
      transmission: 0.35,
      transparent: true,
      opacity: 0.72,
      depthWrite: true,
      clearcoat: 0.3
    });
    const rightLobe = new THREE.Mesh(rightLobeGeom, rightLobeMat);
    rightLobe.name = 'IllustrativeRightLobe';
    rightLobe.position.set(-35, 15, -10);
    liverGroup.add(rightLobe);

    // Left Lobe: S2/S3 (lateral), S4 (medial)
    const leftLobeGeom = new THREE.SphereGeometry(60, 28, 20);
    leftLobeGeom.scale(1.3, 0.85, 0.5);

    const leftLobeMat = new THREE.MeshPhysicalMaterial({
      color: 0x943622,
      roughness: 0.4,
      metalness: 0.05,
      transmission: 0.38,
      transparent: true,
      opacity: 0.7,
      depthWrite: true,
      clearcoat: 0.25
    });
    const leftLobe = new THREE.Mesh(leftLobeGeom, leftLobeMat);
    // Mirror the left-lobe placement across the patient midline.
    leftLobe.name = 'IllustrativeLeftLobe';
    leftLobe.position.set(38 * Math.cos(0.2) + 10 * Math.sin(0.2), -38 * Math.sin(0.2) + 10 * Math.cos(0.2), 5);
    leftLobe.rotation.z = -0.2;
    liverGroup.add(leftLobe);

    // Diaphragmatic Dome surface indicator (for S7/S8 high dome)
    const domeCoverGeom = new THREE.SphereGeometry(68, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.35);
    domeCoverGeom.scale(1.15, 0.9, 0.75);
    domeCoverGeom.translate(-35, 52, -18);
    const domeCoverMat = new THREE.MeshBasicMaterial({
      color: 0xffb800,
      wireframe: true,
      transparent: true,
      opacity: 0.18
    });
    const domeCover = new THREE.Mesh(domeCoverGeom, domeCoverMat);
    domeCover.name = 'DiaphragmaticDome';
    liverGroup.add(domeCover);

    group.add(liverGroup);

    // 5. Target Tumor & Safety Margin
    const tumorGeom = new THREE.SphereGeometry(10, 32, 24); // 20mm default diameter
    const tumorMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30,
      emissive: 0xaa1010,
      emissiveIntensity: 0.4,
      roughness: 0.25,
      metalness: 0.2
    });
    const tumorMesh = new THREE.Mesh(tumorGeom, tumorMat);
    tumorMesh.name = 'TargetTumor';
    group.add(tumorMesh);

    // Safety margin halo shell
    const marginGeom = new THREE.SphereGeometry(15, 32, 24); // +5mm margin radius
    const marginMat = new THREE.MeshPhysicalMaterial({
      color: 0xffb800,
      transparent: true,
      opacity: 0.22,
      roughness: 0.1,
      transmission: 0.5,
      depthWrite: false,
      wireframe: false
    });
    const marginMesh = new THREE.Mesh(marginGeom, marginMat);
    marginMesh.name = 'SafetyMargin';
    group.add(marginMesh);

    // 6. Critical Vascular Network (IVC and Portal Vein)
    const vesselsGroup = new THREE.Group();
    vesselsGroup.name = 'CriticalVessels';
    const vesselMeshes = new Map<string, THREE.Mesh>();

    const vascularTree = CollisionDetector.getVascularTree();
    for (const v of vascularTree) {
      const dir = new THREE.Vector3().subVectors(v.end, v.start);
      const length = dir.length();
      const center = new THREE.Vector3().addVectors(v.start, v.end).multiplyScalar(0.5);

      const geom = new THREE.CylinderGeometry(v.radius, v.radius, length, 24);
      // Orient cylinder along dir
      const cylMesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
        color: v.color,
        roughness: 0.3,
        metalness: 0.15,
        transparent: true,
        opacity: 0.88
      }));

      cylMesh.position.copy(center);
      cylMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      cylMesh.name = v.name;

      vesselsGroup.add(cylMesh);
      vesselMeshes.set(v.name, cylMesh);
    }
    group.add(vesselsGroup);

    // Methods
    const updateTumor = (pos: THREE.Vector3, diameter: number, margin: number) => {
      tumorMesh.position.copy(pos);
      const tumorRadius = diameter * 0.5;
      tumorMesh.scale.setScalar(tumorRadius / 10); // base geom radius is 10

      marginMesh.position.copy(pos);
      const totalRadius = tumorRadius + margin;
      marginMesh.scale.setScalar(totalRadius / 15); // base geom radius is 15
    };

    const setVesselAlert = (isAlert: boolean) => {
      for (const [, mesh] of vesselMeshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (isAlert) {
          mat.emissive.setHex(0xff0020);
          mat.emissiveIntensity = 0.6;
        } else {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0.0;
        }
      }
    };

    const setSkinOpacity = (opacity: number) => {
      const clamped = Math.max(0, Math.min(1, opacity));
      skinMat.opacity = clamped;
      skinMat.depthWrite = clamped > 0.65;
      skinMat.transparent = clamped < 0.99;
    };

    const updatePercutaneousIncision = (pos: THREE.Vector3) => {
      percutaneousIncision.position.set(pos.x, pos.y, pos.z + 1.0);
    };

    return {
      group,
      abdominalDome,
      skinDome,
      skinIncisionMarkers,
      costalMarginLine,
      intercostalRibs,
      landmarks,
      liverGroup,
      tumorMesh,
      marginMesh,
      vesselsGroup,
      vesselMeshes,
      updateTumor,
      setVesselAlert,
      setSkinOpacity,
      updatePercutaneousIncision
    };
  }
}
