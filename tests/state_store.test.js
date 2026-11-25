import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '../src/js/state_store.js';

describe('state_store (單一真相狀態管理與跨月隔離)', () => {
    it('切換月份與清除自動排班時，其他月份的排班紀錄應完整保留不遺失', () => {
        const store = createScheduleStore();
        store.state.currentMonth = store.state.currentMonth.year(2026).month(9).startOf('month'); // 2026-10

        // 10 月排入預排與自動排班
        store.addDutyItem({ date: '2026-10-01', person: 1, isPreset: true });
        store.replaceGeneratedDutiesInRange('2026-10-01', '2026-11-01', [
            ['2026-10-01', 1],
            ['2026-10-02', 2],
            ['2026-10-31', 3],
        ]);

        // 切換至 11 月並執行自動排班
        store.state.currentMonth = store.state.currentMonth.add(1, 'month'); // 2026-11
        store.replaceGeneratedDutiesInRange('2026-11-01', '2026-12-01', [
            ['2026-11-01', 4],
            ['2026-11-02', 1],
        ]);

        // 11 月區間查詢只回傳 11 月，且 getBoundaryDuties 能自動抓到 10/31 的跨月交界班
        expect(store.getAllDuties()).toEqual([['2026-11-01', 4], ['2026-11-02', 1]]);
        expect(store.getBoundaryDuties()).toContainEqual(['2026-10-31', 3]);

        // 清除 11 月自動排班後，10 月班表依然完好無損
        store.clearGeneratedDutiesInRange('2026-11-01', '2026-12-01');
        expect(store.getAllDuties()).toEqual([]);

        store.state.currentMonth = store.state.currentMonth.subtract(1, 'month'); // 回到 2026-10
        expect(store.getAllDuties()).toEqual([
            ['2026-10-01', 1],
            ['2026-10-02', 2],
            ['2026-10-31', 3],
        ]);
    });

    it('支援 Undo 與 Redo 歷史紀錄還原', () => {
        const store = createScheduleStore();
        store.pushUndo();
        store.addDutyItem({ date: '2026-11-05', person: 2, isPreset: true });
        expect(store.getPresetDuties({ inRangeOnly: false })).toEqual([['2026-11-05', 2]]);

        expect(store.undo()).toBe(true);
        expect(store.getPresetDuties({ inRangeOnly: false })).toEqual([]);

        expect(store.redo()).toBe(true);
        expect(store.getPresetDuties({ inRangeOnly: false })).toEqual([['2026-11-05', 2]]);
    });
});
