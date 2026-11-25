import { describe, it, expect } from 'vitest';
import { solve_random_duty } from '../src/js/lib_solver.js';
import { generate_balanced_pattern } from '../src/js/lib_duties.js';
import { has_continuous_duties, less_than_qod_times, less_than_max_week_hours, has_boundary_conflict } from '../src/js/lib_filters.js';

describe('lib_solver (高速混合式排班求解器)', () => {
    it('單月標準情境 (4 人, QOD<=1, 週工時<=80) 能於極短時間內產生合法且符合配額之班表', () => {
        // 2026-10: 平日 18, 週五 5, 假日 8 (假設 10/09 國慶補假為國定假日 -> 10/08 為週五班, 10/09 為假日班)
        // 若無國定假日：2026-10 (31 天) -> 平日 17, 週五 5 (10/2,9,16,23,30), 假日 9 (10/3,4,10,11,17,18,24,25,31)
        const patterns = generate_balanced_pattern(4, 17, 5, 9);
        const start = performance.now();
        const res = solve_random_duty(31, '2026-10-01', {
            duties: [['2026-10-10', 1]],
            non_duties: [['2026-10-02', 2], ['2026-10-03', 3]],
            holidays: [],
            boundary_duties: [['2026-09-30', 2]], // 09/30 為人員 2，故 10/01 不可排人員 2
        }, {
            patterns,
            use_qod_limit: true,
            qod_limit: 1,
            use_week_hours_limit: true,
            max_week_hours: 80,
        });
        const elapsed = performance.now() - start;

        expect(res.status).toBe('success');
        expect(res.duties).toHaveLength(31);
        expect(elapsed).toBeLessThan(300);

        // 驗證預排與不值與跨月連值限制
        expect(res.duties.find(d => d[0] === '2026-10-10')[1]).toBe(1);
        expect(res.duties.find(d => d[0] === '2026-10-02')[1]).not.toBe(2);
        expect(res.duties.find(d => d[0] === '2026-10-03')[1]).not.toBe(3);
        expect(res.duties.find(d => d[0] === '2026-10-01')[1]).not.toBe(2);

        // 驗證無連值、符合 QOD 與週工時
        expect(has_continuous_duties(res.groups)).toBe(false);
        expect(less_than_qod_times(res.groups, 1)).toBe(true);
        expect(has_boundary_conflict(res.groups, [['2026-09-30', 2]], true, 1)).toBe(false);
        expect(less_than_max_week_hours(res.groups, 80, {
            since_date_str: '2026-10-01',
            total_days: 31,
            preset_holidays: [],
            use_pm_off: true,
            boundary_duties: [['2026-09-30', 2]],
        })).toBe(true);
    });

    it('高難度雙月情境 (61 天, 10 人, QOD=0 嚴格無隔日班, 大量不值限制) 能透過回溯引擎迅速求解', () => {
        // 2026-10-01 ~ 2026-11-30 (61 天):
        // 週末天數: 10月 9天 + 11月 9天 = 18天; 週五天數: 10月 5天 + 11月 4天 = 9天; 平日: 61 - 18 - 9 = 34天
        const patterns = generate_balanced_pattern(10, 34, 9, 18);
        const nonDuties = [];
        // 每人設定 4 天不可值班，共 40 筆限制
        for (let p = 1; p <= 10; p++) {
            nonDuties.push([`2026-10-${String(p + 1).padStart(2, '0')}`, p]);
            nonDuties.push([`2026-10-${String(p + 12).padStart(2, '0')}`, p]);
            nonDuties.push([`2026-11-${String(p + 1).padStart(2, '0')}`, p]);
            nonDuties.push([`2026-11-${String(p + 15).padStart(2, '0')}`, p]);
        }

        const res = solve_random_duty(61, '2026-10-01', {
            duties: [],
            non_duties: nonDuties,
            holidays: [],
            boundary_duties: [],
        }, {
            patterns,
            use_qod_limit: true,
            qod_limit: 0,
            use_week_hours_limit: true,
            max_week_hours: 80,
        });

        expect(res.status).toBe('success');
        expect(res.duties).toHaveLength(61);
        expect(has_continuous_duties(res.groups)).toBe(false);
        expect(less_than_qod_times(res.groups, 0)).toBe(true);
    });

    it('當某日所有人皆被設為不值導致無解時，應立即回傳明確日期診斷訊息而非盲跑百萬次', () => {
        const patterns = generate_balanced_pattern(3, 17, 5, 9);
        const res = solve_random_duty(31, '2026-10-01', {
            duties: [],
            non_duties: [
                ['2026-10-05', 1],
                ['2026-10-05', 2],
                ['2026-10-05', 3],
            ],
            holidays: [],
        }, {
            patterns,
            use_qod_limit: false,
            qod_limit: 1,
            use_week_hours_limit: false,
            max_week_hours: 80,
        });

        expect(res.status).toBe('fail');
        expect(res.msg).toContain('2026-10-05');
    });
});
