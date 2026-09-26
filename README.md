# LUS-Ablation 3D Planner
### 腹腔鏡超音波肝消融示意幾何模擬 (Illustrative Laparoscopic Ultrasound Ablation Geometry Simulation)

[![Three.js](https://img.shields.io/badge/Three.js-0.172.0-00d2ff?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-00ff66.svg)](LICENSE)

**LUS-Ablation 3D Planner** 是以 WebGL 呈現的示意性 3D 幾何與介面原型，用於展示肝臟病灶、器械姿態、超音波切面與消融區的空間關係。

解剖座標、器械入口、血管、超音波影像面與消融橢球都是示意性幾何，未經臨床校準或驗證。本原型不提供影像配準、病人解剖定位、組織變形、呼吸移動、針與組織互動、溫度場或熱劑量模型；不得用於手術導航、診斷、治療決策或安全判定。消融重疊只計算目標加外擴邊界球體與示意橢球的幾何重疊，不代表熱劑量、腫瘤控制率或血管安全。

---

### 座標系與左右標記

場景使用 **X+ 病人左、Y+ 頭側、Z+ 前側**；AP 相機從病人前側觀看，因此病人右側應顯示在畫面左側。`src/math/patientCoordinates.ts` 提供 DICOM BIPED LPS 毫米座標 `(L, P, S)` 與場景 `(X, Y, Z) = (L, S, -P)` 的點座標轉換。實際匯入 DICOM 仍須依 `ImageOrientationPatient`、`ImagePositionPatient` 與 `PixelSpacing` 還原影像體素座標；本原型尚未提供 CT/DICOM 匯入或影像配準。

左右肝葉以共用中線的半橢球網格表示，網格不重疊，示意網格體積約維持右葉 70%、左葉 30%。主刀視角會將病人左側顯示在畫面右側；切換視角不改動兩葉網格。這些幾何僅供外觀示意，不是肝臟分割或病人特定比例。

## 布孔規劃 (Skin Port Planning)

針對選定腫瘤，程式回答「皮膚上這一點可不可以、為什麼」，**不排名、不推薦**。

- **側視線陣探頭**（`src/config/probe.ts`，幾何類似 BK 8666-RF）：陣列在尖端側面，影像面含探頭長軸，聲束垂直於陣列面，影像為矩形（陣列 30 mm，顯示寬 50 mm）。桿身以套管為支點轉動（俯仰、偏擺、自轉、插入長度），尖端四向彎曲。影像面、B-mode 與共平面判定都用同一個姿態計算。
- **探頭套管位置**：該點能否讓陣列貼在肝表面某處、讓腫瘤進入影像；探頭桿不可穿過肝臟、不可跑出腹壁、套管傾斜與尖端彎曲在上限內。只考慮肝臟前面與下面（後面貼後腹膜、穹頂在橫膈下）。
- **經導引孔進針**：導引孔在陣列後端，導引線與參考軸夾固定角度、落在影像面內。探頭姿態一決定，導引線往回延伸到皮膚就**算出**皮膚穿刺點；往前必須在影像內穿過腫瘤。
- **徒手平面內進針**：選「徒手平面內」後按「規劃徒手平面內進針」，程式掃過整片前腹壁，找出配合**目前探頭孔**可行的皮膚進針點，以藍點標示，並擺好其中針最短的一組（優先選沒有警示的，只是幾何選法）；點其他藍點可改用。每一點都要同時滿足：
  - 整條針（從皮膚到腫瘤）落在影像面內——探頭可在肝表面輕微搖擺最多 3° 來對齊；
  - 針從探頭尖端旁邊進肝、不碰探頭（離探頭表面 ≥ 3 mm）；
  - 肝內針道在影像外的長度 ≤ 10 mm（一進肝就看得到針）；
  - 針與聲束夾角 ≥ 20°（太接近聲束方向時針在影像上不易看見）；
  - 以及針長、距血管、皮膚傾斜角、探頭可達與彎曲上限。
  這些門檻都是**未校正的預設值**。S7/S8 這類超出導引線深度（> 32 mm）的腫瘤可改用徒手平面內進針。
- **皮膚可行區**：在皮膚上以顏色標示探頭孔與徒手進針點的可行區（綠／藍／青；肋骨區較暗）。徒手進針的顏色以目前探頭孔計算，換探頭孔會重算。

導引孔固定在探頭尖端、隨尖端彎曲：孔在陣列中心後方約 30 mm，導引角 30° 量自尖端軸，影像寬 50 mm（擁有者提供，2026-09-26）。依此導引線在影像內涵蓋約 3–32 mm 深；更深的腫瘤雖可能打到，但針尖會在影像外。**尚未以手冊或實測校正**，畫面會標示。

示意解剖中肝臟位於半球形腹壁中央，因此大部分皮膚點都會顯示可行；可行區要有鑑別力，需要病人影像的解剖。

## 🌟 示意模擬功能 (Simulation Features)

### 1. 示意性 3D 解剖與組織幾何 (Illustrative Anatomy)
- **腹壁穹頂與通道標記**：以同一個示意性前腹壁橢球投影皮表標記，套管支點與標記共用該幾何表面；未依病人影像或真實表面校準。
- **左右肝葉外形與病灶球體**：以共用中線、不重疊的半橢球網格表示示意外形，網格體積比例約為右葉 70%、左葉 30%；主刀視角將病人左側顯示在畫面右側。提供 S2/S3、S5/S6、S7/S8 的病灶位置範例；這不是 Couinaud 分段或 CT 分割。病灶直徑與外擴邊界可調。
- **示意血管樹**：以圓柱段表示 IVC 與門靜脈主幹和分支，僅供幾何距離計算。

### 2. 器械運動學示意 (Fulcrum Kinematics)
- 套管通道採用示意性皮表支點；經皮最佳化點仍是規劃座標，不代表病人解剖位置。動態進針只會在當前針軌跡與腫瘤球相交時前進至腫瘤邊界，針尖是否進入病灶以 3D 距離判定。進入腹腔的器械保留 4 個自由度：
  - 探頭：桿身俯仰、偏擺、自轉、插入長度，加上尖端上下／左右彎曲（見「布孔規劃」）
  - 穿刺針：俯仰角 (Pitch, $\theta$)
  - 偏擺角 (Yaw, $\phi$)
  - 深入深度 (Insertion Depth, $d$)
  - 軸向自轉 (Roll, $\psi$)
- 支援 4 大標準套管通道佈局：
  1. **臍孔套管 (Umbilical Port, 10mm)**：光學腹腔鏡通道；以獨立「臍孔腹腔鏡鏡頭視角」控制相機，不列為 LUS 探頭入口，也不會移動探頭。
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

### 4. 楔形幾何最佳化穿刺與自動回正 (Right-Angle Wedge Optimizer & Auto-Align)
- **固定套管支點驗證**：套管為腹壁固定支點；若固定支點偏離切面、病灶不與切面相交、超出掃描扇面或角度深度超限，演算法嚴格回報無可行解與幾何殘差，並提供一鍵「切換經皮最佳進針點 C 並回正」輔助。
- **經皮進針點 C**：在超音波影像面內依設定角度求出指向腫瘤的軌跡，再往回延伸到皮膚，C 點一律落在皮膚上（原先是影像面內的規劃座標，可能浮在空中或在體內）。
- **$\triangle ABC$ 楔形導引三角視角**：3D 場景即時繪製由聲頭 $A$、病灶 $B$ 與進針點 $C$ 構成之半透明導引三角與邊界導引線，可隨時切換開關。
- **B-Mode 1.5mm 薄層投影**：病灶輪廓嚴格依據 1.5 mm 聲束薄層幾何截面縮放；超出矩形影像（寬 50 mm、深 0–80 mm）的部分自動裁切。

### 5. 針身與示意血管間距 (Needle-Shaft Clearance)
- 計算 0.8 mm 半徑的示意針身外表面至 IVC / 門靜脈圓柱表面的幾何間距。
- 間距小於 5 mm 時顯示警示；此警示只評估針身線段，不評估消融區、熱效應或臨床血管安全。

### 6. 多視窗協同配置 (Multi-View Layout)
- **主視窗 (3D 全景 CAS)**：自由視角旋轉，提供 AP、Lateral、Axial、Surgeon 站位預設。
- **子視窗 1 (腹腔鏡視野 Laparoscopic Camera)**：位於臍孔套管的 $30^\circ$ 廣角視野，具備圓形暗角與瞄準刻度。
- **子視窗 2 (2D B-Mode 超音波視野)**：側視線陣的矩形影像，病灶只顯示與 1.5 mm 掃描薄層相交的截面；導引線依導引孔位置與角度畫出。畫面包含合成聲學斑點與簡化深度衰減，不是超音波設備輸出。

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

# 4. 執行計算幾何、運動學與布孔規劃測試（每個檔案都會跑，列出所有失敗）
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
