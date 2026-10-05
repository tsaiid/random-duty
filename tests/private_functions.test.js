import { describe, it, expect } from 'vitest';
import {
    average,
    standardDeviation,
    shuffle,
    multiIndexOf,
    randomIntFromInterval,
} from '../src/js/private_functions.js';

describe('private_functions', () => {
    describe('average', () => {
        it('應正確計算數值陣列之平均值', () => {
            expect(average([1, 2, 3, 4, 5])).toBe(3);
            expect(average([10, 20])).toBe(15);
        });

        it('單一元素陣列之平均值應為該元素本身', () => {
            expect(average([42])).toBe(42);
        });
    });

    describe('standardDeviation', () => {
        it('應正確計算母體標準差 (Population Standard Deviation)', () => {
            // [2, 4, 4, 4, 5, 5, 7, 9]: mean = 5, variance = 32 / 8 = 4, stdDev = 2
            expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2);
        });

        it('所有數值相同或單一數值時，標準差應為 0', () => {
            expect(standardDeviation([5, 5, 5, 5])).toBe(0);
            expect(standardDeviation([10])).toBe(0);
        });
    });

    describe('multiIndexOf', () => {
        it('應正確找出目標元素在陣列中的所有索引位置', () => {
            const arr = [1, 2, 3, 2, 4, 2, 5];
            expect(multiIndexOf(arr, 2)).toEqual([1, 3, 5]);
        });

        it('當元素不存在時應回傳空陣列', () => {
            const arr = [1, 2, 3];
            expect(multiIndexOf(arr, 99)).toEqual([]);
        });

        it('當陣列為空時應回傳空陣列', () => {
            expect(multiIndexOf([], 1)).toEqual([]);
        });
    });

    describe('shuffle', () => {
        it('洗牌後長度與元素內容應保持不變', () => {
            const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const copy = [...original];
            const shuffled = shuffle(copy);

            expect(shuffled).toHaveLength(original.length);
            expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
        });
    });

    describe('randomIntFromInterval', () => {
        it('產生的隨機整數應介於指定區間上下限之間（包含邊界）', () => {
            const min = 3;
            const max = 7;
            for (let i = 0; i < 50; i++) {
                const val = randomIntFromInterval(min, max);
                expect(Number.isInteger(val)).toBe(true);
                expect(val).toBeGreaterThanOrEqual(min);
                expect(val).toBeLessThanOrEqual(max);
            }
        });
    });
});
