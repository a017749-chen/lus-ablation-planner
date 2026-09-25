import * as THREE from 'three';
import { AlignmentResult } from '../math/alignmentEngine';

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
    probePlane: { origin: THREE.Vector3; normal: THREE.Vector3; xAxis: THREE.Vector3; yAxis: THREE.Vector3 },
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

    // Convex sector geometry in 2D canvas coordinates
    const apexX = w * 0.5;
    const apexY = 12;
    const startRadius = 22;
    const maxRadius = h - 18;
    const sectorAngle = THREE.MathUtils.degToRad(75);
    const halfAngle = sectorAngle * 0.5;
    const startAngle = Math.PI * 0.5 - halfAngle;
    const endAngle = Math.PI * 0.5 + halfAngle;

    // 1. Clip to sector path
    ctx.save();
    ctx.beginPath();
    ctx.arc(apexX, apexY, maxRadius, startAngle, endAngle, false);
    ctx.arc(apexX, apexY, startRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.clip();

    // 2. Draw Liver Parenchyma base texture with depth attenuation (TGC)
    const tgcGrad = ctx.createRadialGradient(apexX, apexY, startRadius, apexX, apexY, maxRadius);
    tgcGrad.addColorStop(0.0, 'rgba(55, 65, 60, 0.95)');
    tgcGrad.addColorStop(0.5, 'rgba(38, 48, 44, 0.9)');
    tgcGrad.addColorStop(1.0, 'rgba(15, 20, 18, 0.85)');
    ctx.fillStyle = tgcGrad;
    ctx.fillRect(0, 0, w, h);

    // Dynamic acoustic speckle blend
    ctx.globalAlpha = 0.35;
    ctx.drawImage(this.speckleCanvas, 0, 0, w, h);
    ctx.globalAlpha = 1.0;

    // 3. Project Tumor onto 2D Ultrasound Sector
    // Vector from probe origin to tumor
    const relTumor = new THREE.Vector3().subVectors(tumorPos, probePlane.origin);
    const normalOffset = relTumor.dot(probePlane.normal); // Out-of-plane distance
    const tumorDistToPlane = Math.abs(normalOffset);

    const lateralOffset = relTumor.dot(probePlane.xAxis); // Lateral mm
    const depthOffset = relTumor.dot(probePlane.yAxis);   // Axial depth mm

    // If tumor is within the acoustic beam slice (~15mm visibility elevation window)
    if (tumorDistToPlane < 15.0 && depthOffset > 0 && depthOffset < 110) {
      // Map depth mm to canvas pixels (100mm = maxRadius - startRadius)
      const scale = (maxRadius - startRadius) / 100.0;
      const tumorCanvasY = apexY + startRadius + depthOffset * scale;
      const tumorCanvasX = apexX + lateralOffset * scale;
      const tumorPixelRadius = (tumorDia * 0.5) * scale;
      const marginPixelRadius = (tumorDia * 0.5 + safetyMargin) * scale;

      // Blur factor if slightly out of slice plane
      const sliceBlur = Math.min(1.0, tumorDistToPlane / 12.0);
      const tumorOpacity = (1.0 - sliceBlur * 0.7);

      // 3a. Safety Margin ring (dotted)
      ctx.beginPath();
      ctx.arc(tumorCanvasX, tumorCanvasY, marginPixelRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 184, 0, ${0.7 * tumorOpacity})`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // 3b. Tumor Hypoechoic Body (darker lesion core)
      const tumorGrad = ctx.createRadialGradient(
        tumorCanvasX, tumorCanvasY, 0,
        tumorCanvasX, tumorCanvasY, tumorPixelRadius
      );
      tumorGrad.addColorStop(0.0, `rgba(12, 16, 15, ${0.9 * tumorOpacity})`);
      tumorGrad.addColorStop(0.85, `rgba(18, 24, 22, ${0.85 * tumorOpacity})`);
      tumorGrad.addColorStop(1.0, `rgba(160, 185, 175, ${0.95 * tumorOpacity})`); // Hyperechoic capsule rim

      ctx.beginPath();
      ctx.arc(tumorCanvasX, tumorCanvasY, tumorPixelRadius, 0, Math.PI * 2);
      ctx.fillStyle = tumorGrad;
      ctx.fill();
      ctx.strokeStyle = `rgba(180, 205, 195, ${0.9 * tumorOpacity})`;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Posterior acoustic enhancement behind fluid/cellular tumor
      ctx.beginPath();
      ctx.moveTo(tumorCanvasX - tumorPixelRadius * 0.7, tumorCanvasY + tumorPixelRadius);
      ctx.lineTo(tumorCanvasX + tumorPixelRadius * 0.7, tumorCanvasY + tumorPixelRadius);
      ctx.lineTo(tumorCanvasX + tumorPixelRadius * 1.1, maxRadius);
      ctx.lineTo(tumorCanvasX - tumorPixelRadius * 1.1, maxRadius);
      ctx.closePath();
      const enhanceGrad = ctx.createLinearGradient(tumorCanvasX, tumorCanvasY, tumorCanvasX, maxRadius);
      enhanceGrad.addColorStop(0.0, `rgba(255, 255, 255, ${0.15 * tumorOpacity})`);
      enhanceGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = enhanceGrad;
      ctx.fill();
    }

    // 4. Render Needle Reflection according to In-Plane Alignment Status
    const scale = (maxRadius - startRadius) / 100.0;

    if (alignment.status === 'IN_PLANE') {
      // FULL IN-PLANE HYPERECHOIC NEEDLE TRACT
      const relEntry = new THREE.Vector3().subVectors(needleEntry, probePlane.origin);
      const relTip = new THREE.Vector3().subVectors(needleTip, probePlane.origin);

      const entryX = apexX + relEntry.dot(probePlane.xAxis) * scale;
      const entryY = apexY + startRadius + relEntry.dot(probePlane.yAxis) * scale;
      const tipX = apexX + relTip.dot(probePlane.xAxis) * scale;
      const tipY = apexY + startRadius + relTip.dot(probePlane.yAxis) * scale;

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
      const dotY = apexY + startRadius + relIntersect.dot(probePlane.yAxis) * scale;

      // Posterior acoustic shadow extending down to sector base
      ctx.beginPath();
      ctx.moveTo(dotX - 2.5, dotY);
      ctx.lineTo(dotX + 2.5, dotY);
      ctx.lineTo(dotX + 5, maxRadius);
      ctx.lineTo(dotX - 5, maxRadius);
      ctx.closePath();
      const shadowGrad = ctx.createLinearGradient(dotX, dotY, dotX, maxRadius);
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

    // 5. Virtual Needle Guide Trajectory Overlay (Dashed Line)
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(apexX, apexY + startRadius);
    ctx.lineTo(apexX, maxRadius);
    ctx.strokeStyle = alignment.status === 'IN_PLANE' ? 'rgba(0, 255, 102, 0.5)' : 'rgba(0, 210, 255, 0.35)';
    ctx.lineWidth = 1.0;
    ctx.stroke();
    ctx.setLineDash([]);

    // Restore clip
    ctx.restore();

    // 6. Ultrasound Sector Border & Caliper Depth Graticule
    ctx.beginPath();
    ctx.arc(apexX, apexY, maxRadius, startAngle, endAngle, false);
    ctx.arc(apexX, apexY, startRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Depth scale ticks along right edge
    ctx.fillStyle = 'rgba(150, 180, 200, 0.75)';
    ctx.font = '8px "JetBrains Mono", monospace';
    for (let cm = 2; cm <= 10; cm += 2) {
      const tickDepth = apexY + startRadius + (cm * 10) * scale;
      ctx.fillRect(w - 14, tickDepth, 8, 1);
      ctx.fillText(`${cm}`, w - 24, tickDepth + 3);
    }
  }
}
