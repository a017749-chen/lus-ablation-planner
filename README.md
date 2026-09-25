# LUS-Ablation 3D Planner
### 腹腔鏡超音波肝消融示意幾何模擬 (Illustrative Laparoscopic Ultrasound Ablation Geometry Simulation)

[![Three.js](https://img.shields.io/badge/Three.js-0.172.0-00d2ff?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-00ff66.svg)](LICENSE)

**LUS-Ablation 3D Planner** 是以 WebGL 呈現的示意性 3D 幾何與介面原型，用於展示肝臟病灶、器械姿態、超音波切面與消融區的空間關係。

解剖座標、器械入口、血管、超音波扇面與消融橢球都是示意性幾何，未經臨床校準或驗證。本原型不提供影像配準、病人解剖定位、組織變形、呼吸移動、針與組織互動、溫度場或熱劑量模型；不得用於手術導航、診斷、治療決策或安全判定。消融重疊只計算目標加外擴邊界球體與示意橢球的幾何重疊，不代表熱劑量、腫瘤控制率或血管安全。

---

## 🌟 示意模擬功能 (Simulation Features)

### 1. 示意性 3D 解剖與組織幾何 (Illustrative Anatomy)
- **腹壁穹頂與通道標記**：用合成座標繪出穹頂、套管與肋緣位置；未依病人影像或真實表面校準。
- **肝臟分段與病灶球體**：顯示 S2/S3、S4、S5/S6、S7/S8 的示意區域；病灶直徑與外擴邊界可調。
- **示意血管樹**：以圓柱段表示 IVC 與門靜脈主幹和分支，僅供幾何距離計算。

### 2. 器械運動學示意 (Fulcrum Kinematics)
- 套管通道採用固定示意支點；經皮入口採用固定虛擬座標，不代表病人解剖位置。進入腹腔的器械保留 4 個自由度：
  - 俯仰角 (Pitch, $\theta$)
  - 偏擺角 (Yaw, $\phi$)
  - 深入深度 (Insertion Depth, $d$)
  - 軸向自轉 (Roll, $\psi$)
- 支援 4 大標準套管通道佈局：
  1. **臍孔套管 (Umbilical Port, 10mm)**：光學腹腔鏡通道。
  2. **劍突下套管 (Subxiphoid Port, 5mm)**：輔助操作與拉鉤通道。
  3. **右肋下套管 (Right Subcostal Port, 12mm)**：LUS 探頭主操作通道。
  4. **肋間經胸套管 (Intercostal Transthoracic Trocar, ITT, 10mm)**：專門克服 S7/S8 橫膈頂部盲區之肋間直達路徑。

### 3. 計算幾何與共平面偵測引擎 (In-Plane Alignment Engine)
- 設超音波切面為平面 $P$（法向量 $\mathbf{n}$），穿刺針方向向量為 $\mathbf{v}_{\text{needle}}$，針尖與針尾至切面的正交距離分別為 $d_{\text{tip}}$ 與 $d_{\text{entry}}$：
  $$\text{Angle Condition: } |\mathbf{v}_{\text{needle}} \cdot \mathbf{n}| < \sin(2^\circ)$$
  $$\text{Distance Condition: } \max(d_{\text{tip}}, d_{\text{entry}}) < 1.0\text{ mm}$$
- **三態視覺與聲學反饋**：
  - `ALIGNED / IN-PLANE`（螢光綠）：針體全段高亮顯影，B-Mode 超音波呈現完整針身強回聲與**彗星尾偽影 (Comet-tail artifact)**。
  - `CROSS-PLANE`（警告黃）：針軸穿過超音波切面，B-Mode 僅呈現橫切面高回聲亮斑，伴隨**後方聲影 (Acoustic Shadowing)**。
  - `OUT-OF-PLANE`（警示紅）：針體完全脫離聲束切面，HUD 即時顯示偏離法向偏差毫米數（$\Delta\text{ mm}$）。

### 4. 幾何回正與有限掃描扇面 (Auto-Align)
- 回正只在固定入口、真實病灶球體與 10–105 mm、75° 示意掃描扇面可同時滿足時回報可行；針尖目標必須位於病灶內。
- 若入口偏離切面、病灶不與切面相交、病灶與有限扇面無交集，或器械角度／深度超出控制範圍，介面會顯示無可行解與幾何殘差。經皮入口不會被自動移動。
- B-mode 病灶輪廓按 1.5 mm 掃描薄層與球體交集縮放；超出掃描扇面的部分會被裁切。

### 5. 針身與示意血管間距 (Needle-Shaft Clearance)
- 計算 0.8 mm 半徑的示意針身外表面至 IVC / 門靜脈圓柱表面的幾何間距。
- 間距小於 5 mm 時顯示警示；此警示只評估針身線段，不評估消融區、熱效應或臨床血管安全。

### 6. 多視窗協同配置 (Multi-View Layout)
- **主視窗 (3D 全景 CAS)**：自由視角旋轉，提供 AP、Lateral、Axial、Surgeon 站位預設。
- **子視窗 1 (腹腔鏡視野 Laparoscopic Camera)**：位於臍孔套管的 $30^\circ$ 廣角視野，具備圓形暗角與瞄準刻度。
- **子視窗 2 (2D B-Mode 超音波視野)**：$7.5\text{ MHz}$ 示意凸陣扇面，病灶只顯示與 1.5 mm 掃描薄層相交的截面。畫面包含合成聲學斑點與簡化深度衰減，不是超音波設備輸出。

---

## 📐 數學模型架構

```
                    +---------------------------+
                    |  Trocar Fulcrum Pivot P0  |
                    +-------------+-------------+
                                  | 4-DOF Kinematics
                                  v
              +---------------------------------------+
              | Needle Segment S = [P_entry, P_tip]   |
              +-------------------+-------------------+
                                  |
            +---------------------+---------------------+
            |                                           |
            v                                           v
+-----------------------+                   +-----------------------+
|  In-Plane Alignment   |                   |  Needle-shaft Clearance |
|  |v . n| < sin(2°)    |                   |  Surface gap < 5mm      |
|  max(d_tip, d_entry)  |                   +-----------+-----------+
|         < 1.0mm       |                               |
+-----------+-----------+                               v
            |                               +-----------------------+
            v                               | Collision Alert Flash |
+-----------------------+                   +-----------------------+
| 3-State Telemetry HUD |
| (Green / Yellow / Red)|
+-----------------------+
```

---

## 🚀 快速上手 (Quick Start)

### 依賴環境
- Node.js >= 18.0.0
- npm >= 9.0.0

### 安裝與啟動
```bash
# 1. 複製專案
git clone https://github.com/a017749-chen/lus-ablation-planner.git
cd lus-ablation-planner

# 2. 安裝相依套件
npm install

# 3. 啟動本機開發伺服器
npm run dev

# 4. 執行計算幾何與運動學單元測試
npm test

# 5. 生產環境構建
npm run build
```

---

## 🛠 技術棧 (Tech Stack)

- **核心渲染**：[Three.js (WebGL)](https://threejs.org/)
- **建構工具**：[Vite](https://vitejs.dev/)
- **程式語言**：[TypeScript](https://www.typescriptlang.org/)
- **UI 樣式**：[Tailwind CSS](https://tailwindcss.com/)
- **字型與圖標**：JetBrains Mono, Inter, Inline SVG Icons

---

## 📄 License
This project is licensed under the MIT License.
