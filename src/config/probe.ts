/**
 * Side-viewing laparoscopic ultrasound probe and its needle-guide hole.
 *
 * Geometry follows the class of probe the owner uses (side-viewing linear array
 * on a four-way flexible tip, e.g. BK 8666-RF): the array sits on the side of the
 * tip, the image plane contains the array axis, and the beam leaves the array face
 * at right angles. The guide hole is at the proximal ("後端") end of the array and
 * the needle crosses the image plane at a fixed angle.
 *
 * EVERY NUMBER HERE IS AN UNCALIBRATED DEFAULT. Replace them with the probe
 * manual or a bench measurement; `calibrated` stays false until someone does,
 * and the UI says so.
 */
export interface GuideSpec {
  /** Distance of the hole behind the array centre, along the array axis (mm). */
  holeOffsetMm: number;
  /** Height of the hole above the array face, along the beam axis (mm; negative = outside). */
  holeHeightMm: number;
  /** Angle between the guide line and the reference axis (degrees). */
  angleDeg: number;
  /**
   * Which axis angleDeg is measured from. The owner quoted "about 30 degrees";
   * it is not yet confirmed whether that is from the probe/array axis or from the beam.
   */
  angleReference: 'array-axis' | 'beam-axis';
}

export interface LusProbeSpec {
  model: string;
  calibrated: boolean;
  shaftDiameterMm: number;
  /** Straight insertable length from the trocar pivot to the flex joint (mm). */
  maxShaftLengthMm: number;
  /** Flexible segment from the joint to the array centre (mm). */
  tipLengthMm: number;
  /** Largest bend between shaft and array axis, any direction (degrees). */
  maxFlexDeg: number;
  /** Largest angle between the shaft and the inward skin normal at the trocar (degrees). */
  maxTrocarTiltDeg: number;
  arrayLengthMm: number;
  image: {
    nearDepthMm: number;
    farDepthMm: number;
    sliceThicknessMm: number;
  };
  guide: GuideSpec;
}

export const LUS_PROBE: LusProbeSpec = {
  model: 'Side-viewing linear LUS (generic, uncalibrated)',
  calibrated: false,
  shaftDiameterMm: 10,
  maxShaftLengthMm: 300,
  tipLengthMm: 25,
  maxFlexDeg: 90,
  maxTrocarTiltDeg: 60,
  arrayLengthMm: 30,
  image: {
    nearDepthMm: 0,
    farDepthMm: 80,
    sliceThicknessMm: 1.5
  },
  guide: {
    holeOffsetMm: 15, // proximal end of a 30 mm array
    holeHeightMm: 0,
    angleDeg: 30,
    angleReference: 'array-axis'
  }
};

export interface NeedleSpec {
  usableLengthMm: number;
  vesselClearanceMm: number;
  maxSkinTiltDeg: number;
}

/** Needle used for percutaneous entry (mm). Uncalibrated default. */
export const NEEDLE_SPEC: NeedleSpec = {
  usableLengthMm: 200,
  vesselClearanceMm: 5,
  /** Largest angle between the needle and the inward skin normal at the puncture (degrees). */
  maxSkinTiltDeg: 70
};
