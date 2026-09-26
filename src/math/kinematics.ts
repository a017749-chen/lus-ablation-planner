import * as THREE from 'three';

export interface FulcrumState {
  pivot: THREE.Vector3;
  direction: THREE.Vector3;
  tip: THREE.Vector3;
  handle: THREE.Vector3;
  quaternion: THREE.Quaternion;
  pitch: number; // degrees
  yaw: number;   // degrees
  roll: number;  // degrees
  insertionDepth: number; // mm
  totalLength: number; // mm
}

/**
 * 4-DOF Trocar Fulcrum Kinematics Engine
 * Models physical constraint where the abdominal wall incision is an invariant pivot point.
 */
export class FulcrumKinematics {
  /**
   * Returns the first non-negative depth at which a ray enters a sphere.
   * A null result means the forward ray does not intersect the target.
   */
  public static raySphereEntryDepth(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    center: THREE.Vector3,
    radius: number
  ): number | null {
    if (!Number.isFinite(radius) || radius < 0) return null;
    if (![...origin.toArray(), ...direction.toArray(), ...center.toArray()].every(Number.isFinite)) {
      return null;
    }

    const directionLengthSq = direction.lengthSq();
    if (directionLengthSq < 1e-12) return null;
    if (origin.distanceToSquared(center) <= radius * radius) return 0;

    const unitDirection = direction.clone().multiplyScalar(1 / Math.sqrt(directionLengthSq));
    const toCenter = center.clone().sub(origin);
    const projection = toCenter.dot(unitDirection);
    if (projection < 0) return null;

    const perpendicularSq = Math.max(0, toCenter.lengthSq() - projection * projection);
    const radiusSq = radius * radius;
    if (perpendicularSq > radiusSq + 1e-9) return null;

    const halfChord = Math.sqrt(Math.max(0, radiusSq - perpendicularSq));
    const entryDepth = projection - halfChord;
    return entryDepth >= -1e-9 ? Math.max(0, entryDepth) : null;
  }

  /** True only when a point lies inside or on a sphere in world coordinates. */
  public static isPointWithinSphere(
    point: THREE.Vector3,
    center: THREE.Vector3,
    radius: number
  ): boolean {
    return Number.isFinite(radius) && radius >= 0 &&
      point.distanceToSquared(center) <= radius * radius + 1e-9;
  }

  /**
   * Forward kinematics: compute instrument tip, handle and orientation from angles & depth
   */
  public static computeForward(
    pivot: THREE.Vector3,
    baseNormal: THREE.Vector3,
    pitchDeg: number,
    yawDeg: number,
    rollDeg: number,
    insertionDepth: number,
    totalLength: number = 280
  ): FulcrumState {
    const pitchRad = THREE.MathUtils.degToRad(pitchDeg);
    const yawRad = THREE.MathUtils.degToRad(yawDeg);
    const rollRad = THREE.MathUtils.degToRad(rollDeg);

    // Compute coordinate frame at pivot
    const normal = baseNormal.clone().normalize();
    
    // Choose a consistent up vector not parallel to normal
    let tempUp = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.dot(tempUp)) > 0.9) {
      tempUp.set(1, 0, 0);
    }
    const right = new THREE.Vector3().crossVectors(tempUp, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();

    // Construct rotation: first yaw around up, then pitch around right, then roll around direction
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, yawRad);
    const rotatedRight = right.clone().applyQuaternion(qYaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(rotatedRight, pitchRad);

    const qCombined = new THREE.Quaternion().multiplyQuaternions(qPitch, qYaw);
    const dir = normal.clone().applyQuaternion(qCombined).normalize();

    const qBase = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(dir, rollRad);
    const finalQuaternion = new THREE.Quaternion()
      .multiplyQuaternions(qRoll, qCombined)
      .multiply(qBase);

    // Instrument tip is along direction into the peritoneal cavity
    const tip = pivot.clone().addScaledVector(dir, insertionDepth);
    // Instrument handle/tail is backward outside the abdomen
    const handleDist = Math.max(20, totalLength - insertionDepth);
    const handle = pivot.clone().addScaledVector(dir, -handleDist);

    return {
      pivot: pivot.clone(),
      direction: dir,
      tip,
      handle,
      quaternion: finalQuaternion,
      pitch: pitchDeg,
      yaw: yawDeg,
      roll: rollDeg,
      insertionDepth,
      totalLength
    };
  }

  /**
   * Inverse kinematics: solve pitch, yaw and insertion depth to aim needle/instrument at a 3D target point
   */
  public static solveAimTarget(
    pivot: THREE.Vector3,
    baseNormal: THREE.Vector3,
    targetPoint: THREE.Vector3
  ): { pitch: number; yaw: number; insertionDepth: number; dir: THREE.Vector3 } {
    const toTarget = new THREE.Vector3().subVectors(targetPoint, pivot);
    const insertionDepth = toTarget.length();
    const dir = toTarget.clone().normalize();

    const normal = baseNormal.clone().normalize();
    let tempUp = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.dot(tempUp)) > 0.9) {
      tempUp.set(1, 0, 0);
    }
    const right = new THREE.Vector3().crossVectors(tempUp, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();

    // Project dir into local frame (right, up, normal)
    const localX = dir.dot(right);
    const localY = dir.dot(up);
    const localZ = dir.dot(normal);

    // These signs match computeForward(): positive pitch rotates the shaft toward -up.
    const yawRad = Math.atan2(localX, localZ);
    const pitchRad = Math.atan2(-localY, Math.hypot(localX, localZ));

    return {
      pitch: THREE.MathUtils.radToDeg(pitchRad),
      yaw: THREE.MathUtils.radToDeg(yawRad),
      insertionDepth,
      dir
    };
  }
}
