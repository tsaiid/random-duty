# Random Duty Generator

A single-page application to assist resident duty scheduling.

輔助住院醫師排班的現代化網頁工具。[線上展示 (Demo Site)](https://radtools.tsai.it/random-duty/)

## 核心功能 (Features)

1. **台灣國定假日自動同步**：透過邊緣 API Gateway 載入並快取台灣國定假日行事曆，支援手動刪除特定假日或跨日新增自訂院內假日。
2. **彈性預排與批次預假（不值）**：支援單日點選或日曆跨日拖曳選取區間，可一次複選多位不值人員，並支援設定人員真實姓名／代稱（`3 ~ 15` 人）。
3. **公平積點平衡配置**：依平日班（1 點）、週五及假日前夕班（1 點）、週末與國定假日班（2 點）自動計算公平建議班數，自動尊重已鎖定之預排底數並支援手動微調。
4. **高速混合式約束排班引擎**：於 Web Worker 背景執行 TypedArray 班距最佳化抽樣與 MRV 約束滿足回溯法（Constraint Satisfaction Backtracking），預設嚴禁連值（QD），支援隔日班（QOD）上限、住院醫師每週總工時上限（含 PM Off 扣除）與跨月交界班表併計。
5. **直覺微調與多元匯出**：支援拖曳一鍵換班（Swap）、即時違規紅框提醒、點擊人員列高亮篩選、`Ctrl/Cmd + Z` 多步復原／重做、跨月份本機草稿自動保存（`localStorage`），以及高解析度班表截圖（`.png`）、Excel（`.xlsx`）與跨裝置設定備份檔（`.json`）匯出入。

## 注意事項 (Notes)

1. **跨月週工時精準度**：月初與月底若跨越兩個月份，若同一瀏覽器 `localStorage`（或匯入之 JSON 備份）中已存有相鄰月份班表，系統會自動併入計算跨月連值、QOD 與交界週工時；若無相鄰月份資料，交界週工時僅統計當月區間內之天數供參考。
2. **跨裝置攜帶**：自動暫存草稿儲存在當前瀏覽器的 `localStorage`；如需於不同電腦間接續排班，可使用「匯出備份 (.json)／匯入備份」功能。

## License

MIT License

## 開發指南 (Development)

本專案採用 **pnpm** 進行套件管理，並以 **Vite** 與 **Vitest** 建置與測試。

### 環境需求 (Prerequisites)

* [mise](https://mise.jdx.dev/)（推薦，專案已於 `.mise.toml` 鎖定環境版本）
* 或手動安裝：
  * Node.js (v20+ / v22 LTS)
  * pnpm (v9+)

### 安裝依賴 (Installation)

```bash
mise install
pnpm install
```

### 測試與程式碼檢查 (Testing & Linting)

```bash
# 執行單元測試 (Vitest)
pnpm test

# 執行靜態語法檢查 (ESLint)
pnpm run lint
```

### 本地開發與建置 (Local Development & Build)

```bash
# 啟動本地開發伺服器 (HMR)
pnpm dev

# 建置生產環境檔案至 dist/
pnpm build

# 本地預覽生產建置結果
pnpm preview
```

### 自動化部署 (Deployment)

本專案透過 **GitHub Actions**（`.github/workflows/deploy.yml`）由 `v*` 格式之 **Git Tag** 觸發自動測試、Lint、建置並發佈至 `radtools.tsai.it/random-duty`。

## 目錄結構 (Project Structure)

* `src/`
  * `js/`
    * `index.js`: 介面控制器、事件綁定與日曆互動
    * `state_store.js`: 單一真相狀態管理、跨月查詢與 Undo/Redo 歷史堆疊
    * `lib_solver.js`: 高速混合式排班求解器（TypedArray 抽樣 + MRV 回溯引擎）
    * `random_duty_worker.js`: Web Worker 背景運算入口
    * `lib_duties.js`: 積點模型、樣式生成、色票對比與違規檢核邏輯
    * `lib_filters.js`: QD、QOD、跨月交界與週工時（含 PM Off）過濾計算
    * `lib_holidays.js`: 週末、國定假日與假日前夕判定
    * `lib_storage.js`: 偏好設定與排班草稿 `localStorage` 存取
    * `exporters.js`: 高畫質 PNG 截圖、Excel 匯出與 JSON 備份匯出入
  * `css/`: 儀表板、FullCalendar 膠囊與響應式樣式表
* `public/`: Favicon 與靜態圖示資源
* `tests/`: Vitest 單元測試套件
* `index.html`: 單頁應用主結構與對話框模板
* `vite.config.js`: Vite 打包與程式碼分割設定
