import * as THREE from 'three';

type PatientSide = 'right' | 'left';

interface IllustrativeLobeMetadata {
  side: PatientSide;
  interfaceX: number;
  extentX: number;
  radiusY: number;
  radiusZ: number;
}

export interface IllustrativeLobes {
  rightLobe: THREE.Mesh;
  leftLobe: THREE.Mesh;
}

/**
 * A continuous, non-overlapping schematic liver surface divided at the midline.
 * Dimensions preserve the former model's approximate total volume and a 70:30
 * right-to-left lobe volume cue. This is not patient-specific anatomy.
 */
const MODEL = {
  interfaceX: 15,
  centerY: 25,
  centerZ: -10,
  radiusY: 75,
  radiusZ: 44,
  rightExtentX: 164.5,
  leftExtentX: 70.5,
  longitudinalSegments: 48,
  radialSegments: 64
} as const;

export function buildIllustrativeLobes(): IllustrativeLobes {
  return {
    rightLobe: buildHalfEllipsoidLobe('right', MODEL.rightExtentX, 0xa8422b),
    leftLobe: buildHalfEllipsoidLobe('left', MODEL.leftExtentX, 0x943622)
  };
}

/**
 * Conservatively checks a target sphere against the schematic half-ellipsoid.
 * This is a geometry regression check only, not a clinical containment rule.
 */
export function containsSphereWithinIllustrativeLobe(
  mesh: THREE.Mesh,
  center: THREE.Vector3,
  radius: number
): boolean {
  const metadata = mesh.userData.illustrativeLobe as IllustrativeLobeMetadata | undefined;
  if (
    !metadata ||
    !Number.isFinite(radius) ||
    radius < 0 ||
    metadata.extentX <= 0 ||
    metadata.radiusY <= 0 ||
    metadata.radiusZ <= 0
  ) return false;

  mesh.updateMatrixWorld(true);
  const determinant = mesh.matrixWorld.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false;

  const inverse = mesh.matrixWorld.clone().invert();
  const localCenter = center.clone().applyMatrix4(inverse);
  const elements = inverse.elements;
  const localRadiusX = radius * Math.hypot(elements[0], elements[4], elements[8]);
  const localRadiusY = radius * Math.hypot(elements[1], elements[5], elements[9]);
  const localRadiusZ = radius * Math.hypot(elements[2], elements[6], elements[10]);

  const interfaceLocalX = metadata.side === 'right'
    ? metadata.extentX * 0.5
    : -metadata.extentX * 0.5;
  const distanceFromInterface = metadata.side === 'right'
    ? interfaceLocalX - localCenter.x
    : localCenter.x - interfaceLocalX;

  // The entire sphere must stay within the lobe's half-space, away from both
  // the shared interface and the outer tip of the half-ellipsoid.
  if (
    distanceFromInterface < localRadiusX ||
    distanceFromInterface > metadata.extentX - localRadiusX
  ) return false;

  const normalizedCenterDistance = Math.sqrt(
    (distanceFromInterface / metadata.extentX) ** 2 +
    (localCenter.y / metadata.radiusY) ** 2 +
    (localCenter.z / metadata.radiusZ) ** 2
  );

  // Frobenius norm bounds the transformed world-space sphere in normalized
  // ellipsoid coordinates, including rotated and non-uniformly scaled meshes.
  const normalizedRadiusBound = radius * Math.sqrt(
    (elements[0] ** 2 + elements[4] ** 2 + elements[8] ** 2) / metadata.extentX ** 2 +
    (elements[1] ** 2 + elements[5] ** 2 + elements[9] ** 2) / metadata.radiusY ** 2 +
    (elements[2] ** 2 + elements[6] ** 2 + elements[10] ** 2) / metadata.radiusZ ** 2
  );

  return normalizedCenterDistance + normalizedRadiusBound < 1;
}

function buildHalfEllipsoidLobe(
  side: PatientSide,
  extentX: number,
  color: number
): THREE.Mesh {
  const { radialSegments, longitudinalSegments, radiusY, radiusZ } = MODEL;
  const positions: number[] = [];
  const sideIndices: number[] = [];
  const capIndices: number[] = [];

  const addVertex = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };

  const ringIndex = (ring: number, radial: number) =>
    ring * radialSegments + (radial % radialSegments);

  for (let ring = 0; ring < longitudinalSegments; ring++) {
    const t = ring / longitudinalSegments;
    const crossSectionScale = Math.sqrt(1 - t * t);
    const localX = side === 'right'
      ? extentX * (0.5 - t)
      : extentX * (t - 0.5);

    for (let radial = 0; radial < radialSegments; radial++) {
      const angle = (radial / radialSegments) * Math.PI * 2;
      addVertex(
        localX,
        Math.cos(angle) * radiusY * crossSectionScale,
        Math.sin(angle) * radiusZ * crossSectionScale
      );
    }
  }

  const tipIndex = addVertex(side === 'right' ? -extentX * 0.5 : extentX * 0.5, 0, 0);

  for (let ring = 0; ring < longitudinalSegments - 1; ring++) {
    for (let radial = 0; radial < radialSegments; radial++) {
      const a = ringIndex(ring, radial);
      const b = ringIndex(ring + 1, radial);
      const c = ringIndex(ring + 1, radial + 1);
      const d = ringIndex(ring, radial + 1);

      if (side === 'right') {
        sideIndices.push(a, b, c, a, c, d);
      } else {
        sideIndices.push(a, c, b, a, d, c);
      }
    }
  }

  const lastRing = longitudinalSegments - 1;
  for (let radial = 0; radial < radialSegments; radial++) {
    const a = ringIndex(lastRing, radial);
    const next = ringIndex(lastRing, radial + 1);
    if (side === 'right') {
      sideIndices.push(a, tipIndex, next);
    } else {
      sideIndices.push(a, next, tipIndex);
    }
  }

  // Duplicate the shared-boundary ring so the hidden cap cannot flatten the
  // normals on the visible liver surface.
  const capRingStart = positions.length / 3;
  for (let radial = 0; radial < radialSegments; radial++) {
    const source = ringIndex(0, radial) * 3;
    addVertex(positions[source], positions[source + 1], positions[source + 2]);
  }
  const capCenter = addVertex(
    side === 'right' ? extentX * 0.5 : -extentX * 0.5,
    0,
    0
  );
  for (let radial = 0; radial < radialSegments; radial++) {
    const current = capRingStart + radial;
    const next = capRingStart + ((radial + 1) % radialSegments);
    if (side === 'right') {
      capIndices.push(capCenter, current, next);
    } else {
      capIndices.push(capCenter, next, current);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([...sideIndices, ...capIndices]);
  geometry.addGroup(0, sideIndices.length, 0);
  geometry.addGroup(sideIndices.length, capIndices.length, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const surfaceMaterial = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.37,
    metalness: 0.04,
    transparent: true,
    opacity: 0.76,
    depthWrite: true,
    clearcoat: 0.28,
    side: THREE.DoubleSide
  });
  const hiddenInterfaceMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const mesh = new THREE.Mesh(geometry, [surfaceMaterial, hiddenInterfaceMaterial]);
  mesh.name = side === 'right' ? 'IllustrativeRightLobe' : 'IllustrativeLeftLobe';
  mesh.position.set(
    side === 'right'
      ? MODEL.interfaceX - extentX * 0.5
      : MODEL.interfaceX + extentX * 0.5,
    MODEL.centerY,
    MODEL.centerZ
  );
  mesh.userData.illustrativeLobe = {
    side,
    interfaceX: MODEL.interfaceX,
    extentX,
    radiusY,
    radiusZ
  } satisfies IllustrativeLobeMetadata;

  return mesh;
}

