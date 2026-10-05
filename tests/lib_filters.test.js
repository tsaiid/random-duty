import { describe, it, expect } from 'vitest';
import { less_than_qod_times, has_continuous_duties } from '../src/js/lib_filters.js';

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
});
