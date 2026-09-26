import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TROCAR_PRESETS } from '../config/presets';
import { ANTERIOR_VIEW } from '../math/patientCoordinates';

export interface ViewportManager {
  mainCamera: THREE.PerspectiveCamera;
  lapCamera: THREE.PerspectiveCamera;
  orbitControls: OrbitControls;
  mainRenderer: THREE.WebGLRenderer;
  lapRenderer: THREE.WebGLRenderer;
  setCameraPreset(preset: 'ap' | 'lateral' | 'superior' | 'surgeon' | 'reset'): void;
  render(scene: THREE.Scene): void;
  handleResize(): void;
}

export class MultiViewport {
  public static init(
    mainContainer: HTMLElement,
    lapContainer: HTMLElement
  ): ViewportManager {
    // 1. Main Viewport 3D Canvas
    const mainWidth = mainContainer.clientWidth;
    const mainHeight = mainContainer.clientHeight;

    const mainRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    mainRenderer.setSize(mainWidth, mainHeight);
    mainRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mainRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    mainRenderer.toneMappingExposure = 1.1;
    mainContainer.appendChild(mainRenderer.domElement);

    const mainCamera = new THREE.PerspectiveCamera(45, mainWidth / mainHeight, 1, 1500);
    mainCamera.position.set(0, -180, 240); // Initial surgeon angle

    const orbitControls = new OrbitControls(mainCamera, mainRenderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;
    orbitControls.target.set(10, 10, 10);
    orbitControls.maxDistance = 800;
    orbitControls.minDistance = 30;

    // 2. Laparoscopic Viewport Subview (Simulated 30° Rigid Laparoscope)
    const lapWidth = lapContainer.clientWidth || 320;
    const lapHeight = lapContainer.clientHeight || 208;

    const lapRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    lapRenderer.setSize(lapWidth, lapHeight);
    lapRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    lapRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    lapRenderer.toneMappingExposure = 1.25;
    lapContainer.appendChild(lapRenderer.domElement);

    // Laparoscopic camera placed at Umbilical Trocar
    const lapCamera = new THREE.PerspectiveCamera(70, lapWidth / lapHeight, 1, 600); // 70° wide-angle laparoscope
    const umbilical = TROCAR_PRESETS['umbilical'];
    lapCamera.position.copy(umbilical.pivotPosition).add(new THREE.Vector3(0, 5, -5));
    lapCamera.up.set(0, 0, 1); // Anterior abdominal wall (+Z) oriented towards screen top
    lapCamera.lookAt(new THREE.Vector3(15, 20, 0)); // Center of liver

    // Camera Presets
    const setCameraPreset = (preset: 'ap' | 'lateral' | 'superior' | 'surgeon' | 'reset') => {
      const target = new THREE.Vector3(10, 10, 10);
      orbitControls.target.copy(target);

      switch (preset) {
        case 'ap': // Anteroposterior (Frontal view)
          mainCamera.position.set(...ANTERIOR_VIEW.position);
          mainCamera.up.set(...ANTERIOR_VIEW.up);
          orbitControls.target.set(...ANTERIOR_VIEW.target);
          break;
        case 'lateral': // Right Lateral (Sagittal view)
          mainCamera.position.set(-340, 10, 10);
          mainCamera.up.set(0, 1, 0);
          break;
        case 'superior': // Superior Axial (Top-down view)
          mainCamera.position.set(10, 340, 10);
          mainCamera.up.set(0, 0, -1);
          break;
        case 'surgeon': // Surgeon Standing at Patient's Right-Inferior
          mainCamera.position.set(-90, -190, 210);
          mainCamera.up.set(0, 1, 0);
          break;
        case 'reset':
        default:
          mainCamera.position.set(0, -180, 240);
          mainCamera.up.set(0, 1, 0);
          break;
      }
      orbitControls.update();
    };

    const handleResize = () => {
      const wMain = mainContainer.clientWidth;
      const hMain = mainContainer.clientHeight;
      mainCamera.aspect = wMain / hMain;
      mainCamera.updateProjectionMatrix();
      mainRenderer.setSize(wMain, hMain);

      const wLap = lapContainer.clientWidth || 320;
      const hLap = lapContainer.clientHeight || 208;
      lapCamera.aspect = wLap / hLap;
      lapCamera.updateProjectionMatrix();
      lapRenderer.setSize(wLap, hLap);
    };

    window.addEventListener('resize', handleResize);

    const render = (scene: THREE.Scene) => {
      orbitControls.update();
      const facePatientSideLabels = (camera: THREE.Camera) => {
        scene.traverse((object) => {
          if (object.userData.isPatientSideBillboard) object.quaternion.copy(camera.quaternion);
        });
      };
      facePatientSideLabels(mainCamera);
      mainRenderer.render(scene, mainCamera);

      // Keep laparoscope camera aiming at liver field from umbilical port
      lapCamera.position.copy(umbilical.pivotPosition).add(new THREE.Vector3(0, 8, -8));
      lapCamera.up.set(0, 0, 1);
      lapCamera.lookAt(new THREE.Vector3(15, 20, 0));
      facePatientSideLabels(lapCamera);
      lapRenderer.render(scene, lapCamera);
    };

    return {
      mainCamera,
      lapCamera,
      orbitControls,
      mainRenderer,
      lapRenderer,
      setCameraPreset,
      render,
      handleResize
    };
  }
}
