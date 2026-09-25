# LUS-Ablation 3D Planner
### 腹腔鏡超音波肝消融示意幾何模擬 (Illustrative Laparoscopic Ultrasound Ablation Geometry Simulation)

[![Three.js](https://img.shields.io/badge/Three.js-0.172.0-00d2ff?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-00ff66.svg)](LICENSE)

**LUS-Ablation 3D Planner** 是以 WebGL 呈現的示意性 3D 幾何與介面原型，用於展示肝臟病灶、器械姿態、超音波切面與消融區的空間關係。

目前的解剖、器械、血管、超音波與消融模型皆為示意性幾何，未經臨床驗證；不可用於手術導航、診斷或治療決策。消融「重疊估計」只計算目標加安全邊界球體與畫面橢球的幾何重疊，不代表溫度場、熱劑量或腫瘤控制率。

---

## 🌟 示意模擬功能 (Simulation Features)

### 1. 擬真 3D 解剖與關鍵組織柱 (Anatomical Modeling)
- **腹壁充氣穹頂 (Abdominal Wall Dome)**：模擬 $14\text{ mmHg}$ 人工氣腹（Pneumoperitoneum）半透明穹頂，精確標定劍突（Xiphoid）、臍孔（Umbilicus）、雙側肋緣線（Costal Margins）與肋間隙。
- **肝臟 Couinaud 解剖分段**：精確細分 S2/S3（左外側段）、S4（左內側段）、S5/S6（右前下段）與 S7/S8（橫膈圓頂部），具備半透明次表面光感渲染。
- **深部目標腫瘤與安全邊界**：直徑 $10\sim40\text{ mm}$ 可調球體，外圍包覆 $+5.0\sim10.0\text{ mm}$ 金黃色安全消融邊緣（Safety Margin）。
- **關鍵避障血管柱 (Vascular Tree)**：擬真呈現下腔靜脈（IVC，$\varnothing 18\text{ mm}$）與門靜脈（Portal Vein）主幹及分支，實時進行空間最短距離碰撞檢測。

### 2. 手術機器人運動學與支點約束 (Fulcrum Kinematics)
- 腹壁切口作為嚴格的不可位移旋轉支點（Pivot Point），進入腹腔的器械保留 4 個自由度：
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

### 4. 直角楔形穿刺優化器與一鍵回正 (Right-Angle Wedge Optimizer)
- 根據探頭軸向與腫瘤中心，依據最佳縱向夾角（預設 $60^\circ$）與側向發散角（預設 $30^\circ$）推算最佳進針點。
- **一鍵自動回正 (Auto-Align to US Plane)**：套管模式會先檢查固定支點是否位於掃描面；若不可行，回報支點距離與原因且不套用角度。

### 5. 血管碰撞避障 (Collision Detection)
- 實時解析針軸線段與 IVC / 門靜脈圓柱體之最短距離。
- 當表面間距 $<5.0\text{ mm}$ 時，血管模型自動發出高頻紅色閃爍警示並啟動 Telemetry Alert。

### 6. 多視窗協同配置 (Multi-View Layout)
- **主視窗 (3D 全景 CAS)**：自由視角旋轉，提供 AP、Lateral、Axial、Surgeon 站位預設。
- **子視窗 1 (腹腔鏡視野 Laparoscopic Camera)**：位於臍孔套管的 $30^\circ$ 廣角視野，具備圓形暗角與瞄準刻度。
- **子視窗 2 (2D B-Mode 超音波視野)**：$7.5\text{ MHz}$ 凸陣掃描扇面，整合動態聲學斑點（Rayleigh Noise）與時間增益補償（TGC）。

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
|  In-Plane Alignment   |                   |  Vessel Clearance     |
|  |v . n| < sin(2°)    |                   |  Dist(S, Vessel) < 5mm|
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
