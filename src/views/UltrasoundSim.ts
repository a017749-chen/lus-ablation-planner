import * as THREE from 'three';
import { FulcrumKinematics } from '../math/kinematics';
import { AlignmentResult } from '../math/alignmentEngine';
import { closestPointInUltrasoundSector, getSphereSlabIntersection } from '../math/ultrasoundGeometry';
import { ProbeUSPlaneData } from '../scene/Instruments';
import { LUS_PROBE } from '../config/probe';
import { guideDirection2D } from '../math/sideViewProbe';

export interface UltrasoundSimParams {
  canvas: HTMLCanvasElement;
  tumorPosition: THREE.Vector3;
  tumorDiameter: number;
  safetyMargin: number;
}

export class UltrasoundSim {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private speckleCanvas: HTMLCanvasElement;
  private speckleCtx: CanvasRenderingContext2D;
  private time: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot get 2D context from US canvas');
    this.ctx = context;

    // Off-screen canvas for dynamic acoustic speckle texture
    this.speckleCanvas = document.createElement('canvas');
    this.speckleCanvas.width = 160;
    this.speckleCanvas.height = 120;
    const sCtx = this.speckleCanvas.getContext('2d');
    if (!sCtx) throw new Error('Cannot get 2D context from speckle canvas');
    this.speckleCtx = sCtx;
    this.generateSpecklePattern();
  }

  /**
   * Pre-generate ultrasound Rayleigh acoustic speckle noise
   */
  private generateSpecklePattern() {
    const w = this.speckleCanvas.width;
    const h = this.speckleCanvas.height;
    const imgData = this.speckleCtx.createImageData(w, h);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      // Rayleigh-like noise distribution
      const u1 = Math.random();
      const u2 = Math.random();
      const val = Math.floor(Math.sqrt(-2.0 * Math.log(Math.max(0.0001, u1))) * Math.cos(2.0 * Math.PI * u2) * 22 + 45);
      const intensity = Math.min(255, Math.max(0, val));
      data[i] = intensity;     // R
      data[i + 1] = intensity; // G
      data[i + 2] = intensity; // B
      data[i + 3] = 255;       // A
    }
    this.speckleCtx.putImageData(imgData, 0, 0);
  }

  /**
   * Render real-time 2D B-Mode ultrasound frame
   */
  public render(
    alignment: AlignmentResult,
    tumorPos: THREE.Vector3,
    tumorDia: number,
    safetyMargin: number,
    probePlane: ProbeUSPlaneData,
    needleEntry: THREE.Vector3,
    needleTip: THREE.Vector3
  ) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.time += 0.03;

    // Clear background to deep acoustic black
    ctx.fillStyle = '#020408';
    ctx.fillRect(0, 0, w, h);

    // Linear-array image: a rectangle, array face along the top edge.
    // apexX/apexY mark the array centre; lateral and depth share one scale.
    const depthSpan = probePlane.farDepthMm;
    const scale = Math.min((h - 24) / depthSpan, (w - 48) / (probePlane.halfWidthMm * 2));
    const apexX = w * 0.5;
    const apexY = 12;
    const startRadius = probePlane.nearDepthMm * scale;
    const maxRadius = probePlane.farDepthMm * scale;
    const halfWidthPx = probePlane.halfWidthMm * scale;
    const imageRect = () => ctx.rect(apexX - halfWidthPx, apexY + startRadius, halfWidthPx * 2, maxRadius - startRadius);

    // 1. Clip to the image rectangle
    ctx.save();
    ctx.beginPath();
    imageRect();
    ctx.clip();

    // 2. Liver parenchyma base texture with depth attenuation (TGC)
    const tgcGrad = ctx.createLinearGradient(0, apexY + startRadius, 0, apexY + maxRadius);
    tgcGrad.addColorStop(0.0, 'rgba(55, 65, 60, 0.95)');
    tgcGrad.addColorStop(0.5, 'rgba(38, 48, 44, 0.9)');
    tgcGrad.addColorStop(1.0, 'rgba(15, 20, 18, 0.85)');
    ctx.fillStyle = tgcGrad;
    ctx.fillRect(0, 0, w, h);

    // Dynamic acoustic speckle blend
    ctx.globalAlpha = 0.35;
    ctx.drawImage(this.speckleCanvas, 0, 0, w, h);
    ctx.globalAlpha = 1.0;

    // 3. Draw only the actual sphere intersection with the 1.5mm scan slab.
    const relTumor = new THREE.Vector3().subVectors(tumorPos, probePlane.origin);
    const normalOffset = relTumor.dot(probePlane.normal);
    const lateralOffset = relTumor.dot(probePlane.xAxis);
    const depthOffset = relTumor.dot(probePlane.yAxis);
    const tumorRadiusMm = tumorDia * 0.5;
    const tumorSlice = getSphereSlabIntersection(
      tumorRadiusMm,
      normalOffset,
      probePlane.sliceThicknessMm
    );
    const tumorFanDistance = closestPointInUltrasoundSector(
      lateralOffset,
      depthOffset,
      probePlane
    ).distanceMm;

    const marginSlice = getSphereSlabIntersection(
      tumorRadiusMm + safetyMargin,
      normalOffset,
      probePlane.sliceThicknessMm
    );
    const marginFanDistance = closestPointInUltrasoundSector(
      lateralOffset,
      depthOffset,
      probePlane
    ).distanceMm;
    const tumorCanvasX = apexX + lateralOffset * scale;
    const tumorCanvasY = apexY + depthOffset * scale;

    if (marginSlice.visible && marginFanDistance <= marginSlice.crossSectionRadiusMm) {
      const marginPixelRadius = marginSlice.crossSectionRadiusMm * scale;
      ctx.beginPath();
      ctx.arc(tumorCanvasX, tumorCanvasY, marginPixelRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (tumorSlice.visible && tumorFanDistance <= tumorSlice.crossSectionRadiusMm) {
      const tumorPixelRadius = tumorSlice.crossSectionRadiusMm * scale;
      const tumorOpacity = Math.max(
        0.4,
        1.0 - tumorSlice.effectiveOffsetMm / Math.max(1, tumorRadiusMm) * 0.5
      );

      // Hypoechoic lesion body uses the sphere/slab cross-section radius.
      const tumorGrad = ctx.createRadialGradient(
        tumorCanvasX, tumorCanvasY, 0,
        tumorCanvasX, tumorCanvasY, tumorPixelRadius
      );
      tumorGrad.addColorStop(0.0, `rgba(12, 16, 15, ${0.9 * tumorOpacity})`);
      tumorGrad.addColorStop(0.85, `rgba(18, 24, 22, ${0.85 * tumorOpacity})`);
      tumorGrad.addColorStop(1.0, `rgba(160, 185, 175, ${0.95 * tumorOpacity})`);

      ctx.beginPath();
      ctx.arc(tumorCanvasX, tumorCanvasY, tumorPixelRadius, 0, Math.PI * 2);
      ctx.fillStyle = tumorGrad;
      ctx.fill();
      ctx.strokeStyle = `rgba(180, 205, 195, ${0.9 * tumorOpacity})`;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Posterior enhancement is clipped to the ultrasound sector above.
      ctx.beginPath();
      ctx.moveTo(tumorCanvasX - tumorPixelRadius * 0.7, tumorCanvasY + tumorPixelRadius);
      ctx.lineTo(tumorCanvasX + tumorPixelRadius * 0.7, tumorCanvasY + tumorPixelRadius);
      ctx.lineTo(tumorCanvasX + tumorPixelRadius * 1.1, apexY + maxRadius);
      ctx.lineTo(tumorCanvasX - tumorPixelRadius * 1.1, apexY + maxRadius);
      ctx.closePath();
      const enhanceGrad = ctx.createLinearGradient(tumorCanvasX, tumorCanvasY, tumorCanvasX, apexY + maxRadius);
      enhanceGrad.addColorStop(0.0, `rgba(255, 255, 255, ${0.15 * tumorOpacity})`);
      enhanceGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = enhanceGrad;
      ctx.fill();
    }

    // 4. Render Needle Reflection according to In-Plane Alignment Status

    if (alignment.status === 'IN_PLANE') {
      // FULL IN-PLANE HYPERECHOIC NEEDLE TRACT
      const relEntry = new THREE.Vector3().subVectors(needleEntry, probePlane.origin);
      const relTip = new THREE.Vector3().subVectors(needleTip, probePlane.origin);

      const entryX = apexX + relEntry.dot(probePlane.xAxis) * scale;
      const entryY = apexY + relEntry.dot(probePlane.yAxis) * scale;
      const tipX = apexX + relTip.dot(probePlane.xAxis) * scale;
      const tipY = apexY + relTip.dot(probePlane.yAxis) * scale;

      // Glowing needle tract
      ctx.beginPath();
      ctx.moveTo(entryX, entryY);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = 'rgba(0, 255, 102, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#00ff66';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0; // reset

      // Center bright specular reflection
      ctx.beginPath();
      ctx.moveTo(entryX, entryY);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.0;
      ctx.stroke();

      // Sharp Echogenic Needle Tip Marker
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00ff66';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Target engagement ring when needle tip is inside tumor
      const tipToCenterDist = needleTip.distanceTo(tumorPos);
      if (tipToCenterDist <= tumorRadiusMm) {
        ctx.beginPath();
        ctx.arc(tipX, tipY, 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#00ff66';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Comet-tail reverberation artifact extending below needle tip
      ctx.beginPath();
      ctx.moveTo(tipX - 1.5, tipY + 2);
      ctx.lineTo(tipX + 1.5, tipY + 2);
      ctx.lineTo(tipX + 4, tipY + 28);
      ctx.lineTo(tipX - 4, tipY + 28);
      ctx.closePath();
      const cometGrad = ctx.createLinearGradient(tipX, tipY, tipX, tipY + 28);
      cometGrad.addColorStop(0.0, 'rgba(0, 255, 102, 0.45)');
      cometGrad.addColorStop(1.0, 'rgba(0, 255, 102, 0.0)');
      ctx.fillStyle = cometGrad;
      ctx.fill();

    } else if (alignment.status === 'CROSS_PLANE' && alignment.intersectionWithPlane) {
      // CROSS-PLANE INTERSECTION: SINGLE BRIGHT HYPERECHOIC DOT + ACOUSTIC SHADOW
      const relIntersect = new THREE.Vector3().subVectors(alignment.intersectionWithPlane, probePlane.origin);
      const dotX = apexX + relIntersect.dot(probePlane.xAxis) * scale;
      const dotY = apexY + relIntersect.dot(probePlane.yAxis) * scale;

      // Posterior acoustic shadow extending down to sector base
      ctx.beginPath();
      ctx.moveTo(dotX - 2.5, dotY);
      ctx.lineTo(dotX + 2.5, dotY);
      ctx.lineTo(dotX + 5, apexY + maxRadius);
      ctx.lineTo(dotX - 5, apexY + maxRadius);
      ctx.closePath();
      const shadowGrad = ctx.createLinearGradient(dotX, dotY, dotX, apexY + maxRadius);
      shadowGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.85)');
      shadowGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.4)');
      ctx.fillStyle = shadowGrad;
      ctx.fill();

      // Bright hyperechoic dot
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffb800';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();

    } else {
      // OUT-OF-PLANE: No needle echo visible on the B-mode ultrasound slice!
    }

    // 5. Needle-guide line: from the guide hole at its fixed angle, as the scanner draws it.
    const { du, dv } = guideDirection2D(LUS_PROBE);
    const hole = { u: -LUS_PROBE.guide.holeOffsetMm, v: -LUS_PROBE.guide.holeHeightMm };
    const guideT = (probePlane.farDepthMm - hole.v) / dv;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(apexX + hole.u * scale, apexY + hole.v * scale);
    ctx.lineTo(apexX + (hole.u + du * guideT) * scale, apexY + (hole.v + dv * guideT) * scale);
    ctx.strokeStyle = alignment.status === 'IN_PLANE' ? 'rgba(0, 255, 102, 0.6)' : 'rgba(255, 212, 0, 0.55)';
    ctx.lineWidth = 1.0;
    ctx.stroke();
    ctx.setLineDash([]);

    // Restore clip
    ctx.restore();

    // 6. Image border and array face
    ctx.beginPath();
    imageRect();
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 210, 255, 0.8)';
    ctx.fillRect(apexX - halfWidthPx, apexY - 3, halfWidthPx * 2, 3);

    // Depth scale ticks along right edge
    ctx.fillStyle = 'rgba(150, 180, 200, 0.75)';
    ctx.font = '8px "JetBrains Mono", monospace';
    for (let cm = 1; cm * 10 <= probePlane.farDepthMm; cm += 1) {
      const tickDepth = apexY + (cm * 10) * scale;
      ctx.fillRect(w - 14, tickDepth, 8, 1);
      ctx.fillText(`${cm}`, w - 24, tickDepth + 3);
    }

    // 7. Ultrasound Real-Time Puncture HUD Telemetry
    const targetVec = new THREE.Vector3().subVectors(tumorPos, needleEntry);
    const needleVec = new THREE.Vector3().subVectors(needleTip, needleEntry);
    const targetDistance = targetVec.length();
    const currentDepth = needleVec.length();
    const targetUnit = targetDistance > 0.001 ? targetVec.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const currentProjection = needleVec.dot(targetUnit);
    const signedDistanceToCenter = targetDistance - currentProjection;
    const tipToCenterDist = needleTip.distanceTo(tumorPos);

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(6, 10, 16, 0.78)';
    ctx.fillRect(8, h - 34, w - 16, 26);
    ctx.strokeStyle = 'rgba(28, 44, 66, 0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(8, h - 34, w - 16, 26);

    ctx.fillStyle = '#00ffaa';
    ctx.fillText(`DEPTH: ${currentDepth.toFixed(1)}mm`, 14, h - 21);

    let statusText = '';
    let statusColor = '#00d2ff';
    if (FulcrumKinematics.isPointWithinSphere(needleTip, tumorPos, tumorRadiusMm)) {
      statusText = 'TARGET ENGAGED (腫瘤範圍內)';
      statusColor = '#00ff66';
    } else if (signedDistanceToCenter < -tumorRadiusMm) {
      statusText = `PAST TARGET PLANE (3D error: ${tipToCenterDist.toFixed(1)}mm)`;
      statusColor = '#ff3b30';
    } else if (tipToCenterDist <= (tumorRadiusMm + safetyMargin)) {
      statusText = `IN MARGIN (${(tipToCenterDist - tumorRadiusMm).toFixed(1)}mm to tumor edge)`;
      statusColor = '#ffb800';
    } else {
      statusText = `TO TARGET: ${tipToCenterDist.toFixed(1)}mm 3D error`;
      statusColor = '#00d2ff';
    }

    ctx.fillStyle = statusColor;
    ctx.fillText(statusText, 14, h - 11);

    ctx.textAlign = 'right';
    if (alignment.status === 'IN_PLANE') {
      ctx.fillStyle = '#00ff66';
      ctx.fillText('IN-PLANE ALIGNED', w - 14, h - 16);
    } else if (alignment.status === 'CROSS_PLANE') {
      ctx.fillStyle = '#ffb800';
      ctx.fillText('CROSS-PLANE DOT', w - 14, h - 16);
    } else {
      ctx.fillStyle = '#ff3b30';
      ctx.fillText('OUT-OF-PLANE', w - 14, h - 16);
    }
    ctx.textAlign = 'left';
  }
}
