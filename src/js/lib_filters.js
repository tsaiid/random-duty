import dayjs from './setup-dayjs.js';
import { multiIndexOf } from './private_functions.js';
import { is_holiday, is_weekend } from './lib_holidays.js';

/**
 * Precompute weekly baseline work hours and date information for fast week work hours evaluation.
 * @param {string} since_date_str Start date string (YYYY-MM-DD)
 * @param {number} total_days Number of days
 * @param {Array} [preset_holidays=[]] Array of holiday date strings
 * @param {boolean} [use_pm_off=true] Whether to apply PM Off deduction
 * @return {Object} Context containing baseline_week_hours, date_info_map, and total_weeks
 */
export function prepare_week_hours_context(since_date_str, total_days, preset_holidays = [], use_pm_off = true, boundary_duties = []) {
    preset_holidays = preset_holidays || [];
    boundary_duties = boundary_duties || [];
    var start_date = dayjs(since_date_str);
    var end_date = start_date.add(total_days, 'day');
    var last_date = total_days > 0 ? end_date.subtract(1, 'day') : start_date;
    var view_start_date = start_date.startOf('isoWeek');
    var view_end_date = last_date.endOf('isoWeek').startOf('day').add(1, 'day');

    var total_weeks = total_days > 0 ? Math.floor(last_date.diff(view_start_date, 'day') / 7) : 0;
    var baseline_week_hours = [];
    for (var i = 0; i <= total_weeks; i++) {
        baseline_week_hours[i] = 0;
    }

    var start_str = start_date.format('YYYY-MM-DD');
    var end_str = end_date.format('YYYY-MM-DD');
    var view_start_str = view_start_date.format('YYYY-MM-DD');
    var view_end_str = view_end_date.format('YYYY-MM-DD');

    var has_leading_boundary = false;
    var has_trailing_boundary = false;
    for (var b = 0; b < boundary_duties.length; b++) {
        var b_date = boundary_duties[b][0];
        if (b_date >= view_start_str && b_date < start_str) {
            has_leading_boundary = true;
        } else if (b_date >= end_str && b_date < view_end_str) {
            has_trailing_boundary = true;
        }
    }

    var calc_start = has_leading_boundary ? view_start_date : start_date;
    var calc_end = has_trailing_boundary ? view_end_date : end_date;

    var date_info_map = {};

    for (var cur = calc_start; cur.isBefore(calc_end); cur = cur.add(1, 'day')) {
        var date_str = cur.format('YYYY-MM-DD');
        var week_no = Math.floor(cur.diff(view_start_date, 'day') / 7);
        var is_hol = is_holiday(preset_holidays, date_str);
        var is_wknd = is_weekend(date_str);

        // Baseline: 8 hours for non-holiday weekdays
        if (!is_hol && !is_wknd) {
            baseline_week_hours[week_no] += 8;
        }

        // Duty hours: 24 hours for holiday/weekend, 16 hours for regular weekday
        var duty_hours = (is_hol || is_wknd) ? 24 : 16;

        // PM off deduction: 4 hours on next_date's week if next day is a non-holiday weekday
        var next_date = cur.add(1, 'day');
        var next_date_str = next_date.format('YYYY-MM-DD');
        var next_is_hol = is_holiday(preset_holidays, next_date_str);
        var next_is_wknd = is_weekend(next_date_str);
        var pm_off_deduction = (!next_is_hol && !next_is_wknd) ? 4 : 0;
        var pm_off_week_no = Math.floor(next_date.diff(view_start_date, 'day') / 7);

        date_info_map[date_str] = {
            week_no: week_no,
            duty_hours: duty_hours,
            pm_off_deduction: pm_off_deduction,
            pm_off_week_no: pm_off_week_no,
        };
    }

    // Pre-accumulate adjacent boundary duty hours per person
    var person_boundary_hours = {};
    var person_boundary_hours_pm_off = {};
    for (var k = 0; k < boundary_duties.length; k++) {
        var bd_str = boundary_duties[k][0];
        var bd_person = String(boundary_duties[k][1]);
        var bd_info = date_info_map[bd_str];
        if (bd_info) {
            if (!person_boundary_hours[bd_person]) {
                person_boundary_hours[bd_person] = new Array(total_weeks + 1).fill(0);
                person_boundary_hours_pm_off[bd_person] = new Array(total_weeks + 1).fill(0);
            }
            person_boundary_hours[bd_person][bd_info.week_no] += bd_info.duty_hours;
            person_boundary_hours_pm_off[bd_person][bd_info.week_no] += bd_info.duty_hours;
            if (bd_info.pm_off_deduction > 0 && bd_info.pm_off_week_no >= 0 && bd_info.pm_off_week_no <= total_weeks) {
                person_boundary_hours_pm_off[bd_person][bd_info.pm_off_week_no] -= bd_info.pm_off_deduction;
            }
        } else {
            // Even if leading boundary had no duties in Week 0, e.g. Oct 31 was Sunday before Nov 1 Monday:
            // Wait: if Oct 31 was Sunday (2027-10-31) and Nov 1 is Monday (Week 0 of Nov), Sunday night duty gives Monday PM Off!
            var prev_sun_next = dayjs(bd_str).add(1, 'day');
            var prev_sun_next_str = prev_sun_next.format('YYYY-MM-DD');
            if (prev_sun_next_str === start_str && !is_holiday(preset_holidays, prev_sun_next_str) && !is_weekend(prev_sun_next_str)) {
                if (!person_boundary_hours[bd_person]) {
                    person_boundary_hours[bd_person] = new Array(total_weeks + 1).fill(0);
                    person_boundary_hours_pm_off[bd_person] = new Array(total_weeks + 1).fill(0);
                }
                person_boundary_hours_pm_off[bd_person][0] -= 4;
            }
        }
    }

    return {
        baseline_week_hours: baseline_week_hours,
        date_info_map: date_info_map,
        total_weeks: total_weeks,
        use_pm_off: use_pm_off,
        since_date_str: since_date_str,
        total_days: total_days,
        preset_holidays: preset_holidays,
        person_boundary_hours: person_boundary_hours,
        person_boundary_hours_pm_off: person_boundary_hours_pm_off,
    };
}

/**
 * Calculate weekly work hours and PM off weekly work hours for a person's duty dates.
 * @param {string[]} dates Array of duty date strings (YYYY-MM-DD).
 * @param {Object} [options={}] Context or configuration options.
 * @param {string|number} [person_id] Optional person identifier to merge boundary duty hours.
 * @return {Object} Object with week_hours and week_hours_pm_off arrays.
 */
export function calculate_person_week_hours(dates, options = {}, person_id = undefined) {
    var context;
    if (options && options.baseline_week_hours && options.date_info_map) {
        context = options;
    } else {
        var preset_holidays = options.preset_holidays || [];
        var since_date_str = options.since_date_str;
        var total_days = options.total_days;
        var boundary_duties = options.boundary_duties || [];

        if (!since_date_str || !total_days) {
            if (dates && dates.length > 0) {
                var sorted = dates.slice().sort();
                var min_m = dayjs(sorted[0]).startOf('month');
                var max_m = dayjs(sorted[sorted.length - 1]).endOf('month').startOf('day');
                since_date_str = since_date_str || min_m.format('YYYY-MM-DD');
                total_days = total_days || max_m.diff(min_m, 'day') + 1;
            } else {
                return { week_hours: [], week_hours_pm_off: [] };
            }
        }
        context = prepare_week_hours_context(since_date_str, total_days, preset_holidays, true, boundary_duties);
    }

    var week_hours = context.baseline_week_hours.slice();
    var week_hours_pm_off = context.baseline_week_hours.slice();

    if (person_id !== undefined && context.person_boundary_hours) {
        var p_key = String(person_id);
        var b_h = context.person_boundary_hours[p_key];
        var b_pm = context.person_boundary_hours_pm_off[p_key];
        if (b_h && b_pm) {
            for (var bw = 0; bw < week_hours.length; bw++) {
                week_hours[bw] += b_h[bw];
                week_hours_pm_off[bw] += b_pm[bw];
            }
        }
    }

    if (dates && dates.length > 0) {
        for (var i = 0; i < dates.length; i++) {
            var info = context.date_info_map[dates[i]];
            if (info) {
                week_hours[info.week_no] += info.duty_hours;
                week_hours_pm_off[info.week_no] += info.duty_hours;
                if (info.pm_off_deduction > 0 && info.pm_off_week_no >= 0 && info.pm_off_week_no <= context.total_weeks) {
                    week_hours_pm_off[info.pm_off_week_no] -= info.pm_off_deduction;
                }
            }
        }
    }

    return {
        week_hours: week_hours,
        week_hours_pm_off: week_hours_pm_off,
    };
}

/**
 * Check if group_duties are within the max weekly work hours limit.
 * @param {Object} group_duties The duties grouped by person.
 * @param {number|string} max_hours The maximum allowed weekly work hours.
 * @param {Object|Array} [options={}] Options object or preset_holidays array.
 * @return {boolean} True if all persons' weekly work hours are <= max_hours, false otherwise.
 */
export function less_than_max_week_hours(group_duties, max_hours, options = {}) {
    var max_limit = parseInt(max_hours, 10);
    if (isNaN(max_limit)) {
        return true;
    }

    var context;
    if (options && options.baseline_week_hours && options.date_info_map) {
        context = options;
    } else {
        var preset_holidays = [];
        var since_date_str;
        var total_days;
        var use_pm_off = true;
        var boundary_duties = [];

        if (Array.isArray(options)) {
            preset_holidays = options;
            since_date_str = arguments[3];
            total_days = arguments[4];
            if (arguments[5] !== undefined) {
                use_pm_off = arguments[5];
            }
        } else if (typeof options === 'object') {
            preset_holidays = options.preset_holidays || [];
            since_date_str = options.since_date_str;
            total_days = options.total_days;
            boundary_duties = options.boundary_duties || [];
            if (options.use_pm_off !== undefined) {
                use_pm_off = options.use_pm_off;
            }
        }

        if (!since_date_str || !total_days) {
            var all_dates = [];
            for (var p in group_duties) {
                if ({}.hasOwnProperty.call(group_duties, p) && group_duties[p].dates) {
                    all_dates = all_dates.concat(group_duties[p].dates);
                }
            }
            if (all_dates.length === 0) {
                return true;
            }
            all_dates.sort();
            var min_m = dayjs(all_dates[0]).startOf('month');
            var max_m = dayjs(all_dates[all_dates.length - 1]).endOf('month').startOf('day');
            since_date_str = since_date_str || min_m.format('YYYY-MM-DD');
            total_days = total_days || max_m.diff(min_m, 'day') + 1;
        }

        context = prepare_week_hours_context(since_date_str, total_days, preset_holidays, use_pm_off, boundary_duties);
    }

    var baseline = context.baseline_week_hours;
    var date_info = context.date_info_map;
    var use_pm_off = context.use_pm_off !== undefined ? context.use_pm_off : true;

    for (var person in group_duties) {
        if ({}.hasOwnProperty.call(group_duties, person)) {
            var dates = group_duties[person].dates;
            if ((!dates || dates.length === 0) && (!context.person_boundary_hours || !context.person_boundary_hours[String(person)])) {
                continue;
            }

            var person_week_hours = baseline.slice();
            var p_key = String(person);
            if (context.person_boundary_hours && context.person_boundary_hours[p_key]) {
                var b_arr = use_pm_off ? context.person_boundary_hours_pm_off[p_key] : context.person_boundary_hours[p_key];
                for (var bw = 0; bw < person_week_hours.length; bw++) {
                    person_week_hours[bw] += b_arr[bw];
                }
            }

            if (dates) {
                for (var i = 0; i < dates.length; i++) {
                    var d_str = dates[i];
                    var info = date_info[d_str];
                    if (info) {
                        person_week_hours[info.week_no] += info.duty_hours;
                        if (use_pm_off && info.pm_off_deduction > 0 && info.pm_off_week_no >= 0 && info.pm_off_week_no <= context.total_weeks) {
                            person_week_hours[info.pm_off_week_no] -= info.pm_off_deduction;
                        }
                    }
                }
            }

            for (var w = 0; w < person_week_hours.length; w++) {
                if (person_week_hours[w] > max_limit) {
                    return false;
                }
            }
        }
    }

    return true;
}

/**
 * Check if group_duties are within the QOD limit or not.
 * @param {Object[]} group_duties The duties grouped.
 * @param {number} qod_limit The second number.
 * @return {boolean} The sum of the two numbers.
 */
export function less_than_qod_times(group_duties, qod_limit) {
    for (var person in group_duties) {
        if ({}.hasOwnProperty.call(group_duties, person)) {
            var qod_times = multiIndexOf(group_duties[person].intervals, 2).length;
            if (qod_times > parseInt(qod_limit, 10)) {
                // console.log("qod_times: " + qod_times + ", intervals: " + group_duties[person].intervals.toString());
                return false;
            }
        }
    }

    return true;
}

/**
 * Check if group_duties have continuous duties or not.
 * @param {Object[]} group_duties The duties grouped.
 * @return {boolean} has or has no continuous duties.
 */
export function has_continuous_duties(group_duties) {
    for (var person in group_duties) {
        if ({}.hasOwnProperty.call(group_duties, person)) {
            var qd_times = multiIndexOf(group_duties[person].intervals, 1).length;
            if (qd_times > 0) {
                // console.log("qd_times: " + qd_times + ", intervals: " + group_duties[person].intervals.toString());
                return true;
            }
        }
    }
    return false;
}

/**
 * Check if candidate group_duties violate QD (consecutive duty) or QOD limit against adjacent month boundary duties.
 * @param {Object} group_duties Candidate duties grouped by person (dates sorted ascending).
 * @param {Array<[string, number]>} [boundary_duties=[]] Adjacent duties outside current month range.
 * @param {boolean} [use_qod_limit=false] Whether QOD limit is enabled.
 * @param {number} [qod_limit=1] Maximum allowed QOD occurrences.
 * @return {boolean} True if there IS a conflict (QD or exceeded QOD), false if valid.
 */
export function has_boundary_conflict(group_duties, boundary_duties = [], use_qod_limit = false, qod_limit = 1) {
    if (!boundary_duties || boundary_duties.length === 0) {
        return false;
    }

    var parsedLimit = parseInt(qod_limit, 10);
    var boundaryByPerson = {};
    for (var i = 0; i < boundary_duties.length; i++) {
        var bDate = boundary_duties[i][0];
        var bPerson = String(boundary_duties[i][1]);
        if (!boundaryByPerson[bPerson]) {
            boundaryByPerson[bPerson] = [];
        }
        boundaryByPerson[bPerson].push(bDate);
    }

    for (var pKey in boundaryByPerson) {
        if ({}.hasOwnProperty.call(boundaryByPerson, pKey) && group_duties[pKey]) {
            var dates = group_duties[pKey].dates;
            if (!dates || dates.length === 0) continue;

            var combined = dates.concat(boundaryByPerson[pKey]).sort();
            var qodCount = 0;
            for (var j = 1; j < combined.length; j++) {
                var diff = dayjs(combined[j]).diff(dayjs(combined[j - 1]), 'day');
                if (diff === 1) {
                    return true; // Cross-month consecutive duty (QD)
                }
                if (diff === 2) {
                    qodCount++;
                    if (use_qod_limit && !isNaN(parsedLimit) && qodCount > parsedLimit) {
                        return true; // Cross-month QOD exceeded
                    }
                }
            }
        }
    }

    return false;
}
