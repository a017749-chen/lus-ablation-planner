import * as THREE from 'three';

export const PROBE_PORT_IDS = ['subcostal', 'subxiphoid', 'itt'] as const;
export type ProbePortId = (typeof PROBE_PORT_IDS)[number];

export function isProbePort(value: string): value is ProbePortId {
  return (PROBE_PORT_IDS as readonly string[]).includes(value);
}

export interface LesionPreset {
  id: string;
  name: string;
  segmentName: string;
  description: string;
  tumorPosition: THREE.Vector3;
  tumorDiameter: number; // mm
  safetyMargin: number; // mm
  suggestedProbePort: ProbePortId;
  suggestedNeedlePort: 'subcostal' | 'subxiphoid' | 'itt' | 'percutaneous';
  requiresITT: boolean;
  probeInitialConfig: {
    depth: number;
    pitch: number;
    yaw: number;
    roll: number;
  };
  needleInitialConfig: {
    depth: number;
    pitch: number;
    yaw: number;
    percutaneousEntry?: THREE.Vector3;
  };
}

export interface TrocarDefinition {
  id: string;
  name: string;
  type: 'umbilical' | 'subxiphoid' | 'subcostal' | 'itt';
  diameter: number; // 5mm, 10mm, 12mm
  pivotPosition: THREE.Vector3; // Position on abdominal wall (fulcrum point)
  defaultDirection: THREE.Vector3;
  description: string;
  isActive: boolean;
  color: number;
}

export const TROCAR_PRESETS: Record<string, TrocarDefinition> = {
  umbilical: {
    id: 'umbilical',
    name: '臍孔套管 (Umbilical Port)',
    type: 'umbilical',
    diameter: 10,
    pivotPosition: new THREE.Vector3(0, -90, 85),
    defaultDirection: new THREE.Vector3(0, 0.7, -0.7).normalize(),
    description: '10mm 光學腹腔鏡鏡頭通道，提供術野直視全景。',
    isActive: true,
    color: 0x00d2ff
  },
  subxiphoid: {
    id: 'subxiphoid',
    name: '劍突下套管 (Subxiphoid Port)',
    type: 'subxiphoid',
    diameter: 5,
    pivotPosition: new THREE.Vector3(15, 80, 80),
    defaultDirection: new THREE.Vector3(-0.2, -0.6, -0.75).normalize(),
    description: '5mm 輔助拉鉤或穿刺引導通道。',
    isActive: true,
    color: 0x9d4edd
  },
  subcostal: {
    id: 'subcostal',
    name: '右肋下套管 (Right Subcostal Port)',
    type: 'subcostal',
    diameter: 12,
    pivotPosition: new THREE.Vector3(-75, -20, 68),
    defaultDirection: new THREE.Vector3(0.5, 0.4, -0.75).normalize(),
    description: '12mm 腹腔鏡超音波 (LUS) 探頭主操作通道。',
    isActive: true,
    color: 0x00ff66
  },
  itt: {
    id: 'itt',
    name: '肋間經胸套管 (Intercostal Transthoracic Trocar, ITT)',
    type: 'itt',
    diameter: 10,
    pivotPosition: new THREE.Vector3(-105, 55, 20),
    defaultDirection: new THREE.Vector3(0.7, -0.3, -0.65).normalize(),
    description: '專為 S7/S8 橫膈圓頂盲區設計之經肋間徑路，穿過膈肌直達肝頂。',
    isActive: false, // Activated dynamically for S7/S8
    color: 0xffb800
  }
};

export const LESION_PRESETS: Record<string, LesionPreset> = {
  S5_S6: {
    id: 'S5_S6',
    name: 'S5/S6 典型右葉前下病灶',
    segmentName: 'Couinaud Segment V/VI',
    description: '右肝前下段實質深部腫瘤，鄰近門靜脈右前支，標準右肋下超音波探查視角。',
    tumorPosition: new THREE.Vector3(-32, -22, 0),
    tumorDiameter: 20, // 2.0 cm
    safetyMargin: 5.0, // +0.5 cm
    suggestedProbePort: 'subcostal',
    suggestedNeedlePort: 'percutaneous',
    requiresITT: false,
    probeInitialConfig: {
      depth: 120,
      pitch: 28,
      yaw: 12,
      roll: 0
    },
    needleInitialConfig: {
      depth: 85,
      pitch: 42,
      yaw: -15
    }
  },
  S2_S3: {
    id: 'S2_S3',
    name: 'S2/S3 左外側葉病灶',
    segmentName: 'Couinaud Segment II/III',
    description: '左葉外側段腫瘤，質地較薄且移動度大，常規自劍突下入路或右肋下偏角探查。',
    tumorPosition: new THREE.Vector3(42, 10, 12),
    tumorDiameter: 22,
    safetyMargin: 5.0,
    suggestedProbePort: 'subxiphoid',
    suggestedNeedlePort: 'subxiphoid',
    requiresITT: false,
    probeInitialConfig: {
      depth: 110,
      pitch: -15,
      yaw: -30,
      roll: 20
    },
    needleInitialConfig: {
      depth: 80,
      pitch: 10,
      yaw: 25
    }
  },
  S7_S8: {
    id: 'S7_S8',
    name: 'S7/S8 橫膈圓頂部盲區病灶',
    segmentName: 'Couinaud Segment VII/VIII (Dome)',
    description: '位於橫膈頂部後上方，受肋骨遮蔽且常規腹腔鏡入路進針角度過銳，強烈建議啟用肋間經胸套管 (ITT)。',
    tumorPosition: new THREE.Vector3(-42, 60, -25),
    tumorDiameter: 24,
    safetyMargin: 6.0,
    suggestedProbePort: 'subcostal',
    suggestedNeedlePort: 'itt',
    requiresITT: true,
    probeInitialConfig: {
      depth: 145,
      pitch: 52,
      yaw: -10,
      roll: -15
    },
    needleInitialConfig: {
      depth: 92,
      pitch: 20,
      yaw: 35
    }
  }
};

/** Resolve the separate probe and needle ports selected by a lesion preset. */
export interface PortSelectionState {
  probePort: ProbePortId;
  needlePort: LesionPreset['suggestedNeedlePort'];
  needleMode: 'trocar' | 'percutaneous';
}

export function getSuggestedPortSelection(preset: LesionPreset): PortSelectionState {
  return {
    probePort: preset.suggestedProbePort,
    needlePort: preset.suggestedNeedlePort,
    needleMode: preset.suggestedNeedlePort === 'percutaneous' ? 'percutaneous' : 'trocar'
  };
}

/** Change the probe port while preserving the independently selected needle entry. */
export function selectProbePort(
  selection: PortSelectionState,
  probePort: ProbePortId
): PortSelectionState {
  return { ...selection, probePort };
}

/** Change the needle entry while preserving the independently selected probe port. */
export function selectNeedleEntry(
  selection: PortSelectionState,
  needlePort: PortSelectionState['needlePort']
): PortSelectionState {
  return {
    ...selection,
    needlePort,
    needleMode: needlePort === 'percutaneous' ? 'percutaneous' : 'trocar'
  };
}
