import { describe, it, expect } from 'vitest';
import { is_holiday, is_friday, is_weekend } from '../src/js/lib_holidays.js';

describe('lib_holidays', () => {
    describe('is_holiday', () => {
        it('當日期存在於預設假日清單中時應回傳 true', () => {
            const holidays = ['2026-01-01', '2026-02-17', '2026-10-10'];
            expect(is_holiday(holidays, '2026-01-01')).toBe(true);
            expect(is_holiday(holidays, '2026-10-10')).toBe(true);
        });

        it('當日期不存在於預設假日清單中時應回傳 false', () => {
            const holidays = ['2026-01-01', '2026-10-10'];
            expect(is_holiday(holidays, '2026-01-02')).toBe(false);
            expect(is_holiday([], '2026-01-01')).toBe(false);
        });
    });

    describe('is_friday', () => {
        it('一般非假日的週五應回傳 true', () => {
            // 2026-10-09 為週五
            const holidays = [];
            expect(is_friday(holidays, '2026-10-09')).toBe(true);
        });

        it('若週五本身被設定為國定假日，則不計為週五班（視為假日班）', () => {
            // 2026-10-09 為週五，若隔日週六不是 preset_holiday
            const holidays = ['2026-10-09'];
            expect(is_friday(holidays, '2026-10-09')).toBe(false);
        });

        it('國定假日前一天（如週四逢連假前夕）應視為週五班 (小週末前夕)', () => {
            // 2026-10-01 (週四)，隔日 2026-10-02 (週五) 為國定假日
            const holidays = ['2026-10-02'];
            expect(is_friday(holidays, '2026-10-01')).toBe(true);
        });

        it('一般平日（非週五且隔天非假日）應回傳 false', () => {
            // 2026-10-06 (週二)
            const holidays = [];
            expect(is_friday(holidays, '2026-10-06')).toBe(false);
        });
    });

    describe('is_weekend', () => {
        it('週六與週日應回傳 true', () => {
            // 2026-10-10 為週六, 2026-10-11 為週日
            expect(is_weekend('2026-10-10')).toBe(true);
            expect(is_weekend('2026-10-11')).toBe(true);
        });

        it('週一至週五應回傳 false', () => {
            expect(is_weekend('2026-10-05')).toBe(false); // 週一
            expect(is_weekend('2026-10-07')).toBe(false); // 週三
            expect(is_weekend('2026-10-09')).toBe(false); // 週五
        });
    });
});
