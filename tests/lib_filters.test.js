import { describe, it, expect } from 'vitest';
import {
    less_than_qod_times,
    has_continuous_duties,
    prepare_week_hours_context,
    calculate_person_week_hours,
    less_than_max_week_hours,
    has_boundary_conflict,
} from '../src/js/lib_filters.js';

describe('lib_filters', () => {
    describe('less_than_qod_times', () => {
        it('當所有人隔日班 (QOD, 間隔為2) 次數皆小於或等於門檻時應回傳 true', () => {
            const groupDuties = {
                'Alice': { intervals: [3, 4, 3] }, // 0 次 QOD
                'Bob': { intervals: [2, 4, 2] },   // 2 次 QOD
            };

            expect(less_than_qod_times(groupDuties, 2)).toBe(true);
            expect(less_than_qod_times(groupDuties, 3)).toBe(true);
        });

        it('若有任何一人 QOD 次數大於門檻時應回傳 false', () => {
            const groupDuties = {
                'Alice': { intervals: [3, 4] },
                'Bob': { intervals: [2, 2, 2] }, // 3 次 QOD
            };

            expect(less_than_qod_times(groupDuties, 2)).toBe(false);
        });

        it('門檻值為字串型態時亦能正確轉換與判斷', () => {
            const groupDuties = {
                'Alice': { intervals: [2, 2] }, // 2 次 QOD
            };

            expect(less_than_qod_times(groupDuties, '1')).toBe(false);
            expect(less_than_qod_times(groupDuties, '2')).toBe(true);
        });
    });

    describe('has_continuous_duties', () => {
        it('當有任何連續值班（間隔為 1 天）時應回傳 true', () => {
            const groupDuties = {
                'Alice': { intervals: [3, 1, 4] },
                'Bob': { intervals: [3, 4] },
            };

            expect(has_continuous_duties(groupDuties)).toBe(true);
        });

        it('當完全無連續值班（所有間隔皆 >= 2）時應回傳 false', () => {
            const groupDuties = {
                'Alice': { intervals: [2, 3, 4] },
                'Bob': { intervals: [3, 3, 5] },
            };

            expect(has_continuous_duties(groupDuties)).toBe(false);
        });

        it('當 intervals 為空陣列時應回傳 false', () => {
            const groupDuties = {
                'Alice': { intervals: [] },
            };

            expect(has_continuous_duties(groupDuties)).toBe(false);
        });
    });

    describe('calculate_person_week_hours & prepare_week_hours_context', () => {
        it('能正確計算基準工作日與計入 PM off 後的週工時', () => {
            // 2026-10-01 為週四
            // 第 0 週（10/01~10/04）：週四、週五上班 -> 16 小時基準
            // 第 1 週（10/05~10/11）：週一至週五上班 -> 40 小時基準
            const context = prepare_week_hours_context('2026-10-01', 31, [], true);
            expect(context.baseline_week_hours[0]).toBe(16);
            expect(context.baseline_week_hours[1]).toBe(40);

            // 測試同仁於 10/05 (週一) 與 10/10 (週六) 值班
            // 10/05 (週一)：平日班 +16h，隔天 10/06 為平日 PM off -4h -> 淨增 12h
            // 10/10 (週六)：假日班 +24h，隔天 10/11 為週日無 PM off -> 淨增 24h
            // 第 1 週工時：
            // 未計 PM Off: 40 + 16 + 24 = 80h
            // 計入 PM Off: 40 + 12 + 24 = 76h
            const res = calculate_person_week_hours(['2026-10-05', '2026-10-10'], context);
            expect(res.week_hours[1]).toBe(80);
            expect(res.week_hours_pm_off[1]).toBe(76);
        });

        it('若值班隔日為國定假日，不重複扣除 PM off', () => {
            // 假設 10/09 為國定假日
            // 10/08 (週四) 值班：平日班 +16h，隔日 10/09 為假日，無 PM off 扣除 -> 淨增 16h
            const context = prepare_week_hours_context('2026-10-01', 31, ['2026-10-09'], true);
            // 第 1 週基準：10/05~10/08 (4 天平日) -> 32h
            expect(context.baseline_week_hours[1]).toBe(32);

            const res = calculate_person_week_hours(['2026-10-08'], context);
            expect(res.week_hours_pm_off[1]).toBe(32 + 16);
        });

        it('月底恰為週日時不應產生多餘的 0 小時幽靈週，且週日值班之隔日週一 PM Off 應歸屬於下一週', () => {
            // 2026-05-01 (週五) ~ 2026-05-31 (週日)，共 31 天，涵蓋 5 個日曆週 (index 0..4)
            const mayCtx = prepare_week_hours_context('2026-05-01', 31, [], true);
            expect(mayCtx.baseline_week_hours).toHaveLength(5);

            // 2026-05-10 (週日, index 1) 值班：第 1 週應加滿 24h，隔日 05-11 (週一, index 2) 扣 4h PM Off
            const res = calculate_person_week_hours(['2026-05-10'], mayCtx);
            expect(res.week_hours[1]).toBe(40 + 24);
            expect(res.week_hours_pm_off[1]).toBe(40 + 24);
            expect(res.week_hours_pm_off[2]).toBe(40 - 4);
        });

        it('當存在上月交界週班表 (boundary_duties) 時應自動併計該交界週之基準工時與人員值班工時', () => {
            // 2026-10-01 為週四；交界週為 09/28 (週一) ~ 10/04 (週日)
            // 若傳入上月 09/28 人員 1 值班，則第 0 週應包含完整 09/28~10/02 五天基準 40h，並計入人員 1 之 09/28 值班 (+12h PM Off)
            const ctx = prepare_week_hours_context('2026-10-01', 31, [], true, [['2026-09-28', 1]]);
            expect(ctx.baseline_week_hours[0]).toBe(40);

            const p1 = calculate_person_week_hours(['2026-10-03'], ctx, 1); // 10/03 (週六) +24h
            expect(p1.week_hours_pm_off[0]).toBe(40 + 12 + 24); // 76h

            const p2 = calculate_person_week_hours(['2026-10-03'], ctx, 2); // 人員 2 無上月該週值班
            expect(p2.week_hours_pm_off[0]).toBe(40 + 24); // 64h
        });
    });

    describe('has_boundary_conflict', () => {
        it('應能攔截跨月交界處的連續值班 (QD) 與超額隔日班 (QOD)', () => {
            const boundary = [['2026-10-31', 1], ['2026-10-30', 2]];
            // 人員 1 排 11/01 -> 與 10/31 連值 (QD)
            expect(has_boundary_conflict({ '1': { dates: ['2026-11-01'] } }, boundary, true, 1)).toBe(true);
            // 人員 2 排 11/01, 11/03 -> 10/30, 11/01, 11/03 產生 2 次 QOD，超過上限 1 次
            expect(has_boundary_conflict({ '2': { dates: ['2026-11-01', '2026-11-03'] } }, boundary, true, 1)).toBe(true);
            // 合法班距
            expect(has_boundary_conflict({ '1': { dates: ['2026-11-03'] }, '2': { dates: ['2026-11-01'] } }, boundary, true, 1)).toBe(false);
        });
    });

    describe('less_than_max_week_hours', () => {
        const options = {
            since_date_str: '2026-10-01',
            total_days: 31,
            preset_holidays: [],
            use_pm_off: true,
        };

        it('當所有人每週工時皆小於或等於門檻時應回傳 true', () => {
            // Alice 在第 1 週 (10/05~10/11) 值班 10/05 (平日, +12h) 與 10/10 (假日, +24h) -> 40 + 36 = 76h
            const groupDuties = {
                'Alice': { dates: ['2026-10-05', '2026-10-10'] },
                'Bob': { dates: ['2026-10-06'] }, // 40 + 12 = 52h
            };

            expect(less_than_max_week_hours(groupDuties, 80, options)).toBe(true);
            expect(less_than_max_week_hours(groupDuties, '80', options)).toBe(true);
        });

        it('當有任何一人每週工時超過門檻時應回傳 false', () => {
            // Alice 在第 1 週值 10/05 (平日, +12h), 10/07 (平日, +12h), 10/10 (假日, +24h) -> 40 + 48 = 88h
            const groupDuties = {
                'Alice': { dates: ['2026-10-05', '2026-10-07', '2026-10-10'] },
                'Bob': { dates: ['2026-10-06'] },
            };

            expect(less_than_max_week_hours(groupDuties, 80, options)).toBe(false);
            // 但如果門檻是 88 小時則合法
            expect(less_than_max_week_hours(groupDuties, 88, options)).toBe(true);
        });

        it('傳入預先計算之 context 應與傳入 options 行為完全一致', () => {
            const context = prepare_week_hours_context('2026-10-01', 31, [], true);
            const groupDuties = {
                'Alice': { dates: ['2026-10-05', '2026-10-07', '2026-10-10'] },
            };

            expect(less_than_max_week_hours(groupDuties, 80, context)).toBe(false);
            expect(less_than_max_week_hours(groupDuties, 88, context)).toBe(true);
        });

        it('空陣列或無值班日期時應回傳 true', () => {
            expect(less_than_max_week_hours({}, 80, options)).toBe(true);
            expect(less_than_max_week_hours({ 'Alice': { dates: [] } }, 80, options)).toBe(true);
        });

        it('雙月模式（61 天）跨月情境能正確判定週工時', () => {
            // 2026-10-01 至 2026-11-30（共 61 天）
            const twoMonthContext = prepare_week_hours_context('2026-10-01', 61, ['2026-10-10'], true);
            const groupDuties = {
                'Alice': {
                    dates: [
                        '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26',
                        '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'
                    ]
                },
                'Bob': {
                    dates: [
                        '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27',
                        '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'
                    ]
                }
            };
            expect(less_than_max_week_hours(groupDuties, 80, twoMonthContext)).toBe(true);
        });

        it('高頻呼叫效能測試：10,000 次候選排班驗證應於極短時間內完成', () => {
            const context = prepare_week_hours_context('2026-10-01', 31, [], true);
            const candidateSchedule = {
                '1': { dates: ['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'] },
                '2': { dates: ['2026-10-02', '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'] },
                '3': { dates: ['2026-10-03', '2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'] },
                '4': { dates: ['2026-10-04', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29'] },
            };

            const startTime = performance.now();
            let passCount = 0;
            for (let i = 0; i < 10000; i++) {
                if (less_than_max_week_hours(candidateSchedule, 80, context)) {
                    passCount++;
                }
            }
            const elapsed = performance.now() - startTime;
            expect(passCount).toBe(10000);
            expect(elapsed).toBeLessThan(500); // 10,000 次檢查應於 500ms 內完成（通常只要 20~40ms）
        });
    });
});


