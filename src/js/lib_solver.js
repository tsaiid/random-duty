import dayjs from './setup-dayjs.js';
import { shuffle, standardDeviation } from './private_functions.js';
import { calculate_group_duties, calculate_group_duties_status, get_preset_duty } from './lib_duties.js';
import { is_holiday, is_weekend, is_friday } from './lib_holidays.js';
import { prepare_week_hours_context } from './lib_filters.js';

/**
 * Compute fairness score for a valid schedule (lower is better / more evenly spaced).
 * @param {Int16Array} sched Person numbers (1..P) assigned to days 0..N-1.
 * @param {number} people Number of staff.
 * @return {number} Composite score of interval standard deviations and QOD penalties.
 */
function scoreScheduleFairness(sched, people) {
    const lastPos = new Int16Array(people + 1).fill(-1);
    const intervalsByPerson = Array.from({ length: people + 1 }, () => []);
    let qodTotal = 0;

    for (let d = 0; d < sched.length; d++) {
        const p = sched[d];
        if (p >= 1 && p <= people) {
            if (lastPos[p] !== -1) {
                const diff = d - lastPos[p];
                intervalsByPerson[p].push(diff);
                if (diff === 2) qodTotal++;
            }
            lastPos[p] = d;
        }
    }

    let stdSum = 0;
    for (let p = 1; p <= people; p++) {
        const ivs = intervalsByPerson[p];
        if (ivs.length > 1) {
            stdSum += standardDeviation(ivs);
        }
    }
    return stdSum + qodTotal * 0.35;
}

/**
 * High-performance hybrid duty solver:
 * 1. Precomputes day categories, non-duty bitmasks, boundary constraints, and weekly work-hour tables.
 * 2. Runs zero-allocation typed-array randomized sampling, selecting the best fairness (lowest std_dev) among valid schedules.
 * 3. Automatically falls back to Randomized MRV Constraint-Satisfaction Backtracking (CSP) when tight constraints defeat random shuffling.
 *
 * @param {number} total_days Number of days in scheduling range.
 * @param {string} since_date_str Start date string (YYYY-MM-DD).
 * @param {Object} presets { duties, non_duties, holidays, boundary_duties }.
 * @param {Object} filters { patterns, use_qod_limit, qod_limit, use_week_hours_limit, max_week_hours }.
 * @param {Function} [onProgress] Optional callback receiving progress message string.
 * @return {{ status: 'success'|'fail', msg: string, duties: Array<[string, number]>, groups: Object }}
 */
export function solve_random_duty(total_days, since_date_str, presets, filters, onProgress) {
    const patterns = filters.patterns || [];
    const people = patterns.length;
    const presetDuties = presets.duties || [];
    const presetNonDuties = presets.non_duties || [];
    const presetHolidays = presets.holidays || [];
    const boundaryDuties = presets.boundary_duties || [];

    const useQod = Boolean(filters.use_qod_limit);
    const qodLimit = useQod ? parseInt(filters.qod_limit, 10) : 999;
    const useWeekHours = Boolean(filters.use_week_hours_limit);
    const maxWeekHours = useWeekHours ? parseInt(filters.max_week_hours, 10) : 9999;

    if (total_days <= 0 || people <= 0) {
        return { status: 'fail', msg: '排班天數或人數設定無效。', duties: [], groups: {} };
    }

    // Build date array & day category table (0 = ordinary, 1 = friday, 2 = holiday)
    const dateStrs = new Array(total_days);
    const dateIndexMap = new Map();
    const dayCat = new Uint8Array(total_days);
    const presetArr = new Int16Array(total_days); // 0 if unassigned, else person 1..people

    let curDate = dayjs(since_date_str);
    for (let d = 0; d < total_days; d++) {
        const dStr = curDate.format('YYYY-MM-DD');
        dateStrs[d] = dStr;
        dateIndexMap.set(dStr, d);
        if (is_holiday(presetHolidays, dStr) || is_weekend(dStr)) {
            dayCat[d] = 2;
        } else if (is_friday(presetHolidays, dStr)) {
            dayCat[d] = 1;
        } else {
            dayCat[d] = 0;
        }
        const lockedP = get_preset_duty(presetDuties, dStr);
        presetArr[d] = lockedP !== undefined ? lockedP : 0;
        curDate = curDate.add(1, 'day');
    }

    // Compute residual quotas per person & category
    const presetGroups = calculate_group_duties_status(
        calculate_group_duties(presetDuties, false),
        presetHolidays
    );
    const remQuota = new Int16Array((people + 1) * 3);
    const poolOrdinary = [];
    const poolFriday = [];
    const poolHoliday = [];
    const openDaysByCat = [[], [], []];

    for (let d = 0; d < total_days; d++) {
        if (presetArr[d] === 0) {
            openDaysByCat[dayCat[d]].push(d);
        }
    }

    for (let p = 1; p <= people; p++) {
        const pat = patterns[p - 1];
        const pg = presetGroups[p] || { ordinary_count: 0, friday_count: 0, holiday_count: 0 };
        const rO = pat[0] - (pg.ordinary_count || 0);
        const rF = pat[1] - (pg.friday_count || 0);
        const rH = pat[2] - (pg.holiday_count || 0);

        if (rO < 0 || rF < 0 || rH < 0) {
            return {
                status: 'fail',
                msg: '預排班數超過目前排班樣式配額，請重新更新或修改排班樣式後再試。',
                duties: [],
                groups: {},
            };
        }

        remQuota[p * 3 + 0] = rO;
        remQuota[p * 3 + 1] = rF;
        remQuota[p * 3 + 2] = rH;

        for (let i = 0; i < rO; i++) poolOrdinary.push(p);
        for (let i = 0; i < rF; i++) poolFriday.push(p);
        for (let i = 0; i < rH; i++) poolHoliday.push(p);
    }

    if (
        poolOrdinary.length !== openDaysByCat[0].length ||
        poolFriday.length !== openDaysByCat[1].length ||
        poolHoliday.length !== openDaysByCat[2].length
    ) {
        return {
            status: 'fail',
            msg: '排班樣式各類別配額加總與當月未排天數不一致，請點擊「更新」重新生成建議排班樣式。',
            duties: [],
            groups: {},
        };
    }

    // Forbidden lookup: forbidden[d * (people + 1) + p] = 1 if p cannot work on day d
    const strideP = people + 1;
    const forbidden = new Uint8Array(total_days * strideP);
    for (let i = 0; i < presetNonDuties.length; i++) {
        const dIdx = dateIndexMap.get(presetNonDuties[i][0]);
        const p = parseInt(presetNonDuties[i][1], 10);
        if (dIdx !== undefined && p >= 1 && p <= people) {
            forbidden[dIdx * strideP + p] = 1;
        }
    }

    // Boundary QD/QOD tracking: offsets -2, -1 (before start) and total_days, total_days + 1 (after end)
    const startObj = dayjs(since_date_str);
    const prevDay1 = new Uint8Array(strideP); // worked day -1 -> forbids day 0 (QD), day 1 is QOD
    const prevDay2 = new Uint8Array(strideP); // worked day -2 -> day 0 is QOD
    const nextDay0 = new Uint8Array(strideP); // worked day N -> forbids day N-1 (QD), day N-2 is QOD
    const nextDay1 = new Uint8Array(strideP); // worked day N+1 -> day N-1 is QOD
    const baseBoundaryQod = new Int16Array(strideP);

    // Group boundary dates per person to also count QODs strictly within boundary pairs if needed
    for (let i = 0; i < boundaryDuties.length; i++) {
        const bStr = boundaryDuties[i][0];
        const p = parseInt(boundaryDuties[i][1], 10);
        if (isNaN(p) || p < 1 || p > people) continue;
        const offset = dayjs(bStr).diff(startObj, 'day');
        if (offset === -1) {
            prevDay1[p] = 1;
            forbidden[0 * strideP + p] = 1; // Cannot QD across month start
        } else if (offset === -2) {
            prevDay2[p] = 1;
        } else if (offset === total_days) {
            nextDay0[p] = 1;
            forbidden[(total_days - 1) * strideP + p] = 1; // Cannot QD across month end
        } else if (offset === total_days + 1) {
            nextDay1[p] = 1;
        }
    }

    for (let p = 1; p <= people; p++) {
        // Note: if person worked -2 and -1 that's already in previous month, if worked -2 and +0 we count dynamically
        baseBoundaryQod[p] = 0;
    }

    // Weekly hours precomputation tables
    let numWeeks = 1;
    let dayWeekNo = null;
    let dayDutyHours = null;
    let dayPmOffWeek = null;
    let dayPmOffDeduct = null;
    let personBaseWeekHours = null;

    if (useWeekHours) {
        const ctx = prepare_week_hours_context(since_date_str, total_days, presetHolidays, true, boundaryDuties);
        numWeeks = ctx.total_weeks + 1;
        dayWeekNo = new Int16Array(total_days);
        dayDutyHours = new Int16Array(total_days);
        dayPmOffWeek = new Int16Array(total_days);
        dayPmOffDeduct = new Int16Array(total_days);

        for (let d = 0; d < total_days; d++) {
            const info = ctx.date_info_map[dateStrs[d]];
            dayWeekNo[d] = info.week_no;
            dayDutyHours[d] = info.duty_hours;
            dayPmOffDeduct[d] = info.pm_off_deduction;
            dayPmOffWeek[d] = (info.pm_off_deduction > 0 && info.pm_off_week_no >= 0 && info.pm_off_week_no <= ctx.total_weeks)
                ? info.pm_off_week_no
                : -1;
        }

        personBaseWeekHours = new Int16Array(strideP * numWeeks);
        for (let p = 1; p <= people; p++) {
            const bPm = ctx.person_boundary_hours_pm_off ? ctx.person_boundary_hours_pm_off[String(p)] : null;
            for (let w = 0; w < numWeeks; w++) {
                personBaseWeekHours[p * numWeeks + w] = ctx.baseline_week_hours[w] + (bPm ? bPm[w] : 0);
            }
        }
    }

    // Fast pre-check: ensure presets themselves don't violate forbidden/boundary rules, and every open day has >=1 candidate
    for (let d = 0; d < total_days; d++) {
        const lp = presetArr[d];
        if (lp > 0) {
            if (forbidden[d * strideP + lp]) {
                return { status: 'fail', msg: `預排班日期 ${dateStrs[d]} (人員 ${lp}) 違反不值或跨月連值限制！`, duties: [], groups: {} };
            }
        } else {
            const cat = dayCat[d];
            let hasAny = false;
            for (let p = 1; p <= people; p++) {
                if (remQuota[p * 3 + cat] > 0 && !forbidden[d * strideP + p]) {
                    if ((d > 0 && presetArr[d - 1] === p) || (d + 1 < total_days && presetArr[d + 1] === p)) {
                        continue;
                    }
                    hasAny = true;
                    break;
                }
            }
            if (!hasAny) {
                return {
                    status: 'fail',
                    msg: `日期 ${dateStrs[d]} 受限於不值班或預排連值條件，無任何可排入之人員！`,
                    duties: [],
                    groups: {},
                };
            }
        }
    }

    // =========================================================================
    // Engine 1: Ultra-Fast Typed-Array Monte Carlo + Fairness Optimization
    // =========================================================================
    const candSched = new Int16Array(presetArr);
    const qodCounter = new Int16Array(strideP);
    const weekWorkBuf = useWeekHours ? new Int16Array(strideP * numWeeks) : null;

    let bestSched = null;
    let bestScore = Infinity;
    let validFound = 0;

    const FAST_SHUFFLE_BUDGET = 40000;
    const TARGET_SOLUTIONS = 15;

    const slotsO = Int16Array.from(openDaysByCat[0]);
    const slotsF = Int16Array.from(openDaysByCat[1]);
    const slotsH = Int16Array.from(openDaysByCat[2]);

    for (let iter = 0; iter < FAST_SHUFFLE_BUDGET; iter++) {
        shuffle(poolOrdinary);
        shuffle(poolFriday);
        shuffle(poolHoliday);

        let rejected = false;
        for (let i = 0; i < slotsO.length; i++) {
            const d = slotsO[i];
            const p = poolOrdinary[i];
            if (forbidden[d * strideP + p]) { rejected = true; break; }
            candSched[d] = p;
        }
        if (rejected) continue;

        for (let i = 0; i < slotsF.length; i++) {
            const d = slotsF[i];
            const p = poolFriday[i];
            if (forbidden[d * strideP + p]) { rejected = true; break; }
            candSched[d] = p;
        }
        if (rejected) continue;

        for (let i = 0; i < slotsH.length; i++) {
            const d = slotsH[i];
            const p = poolHoliday[i];
            if (forbidden[d * strideP + p]) { rejected = true; break; }
            candSched[d] = p;
        }
        if (rejected) continue;

        // Check QD (adjacent days)
        for (let d = 1; d < total_days; d++) {
            if (candSched[d] === candSched[d - 1]) {
                rejected = true;
                break;
            }
        }
        if (rejected) continue;

        // Check QOD (including cross-month boundaries)
        if (useQod) {
            qodCounter.set(baseBoundaryQod);
            const p0 = candSched[0];
            if (prevDay2[p0]) {
                if (++qodCounter[p0] > qodLimit) continue;
            }
            if (total_days > 1) {
                const p1 = candSched[1];
                if (prevDay1[p1]) {
                    if (++qodCounter[p1] > qodLimit) continue;
                }
            }
            for (let d = 2; d < total_days; d++) {
                if (candSched[d] === candSched[d - 2]) {
                    const p = candSched[d];
                    if (++qodCounter[p] > qodLimit) {
                        rejected = true;
                        break;
                    }
                }
            }
            if (rejected) continue;

            if (total_days >= 2 && nextDay0[candSched[total_days - 2]]) {
                if (++qodCounter[candSched[total_days - 2]] > qodLimit) continue;
            }
            if (nextDay1[candSched[total_days - 1]]) {
                if (++qodCounter[candSched[total_days - 1]] > qodLimit) continue;
            }
        }

        // Check Weekly Work Hours
        if (useWeekHours) {
            weekWorkBuf.set(personBaseWeekHours);
            for (let d = 0; d < total_days; d++) {
                const p = candSched[d];
                const baseIdx = p * numWeeks;
                const w = dayWeekNo[d];
                weekWorkBuf[baseIdx + w] += dayDutyHours[d];
                const pmW = dayPmOffWeek[d];
                if (pmW !== -1) {
                    weekWorkBuf[baseIdx + pmW] -= dayPmOffDeduct[d];
                }
            }
            for (let idx = numWeeks; idx < strideP * numWeeks; idx++) {
                if (weekWorkBuf[idx] > maxWeekHours) {
                    rejected = true;
                    break;
                }
            }
            if (rejected) continue;
        }

        // Valid schedule found! Score fairness and keep the best
        const score = scoreScheduleFairness(candSched, people);
        if (score < bestScore) {
            bestScore = score;
            bestSched = new Int16Array(candSched);
        }
        validFound++;
        if (validFound >= TARGET_SOLUTIONS) {
            break;
        }
    }

    // =========================================================================
    // Engine 2: Randomized MRV Backtracking (CSP) Fallback for Tight Constraints
    // =========================================================================
    if (!bestSched) {
        const sched = new Int16Array(presetArr);
        const curQuota = new Int16Array(remQuota);
        const curQod = new Int16Array(baseBoundaryQod);
        const curWeekHrs = useWeekHours ? new Int16Array(personBaseWeekHours) : null;

        // Pre-apply preset duties to QOD and weekly hours state
        for (let d = 0; d < total_days; d++) {
            const p = sched[d];
            if (p > 0) {
                if (d === 0 && prevDay2[p]) curQod[p]++;
                if (d === 1 && prevDay1[p]) curQod[p]++;
                if (d >= 2 && sched[d - 2] === p) curQod[p]++;
                if (d === total_days - 2 && nextDay0[p]) curQod[p]++;
                if (d === total_days - 1 && nextDay1[p]) curQod[p]++;

                if (useWeekHours) {
                    const baseIdx = p * numWeeks;
                    curWeekHrs[baseIdx + dayWeekNo[d]] += dayDutyHours[d];
                    const pmW = dayPmOffWeek[d];
                    if (pmW !== -1) curWeekHrs[baseIdx + pmW] -= dayPmOffDeduct[d];
                }
            }
        }

        function countQodDelta(d, p) {
            let delta = 0;
            if (d === 0 && prevDay2[p]) delta++;
            if (d === 1 && prevDay1[p]) delta++;
            if (d >= 2 && sched[d - 2] === p) delta++;
            if (d + 2 < total_days && sched[d + 2] === p) delta++;
            if (d === total_days - 2 && nextDay0[p]) delta++;
            if (d === total_days - 1 && nextDay1[p]) delta++;
            return delta;
        }

        function canAssign(d, p) {
            const cat = dayCat[d];
            if (curQuota[p * 3 + cat] <= 0) return false;
            if (forbidden[d * strideP + p]) return false;
            if (d > 0 && sched[d - 1] === p) return false;
            if (d + 1 < total_days && sched[d + 1] === p) return false;

            if (useQod) {
                const qDelta = countQodDelta(d, p);
                if (curQod[p] + qDelta > qodLimit) return false;
            }

            if (useWeekHours) {
                const baseIdx = p * numWeeks;
                const w = dayWeekNo[d];
                const pmW = dayPmOffWeek[d];
                const wNew = curWeekHrs[baseIdx + w] + dayDutyHours[d] - (pmW === w ? dayPmOffDeduct[d] : 0);
                // Note: future unassigned days in the same week might contribute a Monday PM off (-4h)!
                // Wait: only a Sunday duty in week w-1 can subtract 4h from week w (at most once per week, since Sunday is a single day!).
                const possibleFutureSundayPmOff = (w > 0) ? 4 : 0;
                if (wNew - possibleFutureSundayPmOff > maxWeekHours) return false;
            }
            return true;
        }

        function verifyFullWeekHours() {
            if (!useWeekHours) return true;
            for (let idx = numWeeks; idx < strideP * numWeeks; idx++) {
                if (curWeekHrs[idx] > maxWeekHours) return false;
            }
            return true;
        }

        const totalOpen = slotsO.length + slotsF.length + slotsH.length;
        let nodesVisited = 0;
        let restartNodes = 0;
        const MAX_TOTAL_NODES = 400000;
        const NODES_PER_RESTART = 10000;

        function backtrack(depth) {
            if (depth === totalOpen) {
                if (!verifyFullWeekHours()) return false;
                const sc = scoreScheduleFairness(sched, people);
                if (sc < bestScore) {
                    bestScore = sc;
                    bestSched = new Int16Array(sched);
                }
                validFound++;
                return true;
            }

            nodesVisited++;
            restartNodes++;
            if (nodesVisited % 5000 === 0 && typeof onProgress === 'function') {
                onProgress(`深度約束求解中 (已探索 ${nodesVisited.toLocaleString()} 節點)...`);
            }
            if (restartNodes > NODES_PER_RESTART || nodesVisited > MAX_TOTAL_NODES) {
                return false;
            }

            // MRV Heuristic: pick unassigned day with fewest legal candidates
            let bestDay = -1;
            let bestCands = null;
            let minLen = 999;

            for (let d = 0; d < total_days; d++) {
                if (sched[d] !== 0) continue;
                const cands = [];
                for (let p = 1; p <= people; p++) {
                    if (canAssign(d, p)) {
                        cands.push(p);
                    }
                }
                if (cands.length === 0) {
                    return false; // Dead end -> prune immediately!
                }
                if (cands.length < minLen) {
                    minLen = cands.length;
                    bestDay = d;
                    bestCands = cands;
                    if (minLen === 1) break;
                }
            }

            // Randomize candidate order while favoring larger remaining quota / fewer QODs
            shuffle(bestCands);
            const cat = dayCat[bestDay];
            bestCands.sort((a, b) => curQuota[b * 3 + cat] - curQuota[a * 3 + cat]);

            for (let i = 0; i < bestCands.length; i++) {
                const p = bestCands[i];
                const qDelta = useQod ? countQodDelta(bestDay, p) : 0;

                sched[bestDay] = p;
                curQuota[p * 3 + cat]--;
                curQod[p] += qDelta;
                if (useWeekHours) {
                    const baseIdx = p * numWeeks;
                    curWeekHrs[baseIdx + dayWeekNo[bestDay]] += dayDutyHours[bestDay];
                    const pmW = dayPmOffWeek[bestDay];
                    if (pmW !== -1) curWeekHrs[baseIdx + pmW] -= dayPmOffDeduct[bestDay];
                }

                if (backtrack(depth + 1) && validFound >= 3) {
                    return true;
                }

                // Undo state
                if (useWeekHours) {
                    const baseIdx = p * numWeeks;
                    curWeekHrs[baseIdx + dayWeekNo[bestDay]] -= dayDutyHours[bestDay];
                    const pmW = dayPmOffWeek[bestDay];
                    if (pmW !== -1) curWeekHrs[baseIdx + pmW] += dayPmOffDeduct[bestDay];
                }
                curQod[p] -= qDelta;
                curQuota[p * 3 + cat]++;
                sched[bestDay] = 0;

                if (restartNodes > NODES_PER_RESTART || nodesVisited > MAX_TOTAL_NODES) {
                    break;
                }
            }
            return bestSched !== null;
        }

        while (nodesVisited < MAX_TOTAL_NODES && validFound < 3) {
            restartNodes = 0;
            backtrack(0);
            if (nodesVisited === 0 || restartNodes < NODES_PER_RESTART) {
                // Search tree exhausted completely! If bestSched is still null, problem is provably infeasible!
                break;
            }
        }
    }

    if (!bestSched) {
        return {
            status: 'fail',
            msg: '在目前的預排、不值、QOD 與週工時限制下無符合條件之排班解，建議適度放寬 QOD 次數、週工時上限或調整建議排班樣式。',
            duties: [],
            groups: {},
        };
    }

    const finalDuties = new Array(total_days);
    for (let d = 0; d < total_days; d++) {
        finalDuties[d] = [dateStrs[d], bestSched[d]];
    }
    const finalGroups = calculate_group_duties(finalDuties, false);

    return {
        status: 'success',
        msg: '',
        duties: finalDuties,
        groups: finalGroups,
    };
}
