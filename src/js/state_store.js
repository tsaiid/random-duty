import dayjs from './setup-dayjs.js';

/**
 * Generate unique deterministic event ID.
 * @param {string} type Event type ('duty', 'preset_duty', 'preset_non_duty', 'custom_holiday')
 * @param {string} date Date string (YYYY-MM-DD)
 * @param {string|number} title Person number or title
 * @return {string} Unique event ID
 */
export function generateEventId(type, date, title) {
    return `${type}_${date}_${encodeURIComponent(title)}`;
}

/**
 * Create a centralized, normalized schedule state store.
 * Serves as the Single Source of Truth instead of querying FullCalendar DOM elements.
 */
export function createScheduleStore() {
    const state = {
        currentMonth: dayjs().add(1, 'month').startOf('month'),
        monthSpan: 1, // 1 or 2
        people: 4,
        useQodLimit: true,
        qodLimit: 1,
        useWeekHoursLimit: true,
        weekHoursLimit: 80,
        autoSaveDraft: true,

        // Normalized schedule entities across all months
        dutyItems: [],              // [{ id, date, person, isPreset }]
        nonDutyItems: [],           // [{ id, date, person }]
        customHolidays: [],         // [{ id, date, title }]
        deletedHolidays: new Set(), // Set<eventId>
        officialHolidays: new Map(), // eventId -> { id, date, endDate, title }
        fetchedYears: new Set(),    // Set<yearNumber> for in-memory holiday cache

        customPatterns: {},         // { [patternKey]: [[o,f,h], ...] }
        sessionPatterns: {},        // { [patternKey]: { holidaySig, patterns } }
        staffNames: {},             // { [personNo]: '王醫師' } (used in Phase 3)
        highlightedPerson: null,    // number | null (used in Phase 3)

        // Undo / Redo history stack
        undoStack: [],
        redoStack: [],
    };

    function takeSnapshot() {
        return {
            dutyItems: state.dutyItems.map(item => ({ ...item })),
            nonDutyItems: state.nonDutyItems.map(item => ({ ...item })),
            customHolidays: state.customHolidays.map(item => ({ ...item })),
            deletedHolidays: Array.from(state.deletedHolidays),
            customPatterns: JSON.parse(JSON.stringify(state.customPatterns || {})),
        };
    }

    function applySnapshot(snap) {
        state.dutyItems = snap.dutyItems.map(item => ({ ...item }));
        state.nonDutyItems = snap.nonDutyItems.map(item => ({ ...item }));
        state.customHolidays = snap.customHolidays.map(item => ({ ...item }));
        state.deletedHolidays = new Set(snap.deletedHolidays);
        state.customPatterns = JSON.parse(JSON.stringify(snap.customPatterns || {}));
    }

    function pushUndo() {
        state.undoStack.push(takeSnapshot());
        if (state.undoStack.length > 25) {
            state.undoStack.shift();
        }
        state.redoStack = [];
    }

    function undo() {
        if (state.undoStack.length === 0) return false;
        state.redoStack.push(takeSnapshot());
        const prev = state.undoStack.pop();
        applySnapshot(prev);
        return true;
    }

    function redo() {
        if (state.redoStack.length === 0) return false;
        state.undoStack.push(takeSnapshot());
        const next = state.redoStack.pop();
        applySnapshot(next);
        return true;
    }

    function getDateRange() {
        const start_date = state.currentMonth.clone().startOf('month');
        const end_date = start_date.clone().add(state.monthSpan, 'month');
        return {
            start_date,
            end_date,
            startStr: start_date.format('YYYY-MM-DD'),
            endStr: end_date.format('YYYY-MM-DD'),
            month_str: state.monthSpan === 1
                ? start_date.format('YYYY-MM')
                : `${start_date.format('YYYY-MM')}_${start_date.clone().add(1, 'month').format('YYYY-MM')}`,
        };
    }

    function getHolidaysInRange() {
        const range = getDateRange();
        const minDateStr = range.start_date.startOf('isoWeek').format('YYYY-MM-DD');
        const maxDateStr = range.end_date.endOf('isoWeek').format('YYYY-MM-DD');
        const holidays = new Set();

        state.customHolidays.forEach(h => {
            if (h.date >= minDateStr && h.date <= maxDateStr) {
                holidays.add(h.date);
            }
        });

        state.officialHolidays.forEach((val, id) => {
            if (!state.deletedHolidays.has(id) && val.date >= minDateStr && val.date <= maxDateStr) {
                holidays.add(val.date);
            }
        });

        return Array.from(holidays).sort();
    }

    function getPresetDuties({ inRangeOnly = true } = {}) {
        const { startStr, endStr } = getDateRange();
        return state.dutyItems
            .filter(item => item.isPreset && (!inRangeOnly || (item.date >= startStr && item.date < endStr)))
            .map(item => [item.date, item.person])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    }

    function getGeneratedDuties({ inRangeOnly = true } = {}) {
        const { startStr, endStr } = getDateRange();
        return state.dutyItems
            .filter(item => !item.isPreset && (!inRangeOnly || (item.date >= startStr && item.date < endStr)))
            .map(item => [item.date, item.person])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    }

    function getAllDuties({ inRangeOnly = true } = {}) {
        const { startStr, endStr } = getDateRange();
        return state.dutyItems
            .filter(item => !inRangeOnly || (item.date >= startStr && item.date < endStr))
            .map(item => [item.date, item.person])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    }

    function getPresetNonDuties({ inRangeOnly = true } = {}) {
        const { startStr, endStr } = getDateRange();
        return state.nonDutyItems
            .filter(item => !inRangeOnly || (item.date >= startStr && item.date < endStr))
            .map(item => [item.date, item.person])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    }

    function getBoundaryDuties() {
        const range = getDateRange();
        const lastDate = range.end_date.subtract(1, 'day');
        const leadingMin = dayjs(
            Math.min(
                range.start_date.startOf('isoWeek').valueOf(),
                range.start_date.subtract(2, 'day').valueOf()
            )
        ).format('YYYY-MM-DD');
        const trailingMax = dayjs(
            Math.max(
                lastDate.endOf('isoWeek').startOf('day').add(1, 'day').valueOf(),
                range.end_date.add(2, 'day').valueOf()
            )
        ).format('YYYY-MM-DD');

        return state.dutyItems
            .filter(item =>
                (item.date >= leadingMin && item.date < range.startStr) ||
                (item.date >= range.endStr && item.date < trailingMax)
            )
            .map(item => [item.date, item.person])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    }

    function getSameDayScheduleEvents(dateStr, excludeId = '') {
        const out = [];
        state.dutyItems.forEach(item => {
            if (item.date === dateStr && item.id !== excludeId) {
                out.push({
                    id: item.id,
                    person: item.person,
                    title: String(item.person),
                    isPreset: item.isPreset,
                    className: [item.isPreset ? 'preset-duty-event' : 'duty-event'],
                });
            }
        });
        state.nonDutyItems.forEach(item => {
            if (item.date === dateStr && item.id !== excludeId) {
                out.push({
                    id: item.id,
                    person: item.person,
                    title: String(item.person),
                    className: ['preset-non-duty-event'],
                });
            }
        });
        return out;
    }

    function removeById(id) {
        if (!id) return;
        state.dutyItems = state.dutyItems.filter(item => item.id !== id);
        state.nonDutyItems = state.nonDutyItems.filter(item => item.id !== id);
        const beforeCustomLen = state.customHolidays.length;
        state.customHolidays = state.customHolidays.filter(h => h.id !== id);
        if (state.customHolidays.length === beforeCustomLen && state.officialHolidays.has(id)) {
            state.deletedHolidays.add(id);
        }
    }

    function addDutyItem({ date, person, isPreset = false }) {
        const p = parseInt(person, 10);
        const prefix = isPreset ? 'preset_duty' : 'duty';
        const id = generateEventId(prefix, date, p);
        state.dutyItems = state.dutyItems.filter(item => item.id !== id);
        state.dutyItems.push({ id, date, person: p, isPreset });
        return id;
    }

    function addNonDutyItem({ date, person }) {
        const p = parseInt(person, 10);
        const id = generateEventId('preset_non_duty', date, p);
        if (!state.nonDutyItems.some(item => item.id === id)) {
            state.nonDutyItems.push({ id, date, person: p });
        }
        return id;
    }

    function addCustomHoliday({ date, title }) {
        const cleanTitle = (title || '自訂').trim().replace(/^假日\s*/, '') || '自訂';
        const id = generateEventId('custom_holiday', date, cleanTitle);
        state.customHolidays = state.customHolidays.filter(h => h.id !== id);
        state.customHolidays.push({ id, date, title: cleanTitle });
        return id;
    }

    function replaceGeneratedDutiesInRange(startStr, endStr, allRangeDuties) {
        const presetKeys = new Set(
            state.dutyItems
                .filter(item => item.isPreset && item.date >= startStr && item.date < endStr)
                .map(item => `${item.date}_${item.person}`)
        );
        // Remove only auto-generated duties in [startStr, endStr)
        state.dutyItems = state.dutyItems.filter(
            item => item.isPreset || item.date < startStr || item.date >= endStr
        );
        allRangeDuties.forEach(([dStr, pNo]) => {
            const p = parseInt(pNo, 10);
            if (!presetKeys.has(`${dStr}_${p}`)) {
                const id = generateEventId('duty', dStr, p);
                state.dutyItems.push({ id, date: dStr, person: p, isPreset: false });
            }
        });
    }

    function clearGeneratedDutiesInRange(startStr, endStr) {
        state.dutyItems = state.dutyItems.filter(
            item => item.isPreset || item.date < startStr || item.date >= endStr
        );
    }

    function resetAll() {
        state.people = 4;
        state.monthSpan = 1;
        state.useQodLimit = true;
        state.qodLimit = 1;
        state.useWeekHoursLimit = true;
        state.weekHoursLimit = 80;
        state.autoSaveDraft = true;
        state.currentMonth = dayjs().add(1, 'month').startOf('month');
        state.dutyItems = [];
        state.nonDutyItems = [];
        state.customHolidays = [];
        state.deletedHolidays.clear();
        state.customPatterns = {};
        state.sessionPatterns = {};
        state.staffNames = {};
        state.highlightedPerson = null;
        state.undoStack = [];
        state.redoStack = [];
    }

    function hydrateFromDraft(draft) {
        if (!draft) return;
        if (draft.currentMonth) {
            state.currentMonth = dayjs(draft.currentMonth).startOf('month');
        }
        state.deletedHolidays = new Set(Array.isArray(draft.deletedHolidays) ? draft.deletedHolidays : []);
        state.customHolidays = [];
        if (Array.isArray(draft.customHolidays)) {
            const seen = new Set();
            draft.customHolidays.forEach(h => {
                if (!h || !h.id || seen.has(h.id)) return;
                seen.add(h.id);
                const cleanTitle = (h.title || '').replace(/^假日\s*/, '') || '自訂';
                state.customHolidays.push({ id: h.id, date: h.date, title: cleanTitle });
            });
        }

        state.dutyItems = [];
        if (Array.isArray(draft.presetDuties)) {
            draft.presetDuties.forEach(([dStr, pNo]) => {
                addDutyItem({ date: dStr, person: pNo, isPreset: true });
            });
        }
        if (Array.isArray(draft.generatedDuties)) {
            draft.generatedDuties.forEach(([dStr, pNo]) => {
                const p = parseInt(pNo, 10);
                const hasPreset = state.dutyItems.some(item => item.isPreset && item.date === dStr && item.person === p);
                if (!hasPreset) {
                    addDutyItem({ date: dStr, person: p, isPreset: false });
                }
            });
        }

        state.nonDutyItems = [];
        if (Array.isArray(draft.presetNonDuties)) {
            draft.presetNonDuties.forEach(([dStr, pNo]) => {
                addNonDutyItem({ date: dStr, person: pNo });
            });
        }

        state.customPatterns = (draft.customPatterns && typeof draft.customPatterns === 'object')
            ? { ...draft.customPatterns }
            : {};
        if (draft.staffNames && typeof draft.staffNames === 'object') {
            state.staffNames = { ...draft.staffNames };
        }
        state.undoStack = [];
        state.redoStack = [];
    }

    function toDraftPayload() {
        return {
            currentMonth: state.currentMonth.format('YYYY-MM-01'),
            deletedHolidays: Array.from(state.deletedHolidays),
            customHolidays: state.customHolidays.map(h => ({ ...h })),
            presetDuties: getPresetDuties({ inRangeOnly: false }),
            presetNonDuties: getPresetNonDuties({ inRangeOnly: false }),
            generatedDuties: getGeneratedDuties({ inRangeOnly: false }),
            customPatterns: state.customPatterns || {},
            staffNames: state.staffNames || {},
        };
    }

    return {
        state,
        pushUndo,
        undo,
        redo,
        getDateRange,
        getHolidaysInRange,
        getPresetDuties,
        getGeneratedDuties,
        getAllDuties,
        getPresetNonDuties,
        getBoundaryDuties,
        getSameDayScheduleEvents,
        removeById,
        addDutyItem,
        addNonDutyItem,
        addCustomHoliday,
        replaceGeneratedDutiesInRange,
        clearGeneratedDutiesInRange,
        resetAll,
        hydrateFromDraft,
        toDraftPayload,
    };
}
