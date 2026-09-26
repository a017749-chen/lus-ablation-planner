import * as THREE from 'three';
import { ILLUSTRATIVE_LIVER_MODEL as LIVER } from './LiverLobeBuilder';
import { liverNormal, liverValue } from '../math/anatomyShapes';

export interface CouinaudSegmentMeta {
  id: string;
  name: string;
  shortName: string;
  side: 'right' | 'left' | 'central';
  color: number;
  center: THREE.Vector3;
  description: string;
}

/**
 * Couinaud 8 segments based on portal and hepatic venous segmentation:
 * S1: Caudate Lobe (posterior, retrohepatic, adjacent to IVC)
 * S2: Left Lateral Superior (cranial left lobe)
 * S3: Left Lateral Inferior (caudal left lobe)
 * S4a: Left Medial Superior (cranial medial, right of falciform)
 * S4b: Left Medial Inferior (caudal medial, left of gallbladder fossa)
 * S5: Right Anterior Inferior (caudal anterior right)
 * S6: Right Posterior Inferior (caudal posterolateral right)
 * S7: Right Posterior Superior (cranial posterolateral right)
 * S8: Right Anterior Superior (cranial anterior dome)
 */
export const COUINAUD_SEGMENTS: CouinaudSegmentMeta[] = [
  {
    id: 'S1',
    name: 'Segment I (尾狀葉 Caudate Lobe)',
    shortName: 'S1',
    side: 'central',
    color: 0x90caf9,
    center: new THREE.Vector3(2, 20, -42),
    description: '背側尾狀葉，緊貼下腔靜脈（IVC）與門脈主幹，消融穿刺需極度避開血管。'
  },
  {
    id: 'S2',
    name: 'Segment II (左外側上段 Left Lateral Superior)',
    shortName: 'S2',
    side: 'left',
    color: 0xffb74d,
    center: new THREE.Vector3(52, 54, 5),
    description: '左肝外側上段，靠近橫膈左側，胃左側視野良好。'
  },
  {
    id: 'S3',
    name: 'Segment III (左外側下段 Left Lateral Inferior)',
    shortName: 'S3',
    side: 'left',
    color: 0xffa726,
    center: new THREE.Vector3(56, -6, 20),
    description: '左肝外側下緣，表面平整，腹腔鏡超音波最易探查區段。'
  },
  {
    id: 'S4a',
    name: 'Segment IVa (左內側上段 Left Medial Superior)',
    shortName: 'S4a',
    side: 'left',
    color: 0xffcc80,
    center: new THREE.Vector3(12, 56, 18),
    description: '左肝內側頂端，位於鐮狀韌帶右側、Cantlie 線左側。'
  },
  {
    id: 'S4b',
    name: 'Segment IVb (左內側下段 Left Medial Inferior)',
    shortName: 'S4b',
    side: 'left',
    color: 0xffe082,
    center: new THREE.Vector3(8, -10, 30),
    description: '方葉（Quadrate lobe），緊鄰膽囊窩左界。'
  },
  {
    id: 'S5',
    name: 'Segment V (右前下段 Right Anterior Inferior)',
    shortName: 'S5',
    side: 'right',
    color: 0x4dd0e1,
    center: new THREE.Vector3(-36, -14, 30),
    description: '右肝前下段，膽囊窩右側，腹腔鏡肋下探頭主接觸區。'
  },
  {
    id: 'S6',
    name: 'Segment VI (右後下段 Right Posterior Inferior)',
    shortName: 'S6',
    side: 'right',
    color: 0x26c6da,
    center: new THREE.Vector3(-96, -16, 12),
    description: '右肝後下段，貼近右腎上極與結腸肝曲。'
  },
  {
    id: 'S7',
    name: 'Segment VII (右後上段 Right Posterior Superior)',
    shortName: 'S7',
    side: 'right',
    color: 0x80deea,
    center: new THREE.Vector3(-106, 46, -14),
    description: '右肝後上深部，橫膈頂高位，常需經肋間（ITT）穿刺。'
  },
  {
    id: 'S8',
    name: 'Segment VIII (右前上段 Right Anterior Superior)',
    shortName: 'S8',
    side: 'right',
    color: 0x00e5ff,
    center: new THREE.Vector3(-42, 55, 18),
    description: '右肝頂部穹頂，靠近肝靜脈匯流部與腔靜脈。'
  }
];

export interface CouinaudVisualElements {
  group: THREE.Group;
  gallbladder: THREE.Group;
  falciformLigament: THREE.Group;
  fissureLines: THREE.Group;
  segmentBadges: THREE.Group;
  setVisible(visible: boolean): void;
}

/**
 * Builds procedural Couinaud anatomical elements:
 * 1. Couinaud segment surface boundary lines (Cantlie's line, Umbilical fissure, Right intersegmental, Portal plane)
 * 2. 3D Segment annotation badges (S1~S8)
 * 3. Gallbladder (Vesica Biliaris in Gallbladder Fossa)
 * 4. Falciform Ligament & Ligamentum Teres
 */
export class CouinaudBuilder {
  public static build(): CouinaudVisualElements {
    const group = new THREE.Group();
    group.name = 'CouinaudAnatomyRoot';

    // 1. Couinaud Fissure Lines (Projected onto liver surface)
    const fissureLines = CouinaudBuilder.buildFissureLines();
    group.add(fissureLines);

    // 2. 3D Segment Badges (S1~S8)
    const segmentBadges = CouinaudBuilder.buildSegmentBadges();
    group.add(segmentBadges);

    // 3. Gallbladder (Vesica Biliaris)
    const gallbladder = CouinaudBuilder.buildGallbladder();
    group.add(gallbladder);

    // 4. Falciform Ligament & Round Ligament
    const falciformLigament = CouinaudBuilder.buildFalciformLigament();
    group.add(falciformLigament);

    const setVisible = (visible: boolean) => {
      fissureLines.visible = visible;
      segmentBadges.visible = visible;
    };

    return {
      group,
      gallbladder,
      falciformLigament,
      fissureLines,
      segmentBadges,
      setVisible
    };
  }

  /**
   * Projects a point (x, y) along +Z onto the anterior liver surface
   */
  private static projectToAnteriorLiver(x: number, y: number): THREE.Vector3 | null {
    const lobeExtent = x < LIVER.interfaceX ? LIVER.rightExtentX : LIVER.leftExtentX;
    const sign = x < LIVER.interfaceX ? -1 : 1;
    const along = sign * (x - LIVER.interfaceX);
    const u = along / lobeExtent;
    const v = (y - LIVER.centerY) / LIVER.radiusY;
    const disc = 1 - u * u - v * v;
    if (disc < 0) return null;
    const z = LIVER.centerZ + Math.sqrt(disc) * LIVER.radiusZ;
    return new THREE.Vector3(x, y, z);
  }

  /**
   * Builds the anatomical fissure lines on the liver surface:
   * - Cantlie's Line (主肝裂): from gallbladder fossa to IVC, dividing functional right and left liver
   * - Left Intersegmental Fissure (左葉間裂 / 鐮狀韌帶基底)
   * - Right Intersegmental Fissure (右葉間裂)
   * - Transverse Portal Plane (橫斷門脈分界線)
   */
  private static buildFissureLines(): THREE.Group {
    const fissuresGroup = new THREE.Group();
    fissuresGroup.name = 'CouinaudFissureLines';

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.55,
      linewidth: 2,
      depthWrite: false
    });

    const cantlieMat = new THREE.LineBasicMaterial({
      color: 0xffd54f, // Golden for Cantlie's line
      transparent: true,
      opacity: 0.85,
      linewidth: 2,
      depthWrite: false
    });

    const createSurfaceLine = (
      points2D: Array<[number, number]>,
      material: THREE.LineBasicMaterial
    ) => {
      const pts3D: THREE.Vector3[] = [];
      for (const [x, y] of points2D) {
        const pt = CouinaudBuilder.projectToAnteriorLiver(x, y);
        if (pt) {
          // slight elevation (0.5mm) above surface to avoid z-fighting
          const norm = liverNormal(pt);
          pts3D.push(pt.clone().addScaledVector(norm, 0.6));
        }
      }
      if (pts3D.length < 2) return null;
      const geom = new THREE.BufferGeometry().setFromPoints(pts3D);
      return new THREE.Line(geom, material);
    };

    // 1. Cantlie's Line (Gallbladder Fossa X=-12, Y=-32 to IVC X=-10, Y=78)
    const cantliePts: Array<[number, number]> = [];
    for (let y = -32; y <= 76; y += 4) {
      const t = (y + 32) / 108;
      const x = -12 + t * 2; // runs from X=-12 to X=-10
      cantliePts.push([x, y]);
    }
    const cantlieLine = createSurfaceLine(cantliePts, cantlieMat);
    if (cantlieLine) {
      cantlieLine.name = 'CantliesLine';
      fissuresGroup.add(cantlieLine);
    }

    // 2. Left Intersegmental Fissure (Umbilical fissure, X=15, Y=-25 to Y=78)
    const leftFissurePts: Array<[number, number]> = [];
    for (let y = -25; y <= 78; y += 4) {
      leftFissurePts.push([15, y]);
    }
    const leftFissure = createSurfaceLine(leftFissurePts, lineMat);
    if (leftFissure) {
      leftFissure.name = 'LeftIntersegmentalFissure';
      fissuresGroup.add(leftFissure);
    }

    // 3. Right Intersegmental Fissure (Separating V/VIII from VI/VII, X=-68, Y=-28 to Y=74)
    const rightFissurePts: Array<[number, number]> = [];
    for (let y = -28; y <= 74; y += 4) {
      rightFissurePts.push([-68, y]);
    }
    const rightFissure = createSurfaceLine(rightFissurePts, lineMat);
    if (rightFissure) {
      rightFissure.name = 'RightIntersegmentalFissure';
      fissuresGroup.add(rightFissure);
    }

    // 4. Transverse Portal Plane (Y=24, separating superior and inferior segments)
    const transversePts: Array<[number, number]> = [];
    for (let x = -135; x <= 72; x += 5) {
      transversePts.push([x, 24]);
    }
    const transverseLine = createSurfaceLine(transversePts, lineMat);
    if (transverseLine) {
      transverseLine.name = 'TransversePortalPlane';
      fissuresGroup.add(transverseLine);
    }

    return fissuresGroup;
  }

  /**
   * Builds 3D billboarded segment badges on the liver surface
   */
  private static buildSegmentBadges(): THREE.Group {
    const badgesGroup = new THREE.Group();
    badgesGroup.name = 'CouinaudSegmentBadges';

    for (const seg of COUINAUD_SEGMENTS) {
      const badge = new THREE.Group();
      badge.name = `Badge_${seg.shortName}`;
      badge.position.copy(seg.center);
      badge.userData.isPatientSideBillboard = true;

      // Circular backing pill
      const circleGeom = new THREE.CircleGeometry(7.5, 20);
      const circleMat = new THREE.MeshBasicMaterial({
        color: seg.color,
        transparent: true,
        opacity: 0.32,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const circleMesh = new THREE.Mesh(circleGeom, circleMat);
      circleMesh.renderOrder = 12;
      badge.add(circleMesh);

      // Ring border
      const ringGeom = new THREE.RingGeometry(7.0, 8.2, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: seg.color,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.renderOrder = 13;
      badge.add(ringMesh);

      // Vector glyph strokes for the short name (e.g. S1, S2, S3, S4a, S4b, S5, S6, S7, S8)
      const glyph = CouinaudBuilder.createGlyph(seg.shortName);
      if (glyph) {
        glyph.renderOrder = 14;
        badge.add(glyph);
      }

      badgesGroup.add(badge);
    }

    return badgesGroup;
  }

  /**
   * Creates minimalist vector glyph lines for Couinaud segment numbers
   */
  private static createGlyph(label: string): THREE.LineSegments | null {
    // Generate clean line segments for 'S' + number
    const strokes: Array<[number, number]> = [];

    // Letter 'S' at x = -3
    strokes.push(
      [-2, 3], [-4, 3],
      [-4, 3], [-4, 0.5],
      [-4, 0.5], [-2, 0],
      [-2, 0], [-2, -2.5],
      [-2, -2.5], [-4, -2.5]
    );

    // Digit / suffix at x = +2
    if (label.includes('1')) {
      strokes.push([1, 2], [2.5, 3], [2.5, 3], [2.5, -2.5], [1, -2.5], [4, -2.5]);
    } else if (label.includes('2')) {
      strokes.push([1, 3], [3.5, 3], [3.5, 3], [3.5, 0.5], [3.5, 0.5], [1, -2.5], [1, -2.5], [3.5, -2.5]);
    } else if (label.includes('3')) {
      strokes.push([1, 3], [3.5, 3], [3.5, 3], [2, 0.5], [2, 0.5], [3.5, 0], [3.5, 0], [3.5, -2.5], [3.5, -2.5], [1, -2.5]);
    } else if (label.includes('4')) {
      strokes.push([3, -2.5], [3, 3], [3, 3], [0.8, -0.5], [0.8, -0.5], [3.8, -0.5]);
    } else if (label.includes('5')) {
      strokes.push([3.5, 3], [1, 3], [1, 3], [1, 0.5], [1, 0.5], [3.5, 0.5], [3.5, 0.5], [3.5, -2.5], [3.5, -2.5], [1, -2.5]);
    } else if (label.includes('6')) {
      strokes.push([3.5, 3], [1, 3], [1, 3], [1, -2.5], [1, -2.5], [3.5, -2.5], [3.5, -2.5], [3.5, 0], [3.5, 0], [1, 0]);
    } else if (label.includes('7')) {
      strokes.push([1, 3], [3.5, 3], [3.5, 3], [1.5, -2.5]);
    } else if (label.includes('8')) {
      strokes.push(
        [1, 3], [3.5, 3], [3.5, 3], [3.5, -2.5], [3.5, -2.5], [1, -2.5], [1, -2.5], [1, 3],
        [1, 0.2], [3.5, 0.2]
      );
    }

    const points: THREE.Vector3[] = [];
    for (let i = 0; i < strokes.length; i += 2) {
      points.push(
        new THREE.Vector3(strokes[i][0], strokes[i][1], 0.2),
        new THREE.Vector3(strokes[i + 1][0], strokes[i + 1][1], 0.2)
      );
    }

    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false
    });
    return new THREE.LineSegments(geom, mat);
  }

  /**
   * Builds the anatomical Gallbladder (膽囊 - Vesica Biliaris) in the gallbladder fossa:
   * - Fundus: Round protruding tip visible below the anterior-inferior liver margin (X=-12, Y=-36, Z=18)
   * - Body: Pear-shaped reservoir in the visceral fossa (X=-11, Y=-24, Z=8)
   * - Neck & Cystic Duct: Narrowing heading posterosuperiorly towards porta hepatis (X=-8, Y=-12, Z=-2)
   */
  private static buildGallbladder(): THREE.Group {
    const gbGroup = new THREE.Group();
    gbGroup.name = 'GallbladderAssembly';

    // Gallbladder curve: Fundus -> Body -> Neck -> Cystic Duct
    const pathPoints = [
      new THREE.Vector3(-12, -37, 20), // Fundus (visible beneath anterior margin)
      new THREE.Vector3(-11.5, -28, 14), // Body mid
      new THREE.Vector3(-10, -18, 6),  // Body upper
      new THREE.Vector3(-8, -10, -3),  // Neck
      new THREE.Vector3(-6, -4, -6)    // Cystic Duct towards porta hepatis
    ];

    const gbCurve = new THREE.CatmullRomCurve3(pathPoints);

    // Anatomical gallbladder shape: wider fundus (r=7mm), tapering neck (r=2.5mm)
    const segments = 32;
    const radialSegments = 20;
    const gbGeom = new THREE.TubeGeometry(gbCurve, segments, 6.0, radialSegments, false);

    // Vary tube thickness by scaling vertices along the curve
    const posAttr = gbGeom.attributes.position;
    const tempPt = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tempPt.fromBufferAttribute(posAttr, i);
      // Normalized position along Y from caudal to cranial:
      const t = Math.max(0, Math.min(1, (tempPt.y - (-37)) / 33));
      // Taper profile: bulbous at fundus (t=0..0.3, factor ~1.15), tapered at neck (t=0.8..1.0, factor ~0.45)
      let radiusFactor = 1.0;
      if (t < 0.25) {
        radiusFactor = 1.15 + Math.sin(t * Math.PI * 2) * 0.15;
      } else if (t > 0.6) {
        radiusFactor = 1.0 - (t - 0.6) * 1.35;
      }
      // Scale displacement from centerline
      const centerPt = gbCurve.getPointAt(t);
      const diff = tempPt.clone().sub(centerPt);
      diff.multiplyScalar(radiusFactor);
      const newPos = centerPt.clone().add(diff);
      posAttr.setXYZ(i, newPos.x, newPos.y, newPos.z);
    }
    gbGeom.computeVertexNormals();

    // Characteristic bile deep jade green with smooth peritoneal clearcoat
    const gbMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x24582e, // Deep olive/jade bile green
      roughness: 0.25,
      metalness: 0.08,
      clearcoat: 0.45,
      clearcoatRoughness: 0.2,
      transmission: 0.18,
      thickness: 1.5,
      side: THREE.DoubleSide
    });

    const gbMesh = new THREE.Mesh(gbGeom, gbMaterial);
    gbMesh.name = 'GallbladderMesh';
    gbGroup.add(gbMesh);

    // Rounded fundus cap
    const fundusCapGeom = new THREE.SphereGeometry(6.6, 20, 16);
    fundusCapGeom.scale(1.0, 0.75, 0.9);
    const fundusCapMesh = new THREE.Mesh(fundusCapGeom, gbMaterial);
    fundusCapMesh.position.set(-12, -37.5, 20);
    fundusCapMesh.name = 'GallbladderFundus';
    gbGroup.add(fundusCapMesh);

    return gbGroup;
  }

  /**
   * Builds the Falciform Ligament & Round Ligament (Ligamentum Teres Hepatis):
   * - Membranous peritoneal fold along anterior liver fissure (X=15, Y=-25 to 78)
   * - Ligamentum teres cord running from the inferior umbilical notch to the umbilicus
   */
  private static buildFalciformLigament(): THREE.Group {
    const falciformGroup = new THREE.Group();
    falciformGroup.name = 'FalciformLigamentAssembly';

    // 1. Falciform Ligament Sheet (Anterior midline curtain)
    // Connects anterior liver surface (X=15) to inner anterior abdominal wall
    const sheetSteps = 24;
    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= sheetSteps; i++) {
      const s = i / sheetSteps;
      const y = -25 + s * 102; // Y from -25 to 77
      const liverPt = CouinaudBuilder.projectToAnteriorLiver(15, y);
      const liverZ = liverPt ? liverPt.z : 15;

      // Base attached to liver fissure
      positions.push(15, y, liverZ);
      // Free edge arching toward anterior abdominal wall (Z higher and slightly towards midline X=10)
      const archZ = liverZ + 22 + Math.sin(s * Math.PI) * 16;
      const archX = 15 - Math.sin(s * Math.PI) * 5;
      positions.push(archX, y, archZ);
    }

    for (let i = 0; i < sheetSteps; i++) {
      const base1 = i * 2;
      const arch1 = i * 2 + 1;
      const base2 = (i + 1) * 2;
      const arch2 = (i + 1) * 2 + 1;
      indices.push(base1, arch1, base2);
      indices.push(arch1, arch2, base2);
    }

    const sheetGeom = new THREE.BufferGeometry();
    sheetGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    sheetGeom.setIndex(indices);
    sheetGeom.computeVertexNormals();

    const sheetMat = new THREE.MeshPhysicalMaterial({
      color: 0xf4f0e6, // Pearlescent translucent ivory peritoneal fold
      roughness: 0.35,
      metalness: 0.02,
      transmission: 0.65,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    const sheetMesh = new THREE.Mesh(sheetGeom, sheetMat);
    sheetMesh.name = 'FalciformLigamentSheet';
    falciformGroup.add(sheetMesh);

    // 2. Ligamentum Teres Hepatis (Round Ligament / 肝圓韌帶)
    // Cord running from umbilical notch (X=15, Y=-25, Z=22) to umbilicus (X=0, Y=-90, Z=85)
    const teresPoints = [
      new THREE.Vector3(15, -25, 22),
      new THREE.Vector3(12, -45, 42),
      new THREE.Vector3(6, -68, 65),
      new THREE.Vector3(0, -90, 85)
    ];
    const teresCurve = new THREE.CatmullRomCurve3(teresPoints);
    const teresGeom = new THREE.TubeGeometry(teresCurve, 20, 1.8, 12, false);
    const teresMat = new THREE.MeshStandardMaterial({
      color: 0xe8e2d2,
      roughness: 0.4,
      transparent: true,
      opacity: 0.8
    });
    const teresMesh = new THREE.Mesh(teresGeom, teresMat);
    teresMesh.name = 'LigamentumTeresCord';
    falciformGroup.add(teresMesh);

    return falciformGroup;
  }
}
