import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import Modal from 'bootstrap/js/dist/modal.js';
import Toast from 'bootstrap/js/dist/toast.js';
import 'bootstrap/js/dist/collapse.js';
import dayjs from './setup-dayjs.js';
import {
    loadPreferences,
    savePreferences,
    loadDraft,
    saveDraft,
    clearAllStorage,
} from './lib_storage.js';
import {
    is_holiday,
    is_friday,
    is_weekend,
} from './lib_holidays.js';
import {
    calculate_group_duties,
    calculate_group_duties_status,
    get_drop_conflict_status,
    get_duty_color,
    get_duty_text_color,
    format_person_label,
    generate_balanced_pattern,
    calculate_pattern_points,
    validate_presets_for_schedule,
    calculate_max_continuous_workdays,
    validate_duties_for_export,
    detect_schedule_violations,
} from './lib_duties.js';
import {
    less_than_qod_times,
    has_continuous_duties,
    less_than_max_week_hours,
    prepare_week_hours_context,
    calculate_person_week_hours,
    has_boundary_conflict,
} from './lib_filters.js';
import { createScheduleStore } from './state_store.js';
import {
    downloadScheduleScreenshot,
    exportScheduleToExcel,
    exportScheduleBackupJson,
    parseScheduleBackupFile,
} from './exporters.js';

const API_GATEWAY_BASE = import.meta.env?.VITE_API_GATEWAY_URL || 'https://api.tsai.it';

const store = createScheduleStore();
const { state } = store;

// Calendar & Worker runtime instances
let cal1 = null;
let cal2 = null;
let activeWorker = null;
const inflightHolidayYears = new Map();

// Bootstrap Modal instances
let calEventModal = null;
let editPatternModal = null;
let dialogModal = null;
let staffNamesModal = null;

/**
 * Escape text safely before inserting into HTML templates.
 * @param {*} str Raw text
 * @return {string} HTML-escaped string
 */
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Format person label using current state.staffNames.
 * @param {number|string} personNo
 * @param {boolean} [full=false]
 * @return {string}
 */
function personLabel(personNo, full = false) {
    return format_person_label(personNo, state.staffNames, { full });
}

/**
 * Display a Toast notification in the top-right container.
 * @param {'success'|'warning'|'error'|'info'} type Notification type
 * @param {string} title Toast title
 * @param {string} message Toast content message
 */
function showToast(type, title, message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    let iconClass = 'bi-info-circle-fill text-primary';
    if (type === 'success') iconClass = 'bi-check-circle-fill text-success';
    if (type === 'warning') iconClass = 'bi-exclamation-triangle-fill text-warning';
    if (type === 'error') iconClass = 'bi-x-circle-fill text-danger';

    const toastEl = document.createElement('div');
    toastEl.className = 'toast show border-0 shadow mb-2';
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');

    toastEl.innerHTML = `
        <div class="toast-header bg-white border-bottom-0">
            <i class="bi ${iconClass} me-2 fs-6"></i>
            <strong class="me-auto">${escapeHtml(title)}</strong>
            <small class="text-muted">剛剛</small>
            <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body py-2 px-3 text-secondary small">
            ${escapeHtml(message)}
        </div>
    `;

    container.appendChild(toastEl);
    const bsToast = new Toast(toastEl, { delay: 4000 });
    bsToast.show();

    toastEl.addEventListener('hidden.bs.toast', () => {
        toastEl.remove();
    });
}

/**
 * Show a warning modal dialog.
 * @param {string} message Warning message
 * @param {string} [title='注意事項'] Dialog title
 */
function showWarningModal(message, title = '注意事項') {
    const titleEl = document.getElementById('dialogModalTitle');
    const bodyEl = document.getElementById('dialogModalBody');
    const cancelBtn = document.getElementById('dialogModalCancel');
    const confirmBtn = document.getElementById('dialogModalConfirm');

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
        bodyEl.innerHTML = `<div class="d-flex align-items-center text-secondary"><i class="bi bi-exclamation-circle text-warning fs-3 me-3"></i><div style="white-space: pre-line;">${escapeHtml(message)}</div></div>`;
    }
    if (cancelBtn) {
        cancelBtn.classList.add('d-none');
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = null;
    }
    if (confirmBtn) {
        confirmBtn.className = 'btn btn-primary btn-sm px-4';
        confirmBtn.textContent = '確定';
        confirmBtn.onclick = () => dialogModal.hide();
    }

    dialogModal.show();
}

/**
 * Show a confirmation modal dialog.
 * @param {Object} options Configuration options
 */
function showConfirmModal({
    title = '確認操作',
    message,
    confirmText = '確定',
    cancelText = '取消',
    confirmClass = 'btn-danger',
    onConfirm,
    onCancel,
}) {
    const titleEl = document.getElementById('dialogModalTitle');
    const bodyEl = document.getElementById('dialogModalBody');
    const cancelBtn = document.getElementById('dialogModalCancel');
    const confirmBtn = document.getElementById('dialogModalConfirm');

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
        bodyEl.innerHTML = `<div class="text-secondary leading-relaxed" style="white-space: pre-line;">${escapeHtml(message)}</div>`;
    }
    if (cancelBtn) {
        cancelBtn.classList.remove('d-none');
        cancelBtn.textContent = cancelText;
        cancelBtn.onclick = () => {
            if (typeof onCancel === 'function') onCancel();
        };
    }
    if (confirmBtn) {
        confirmBtn.className = `btn ${confirmClass} btn-sm px-4`;
        confirmBtn.textContent = confirmText;
        confirmBtn.onclick = () => {
            dialogModal.hide();
            if (typeof onConfirm === 'function') onConfirm();
        };
    }

    dialogModal.show();
}

/**
 * Update Undo / Redo button states and active person highlight badge.
 */
function updateToolbarStateButtons() {
    const undoBtn = document.getElementById('btn_undo');
    const redoBtn = document.getElementById('btn_redo');
    if (undoBtn) undoBtn.disabled = state.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;

    const filterBtn = document.getElementById('active_person_filter_btn');
    const filterLabel = document.getElementById('active_person_filter_label');
    if (filterBtn && filterLabel) {
        if (state.highlightedPerson !== null) {
            filterBtn.classList.remove('d-none');
            filterLabel.textContent = personLabel(state.highlightedPerson, true);
        } else {
            filterBtn.classList.add('d-none');
        }
    }
}

/**
 * Toggle highlight filter for a specific person number.
 * @param {number|null} personNo
 */
function toggleHighlightPerson(personNo) {
    const parsed = personNo !== null ? parseInt(personNo, 10) : null;
    state.highlightedPerson = (state.highlightedPerson === parsed) ? null : parsed;
    syncAllViews();
}

/**
 * Persist draft to localStorage if autoSaveDraft is enabled.
 */
function triggerAutoSaveDraft() {
    if (!state.autoSaveDraft) return;
    saveDraft(store.toDraftPayload());
}

/**
 * Refresh schedule-driven event sources on active FullCalendar instances.
 * @param {boolean} [includeOfficialHolidays=false]
 */
function refreshCalendars(includeOfficialHolidays = false) {
    [cal1, cal2].filter(Boolean).forEach(cal => {
        cal.getEventSourceById('schedule-state')?.refetch();
        if (includeOfficialHolidays) {
            cal.getEventSourceById('official-holidays')?.refetch();
        }
    });
}

/**
 * Refresh all derived UI views (calendar events, suggested patterns, summary dashboard, undo/filter toolbar).
 * @param {Object} [options]
 * @param {boolean} [options.includeOfficialHolidays=false]
 */
function syncAllViews({ includeOfficialHolidays = false } = {}) {
    updateToolbarStateButtons();
    refreshCalendars(includeOfficialHolidays);
    updateSuggestedPatterns();
    updateSummaryDuties(calculate_group_duties(store.getAllDuties()));
}

/**
 * Perform Undo action.
 */
function handleUndo() {
    if (store.undo()) {
        syncAllViews({ includeOfficialHolidays: true });
        triggerAutoSaveDraft();
        showToast('info', '已復原', '已還原至上一步排班狀態。');
    }
}

/**
 * Perform Redo action.
 */
function handleRedo() {
    if (store.redo()) {
        syncAllViews({ includeOfficialHolidays: true });
        triggerAutoSaveDraft();
        showToast('info', '已重做', '已重做排班變更。');
    }
}

/**
 * Ensure official holidays for a given calendar year are fetched once and cached in memory.
 * @param {number} year Calendar year (e.g. 2026)
 * @return {Promise<void>}
 */
function ensureOfficialHolidaysForYear(year) {
    if (state.fetchedYears.has(year)) {
        return Promise.resolve();
    }
    if (inflightHolidayYears.has(year)) {
        return inflightHolidayYears.get(year);
    }

    const timeMin = `${year}-01-01T00:00:00Z`;
    const timeMax = `${year}-12-31T23:59:59Z`;
    const url = `${API_GATEWAY_BASE}/api/calendar/taiwan-holidays?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;

    const reqPromise = fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (data && Array.isArray(data.items)) {
                data.items.forEach(item => {
                    if (item.description && item.description.includes('假日節慶')) {
                        return;
                    }
                    const startDate = item.start?.date || item.start?.dateTime?.slice(0, 10);
                    const endDate = item.end?.date || item.end?.dateTime?.slice(0, 10);
                    const holidayTitle = (item.summary || '').replace(/^假日\s*/, '');
                    if (startDate) {
                        state.officialHolidays.set(item.id, {
                            id: item.id,
                            date: startDate,
                            endDate: endDate || startDate,
                            title: holidayTitle,
                        });
                    }
                });
            }
            state.fetchedYears.add(year);
        })
        .finally(() => {
            inflightHolidayYears.delete(year);
        });

    inflightHolidayYears.set(year, reqPromise);
    return reqPromise;
}

/**
 * FullCalendar EventSource for official Taiwan holidays.
 */
async function fetchOfficialHolidaysSource(fetchInfo, successCallback, failureCallback) {
    const startYear = dayjs(fetchInfo.start).year();
    const endYear = dayjs(fetchInfo.end).year();
    const minStr = dayjs(fetchInfo.start).format('YYYY-MM-DD');
    const maxStr = dayjs(fetchInfo.end).format('YYYY-MM-DD');

    const prevHolidaySig = store.getHolidaysInRange().join(',');

    try {
        const years = [];
        for (let y = startYear; y <= endYear; y++) {
            years.push(ensureOfficialHolidaysForYear(y));
        }
        await Promise.all(years);

        const events = [];
        state.officialHolidays.forEach((item, id) => {
            if (state.deletedHolidays.has(id)) return;
            if (item.date < minStr || item.date > maxStr) return;

            events.push({
                id: `${id}_bg`,
                start: item.date,
                end: item.endDate,
                display: 'background',
                classNames: ['holiday-bg-event', 'gcal-holiday-bg'],
                allDay: true,
            });
            events.push({
                id,
                title: item.title,
                start: item.date,
                end: item.endDate,
                classNames: ['gcal-holiday', 'holiday-event'],
                allDay: true,
                editable: false,
                textColor: '#991b1b',
                backgroundColor: '#fee2e2',
                borderColor: '#fca5a5',
            });
        });

        successCallback(events);

        const nextHolidaySig = store.getHolidaysInRange().join(',');
        if (nextHolidaySig !== prevHolidaySig) {
            updateSuggestedPatterns();
            updateSummaryDuties(calculate_group_duties(store.getAllDuties()));
            refreshCalendars(false);
        }
    } catch (err) {
        console.error('Failed to load Taiwan holidays:', err);
        showToast('error', '假日資料載入失敗', '無法自國定假日服務同步假日資訊，請檢查網路連線。');
        if (typeof failureCallback === 'function') failureCallback(err);
    }
}

/**
 * FullCalendar EventSource derived synchronously from normalized schedule state.
 * Includes WCAG contrast text colors, preset/non-duty badges, highlight filters, and violation indicators.
 */
function buildScheduleStateEvents(fetchInfo, successCallback) {
    const minStr = dayjs(fetchInfo.start).format('YYYY-MM-DD');
    const maxStr = dayjs(fetchInfo.end).format('YYYY-MM-DD');
    const events = [];

    // Compute live constraint violations for current active range
    const range = store.getDateRange();
    const totalDays = range.end_date.diff(range.start_date, 'day');
    const presetHolidays = store.getHolidaysInRange();
    const boundaryDuties = store.getBoundaryDuties();
    const weekCtx = state.useWeekHoursLimit
        ? prepare_week_hours_context(range.startStr, totalDays, presetHolidays, true, boundaryDuties)
        : null;
    const violationsMap = detect_schedule_violations(store.getAllDuties(), {
        nonDuties: store.getPresetNonDuties(),
        boundaryDuties,
        useQodLimit: state.useQodLimit,
        qodLimit: state.qodLimit,
        useWeekHoursLimit: state.useWeekHoursLimit,
        maxWeekHours: state.weekHoursLimit,
        weekContext: weekCtx,
    });

    state.customHolidays.forEach(h => {
        if (h.date < minStr || h.date > maxStr) return;
        events.push({
            id: `${h.id}_bg`,
            start: h.date,
            display: 'background',
            classNames: ['holiday-bg-event', 'custom-holiday-bg'],
            allDay: true,
        });
        events.push({
            id: h.id,
            title: h.title,
            start: h.date,
            classNames: ['holiday-event', 'custom-holiday'],
            allDay: true,
            editable: false,
            textColor: '#991b1b',
            backgroundColor: '#fee2e2',
            borderColor: '#fca5a5',
        });
    });

    const hlPerson = state.highlightedPerson;

    state.dutyItems.forEach(item => {
        if (item.date < minStr || item.date > maxStr) return;
        const color = get_duty_color(item.person);
        const textColor = get_duty_text_color(color);
        const baseLabel = personLabel(item.person, false);
        const vReasons = violationsMap.get(`${item.date}_${item.person}`);
        const prefix = vReasons ? '⚠️ ' : (item.isPreset ? '📌 ' : '');

        const classes = [item.isPreset ? 'preset-duty-event' : 'duty-event'];
        if (vReasons) classes.push('duty-violation-warning');
        if (hlPerson !== null) {
            classes.push(item.person === hlPerson ? 'fc-event-highlighted' : 'fc-event-dimmed');
        }

        events.push({
            id: item.id,
            title: `${prefix}${baseLabel}`,
            start: item.date,
            allDay: true,
            classNames: classes,
            backgroundColor: color,
            borderColor: color,
            textColor,
            editable: true,
            extendedProps: {
                person: item.person,
                isPreset: item.isPreset,
                kind: 'duty',
                violationHint: vReasons ? `規則提醒：${vReasons.join('、')}` : (item.isPreset ? '預先鎖定值班' : ''),
            },
        });
    });

    state.nonDutyItems.forEach(item => {
        if (item.date < minStr || item.date > maxStr) return;
        const classes = ['preset-non-duty-event'];
        if (hlPerson !== null) {
            classes.push(item.person === hlPerson ? 'fc-event-highlighted' : 'fc-event-dimmed');
        }
        events.push({
            id: item.id,
            title: `✕ ${personLabel(item.person, false)}`,
            start: item.date,
            allDay: true,
            classNames: classes,
            editable: true,
            extendedProps: {
                person: item.person,
                kind: 'nonduty',
                violationHint: `${personLabel(item.person, true)} 本日設為不值`,
            },
        });
    });

    successCallback(events);
}

/**
 * Update the navigation toolbar text & title.
 */
function updateCalendarToolbar() {
    const titleEl = document.getElementById('calendar_range_title');
    if (!titleEl) return;

    if (state.monthSpan === 1) {
        titleEl.textContent = state.currentMonth.format('YYYY 年 M 月');
    } else {
        const nextMonth = state.currentMonth.clone().add(1, 'month');
        const sameYear = state.currentMonth.year() === nextMonth.year();
        titleEl.textContent = sameYear
            ? `${state.currentMonth.format('YYYY 年 M 月')} – ${nextMonth.format('M 月')}`
            : `${state.currentMonth.format('YYYY 年 M 月')} – ${nextMonth.format('YYYY 年 M 月')}`;
    }
}

/**
 * Calculate and render summary statistics table.
 * @param {Object} groups Duties grouped by person.
 */
function updateSummaryDuties(groups) {
    const summaryContainer = document.getElementById('summary_duties');
    if (!summaryContainer) return;

    if (!groups || Object.keys(groups).length === 0) {
        summaryContainer.innerHTML = '<div class="text-center text-muted py-4"><i class="bi bi-calendar-check fs-2 d-block mb-2 text-secondary opacity-50"></i>目前尚無排班資料，請點擊「自動排班」或於日曆上手動填入預排。</div>';
        return;
    }

    const presetHolidays = store.getHolidaysInRange();
    const dateRange = store.getDateRange();
    const totalDays = dateRange.end_date.diff(dateRange.start_date, 'day');
    const boundaryDuties = store.getBoundaryDuties();
    const weekContext = prepare_week_hours_context(dateRange.startStr, totalDays, presetHolidays, true, boundaryDuties);

    let html = `
        <div class="text-muted x-small mb-2"><i class="bi bi-hand-index-thumb me-1"></i>點擊任一人員列可於日曆高亮檢視該員班次分佈</div>
        <div class="table-responsive">
            <table class="table table-hover table-striped align-middle table-summary mb-0">
                <thead>
                    <tr>
                        <th class="text-start text-nowrap" style="min-width: 90px;">人員</th>
                        <th style="min-width: 150px; max-width: 260px;">值班日清單</th>
                        <th class="text-center text-nowrap" style="width: 120px;">班距</th>
                        <th class="text-center text-nowrap" style="min-width: 210px;">週工時</th>
                        <th class="text-center text-nowrap" style="min-width: 210px;">週工時 (PM Off)</th>
                        <th class="text-center text-nowrap" style="width: 95px;">最長連上日</th>
                        <th class="text-center text-nowrap" style="width: 70px;">QOD</th>
                        <th class="text-center text-nowrap" style="width: 95px;">班距標準差</th>
                    </tr>
                </thead>
                <tbody>
    `;

    const warnLimit = state.useWeekHoursLimit ? state.weekHoursLimit : 80;
    const dangerLimit = state.useWeekHoursLimit ? state.weekHoursLimit : 88;

    const sortedPeopleKeys = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
    for (const p of sortedPeopleKeys) {
        const pNum = parseInt(p, 10);
        const person = groups[p];
        const sortedDates = person.dates.slice().sort();
        const { week_hours: weekHours, week_hours_pm_off: weekHoursPmOff } = calculate_person_week_hours(sortedDates, weekContext, p);

        const dateBadges = sortedDates.map(d => {
            const cur = dayjs(d);
            let badgeClass = 'badge-ordinary';
            if (is_holiday(presetHolidays, d) || is_weekend(d)) {
                badgeClass = 'badge-holiday';
            } else if (is_friday(presetHolidays, d)) {
                badgeClass = 'badge-friday';
            }

            const label = state.monthSpan === 1 ? cur.format('D') : cur.format('M/D');
            return `<span class="badge ${badgeClass} me-1 mb-1 font-monospace">${label}</span>`;
        }).join('');

        let qodCount = 0;
        const intervalBadges = person.intervals.map(i => {
            let badgeClass = 'bg-light text-secondary border';
            if (i <= 2) {
                badgeClass = 'badge-danger-soft';
                if (i === 2) qodCount++;
            }
            return `<span class="badge ${badgeClass} me-1 font-monospace">${i}</span>`;
        }).join('');

        const renderHoursBadges = (hoursArr) => hoursArr.map(h => {
            let badgeClass = 'bg-light text-secondary border';
            if (h > dangerLimit) badgeClass = 'badge-danger-soft';
            else if (h >= warnLimit) badgeClass = 'badge-warning-soft';
            return `<span class="badge ${badgeClass} font-monospace">${h}</span>`;
        }).join('');

        const maxContinuous = calculate_max_continuous_workdays(sortedDates, dateRange.startStr, totalDays, presetHolidays);
        const maxContinuousBadge = maxContinuous > 12
            ? `<span class="badge badge-danger-soft font-monospace">${maxContinuous} 天</span>`
            : `<span class="text-muted font-monospace">${maxContinuous} 天</span>`;

        const qodExceeded = state.useQodLimit ? qodCount > state.qodLimit : qodCount > 0;
        const stdDev = person.std_dev ? person.std_dev.toFixed(2) : '0.00';
        const isHighlighted = state.highlightedPerson === pNum;

        html += `
            <tr class="person-row-interactive ${isHighlighted ? 'person-row-active' : ''}" data-highlight-person="${pNum}">
                <td class="text-start fw-bold text-nowrap">
                    <span class="color-dot" style="background-color: ${get_duty_color(p)};"></span>${escapeHtml(personLabel(p, false))}
                </td>
                <td class="duty-dates-cell">${dateBadges}</td>
                <td class="text-center text-nowrap">${intervalBadges || '<span class="text-muted">-</span>'}</td>
                <td class="text-center text-nowrap"><div class="hours-badges-group">${renderHoursBadges(weekHours)}</div></td>
                <td class="text-center text-nowrap"><div class="hours-badges-group">${renderHoursBadges(weekHoursPmOff)}</div></td>
                <td class="text-center text-nowrap">${maxContinuousBadge}</td>
                <td class="text-center text-nowrap"><span class="badge ${qodExceeded ? 'badge-danger-soft' : (qodCount > 0 ? 'badge-warning-soft' : 'bg-light text-muted border')}">${qodCount}</span></td>
                <td class="text-center text-nowrap font-monospace text-muted">${stdDev}</td>
            </tr>
        `;
    }

    html += `
                </tbody>
            </table>
        </div>
    `;

    summaryContainer.innerHTML = html;
    summaryContainer.querySelectorAll('tr[data-highlight-person]').forEach(row => {
        row.addEventListener('click', () => toggleHighlightPerson(row.dataset.highlightPerson));
    });
}

/**
 * Count ordinary, Friday, and holiday days in the active date range.
 */
function countRangeCategoryDays(presetHolidays) {
    const range = store.getDateRange();
    let ordinaryCount = 0;
    let fridayCount = 0;
    let holidayCount = 0;

    for (let cur = range.start_date.clone(); cur.isBefore(range.end_date); cur = cur.add(1, 'day')) {
        const dateStr = cur.format('YYYY-MM-DD');
        if (is_holiday(presetHolidays, dateStr) || is_weekend(dateStr)) {
            holidayCount++;
        } else if (is_friday(presetHolidays, dateStr)) {
            fridayCount++;
        } else {
            ordinaryCount++;
        }
    }
    return { ordinaryCount, fridayCount, holidayCount };
}

/**
 * Generate and render suggested duty patterns.
 */
function updateSuggestedPatterns({ forceRegenerate = false } = {}) {
    const range = store.getDateRange();
    const presetHolidays = store.getHolidaysInRange();
    const { ordinaryCount, fridayCount, holidayCount } = countRangeCategoryDays(presetHolidays);
    const presetDuties = store.getPresetDuties();
    const presetStatus = calculate_group_duties_status(
        calculate_group_duties(presetDuties),
        presetHolidays
    );
    const minPerPerson = Array.from({ length: state.people }, (_, idx) => {
        const ps = presetStatus[idx + 1];
        return ps ? [ps.ordinary_count || 0, ps.friday_count || 0, ps.holiday_count || 0] : [0, 0, 0];
    });
    const presetSig = JSON.stringify(minPerPerson);
    const dayCountsSig = `${ordinaryCount}_${fridayCount}_${holidayCount}_${presetSig}`;

    const patternKey = `${range.month_str}_${state.monthSpan}_${state.people}`;
    let patterns = null;

    if (!forceRegenerate && state.customPatterns && state.customPatterns[patternKey]) {
        const saved = state.customPatterns[patternKey];
        const sumSaved = saved.reduce(
            (acc, r) => [acc[0] + r[0], acc[1] + r[1], acc[2] + r[2]],
            [0, 0, 0]
        );
        const respectsPresets = saved.every((r, idx) =>
            r[0] >= minPerPerson[idx][0] && r[1] >= minPerPerson[idx][1] && r[2] >= minPerPerson[idx][2]
        );
        if (respectsPresets && sumSaved[0] === ordinaryCount && sumSaved[1] === fridayCount && sumSaved[2] === holidayCount) {
            patterns = saved;
        }
    }

    if (!patterns && !forceRegenerate && state.sessionPatterns[patternKey]?.dayCountsSig === dayCountsSig) {
        patterns = state.sessionPatterns[patternKey].patterns;
    }

    if (!patterns) {
        patterns = generate_balanced_pattern(state.people, ordinaryCount, fridayCount, holidayCount, minPerPerson);
        state.sessionPatterns[patternKey] = { dayCountsSig, patterns };
    }

    const container = document.getElementById('suggested_pattern_body');
    if (!container) return;

    container.dataset.patterns = JSON.stringify(patterns);
    container.dataset.patternKey = patternKey;

    let tableHtml = `
        <div class="table-responsive">
            <table class="table table-sm table-borderless align-middle mb-0 small text-center">
                <thead>
                    <tr class="text-muted border-bottom">
                        <th class="text-start">人員</th>
                        <th>平</th>
                        <th>五</th>
                        <th>假</th>
                        <th>積點 (P)</th>
                        <th>已排班數</th>
                    </tr>
                </thead>
                <tbody>
    `;

    const currentDuties = store.getAllDuties();
    const currentGroupStatus = calculate_group_duties_status(
        calculate_group_duties(currentDuties),
        presetHolidays
    );

    patterns.forEach((pat, idx) => {
        const personNo = idx + 1;
        const pts = calculate_pattern_points(pat);
        const personStatus = currentGroupStatus[personNo] || { ordinary_count: 0, friday_count: 0, holiday_count: 0 };
        const isMatched = (personStatus.ordinary_count === pat[0]) &&
                          (personStatus.friday_count === pat[1]) &&
                          (personStatus.holiday_count === pat[2]);

        const statusBadge = isMatched
            ? `<span class="badge bg-success-subtle text-success-emphasis font-monospace">${personStatus.ordinary_count}/${personStatus.friday_count}/${personStatus.holiday_count}</span>`
            : `<span class="badge badge-mismatch font-monospace">${personStatus.ordinary_count}/${personStatus.friday_count}/${personStatus.holiday_count}</span>`;

        const isHighlighted = state.highlightedPerson === personNo;

        tableHtml += `
            <tr class="border-bottom border-light person-row-interactive ${isHighlighted ? 'person-row-active' : ''}" data-highlight-person="${personNo}" title="點擊以高亮檢視此人員班表">
                <td class="text-start fw-bold text-nowrap">
                    <span class="color-dot" style="background-color: ${get_duty_color(personNo)};"></span>${escapeHtml(personLabel(personNo, false))}
                </td>
                <td class="font-monospace text-secondary">${pat[0]}</td>
                <td class="font-monospace text-secondary">${pat[1]}</td>
                <td class="font-monospace text-secondary">${pat[2]}</td>
                <td class="font-monospace fw-semibold text-primary">${pts}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    });

    tableHtml += `
                </tbody>
            </table>
        </div>
    `;

    container.innerHTML = tableHtml;
    container.querySelectorAll('tr[data-highlight-person]').forEach(row => {
        row.addEventListener('click', () => toggleHighlightPerson(row.dataset.highlightPerson));
    });
}

/**
 * Sync visibility of single-person dropdown vs multi-person checkboxes vs holiday input in Event Modal.
 */
function updateEventModalFieldVisibility() {
    const selectedCategory = document.querySelector('input[name="eventProp"]:checked')?.value || 'eventPropDuty';
    const isEditing = Boolean(document.getElementById('eventId').value);
    const endExclusive = document.getElementById('eventEndExclusive').value;
    const startStr = document.getElementById('eventStart').value;
    const isMultiDay = Boolean(endExclusive && dayjs(endExclusive).diff(dayjs(startStr), 'day') > 1);

    const dutyRadio = document.getElementById('eventPropDuty');
    if (dutyRadio) {
        // Multi-day drag cannot assign the same person consecutively (QD forbidden) -> guide to Non-duty or Holiday
        dutyRadio.disabled = isMultiDay;
    }

    const personGroup = document.getElementById('person_select_group');
    const multiCheckGroup = document.getElementById('multi_person_check_group');
    const holidayGroup = document.getElementById('holiday_input_group');

    if (selectedCategory === 'eventPropHoliday') {
        personGroup.classList.add('d-none');
        multiCheckGroup.classList.add('d-none');
        holidayGroup.classList.remove('d-none');
    } else if (selectedCategory === 'eventPropNonduty' && !isEditing) {
        personGroup.classList.add('d-none');
        multiCheckGroup.classList.remove('d-none');
        holidayGroup.classList.add('d-none');
    } else {
        personGroup.classList.remove('d-none');
        multiCheckGroup.classList.add('d-none');
        holidayGroup.classList.add('d-none');
    }
}

/**
 * Open the Event creation/editing Modal (supports single date and multi-day drag selection).
 * @param {Object} options Modal configuration options
 */
function openEventModal({ dateStr, endExclusiveStr = '', event = null }) {
    const modalTitle = document.getElementById('calEventModalLabel');
    const deleteBtn = document.getElementById('btn_delete_cal_event');
    const form = document.getElementById('calEventDialogForm');
    const personSelect = document.getElementById('eventTitleSelect');
    const multiCheckContainer = document.getElementById('multi_person_checkboxes');
    const holidayInput = document.getElementById('eventTitleInput');
    const eventOrigTitle = document.getElementById('eventOrigTitle');
    const eventStart = document.getElementById('eventStart');
    const eventEndExclusive = document.getElementById('eventEndExclusive');
    const eventId = document.getElementById('eventId');

    form.reset();
    const effectiveEnd = endExclusiveStr || dayjs(dateStr).add(1, 'day').format('YYYY-MM-DD');
    const spanDays = dayjs(effectiveEnd).diff(dayjs(dateStr), 'day');
    eventStart.value = dateStr;
    eventEndExclusive.value = effectiveEnd;

    // Populate single select & multi-person checkbox grid
    personSelect.innerHTML = '';
    multiCheckContainer.innerHTML = '';
    for (let i = 1; i <= state.people; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = personLabel(i, true);
        personSelect.appendChild(opt);

        const wrap = document.createElement('div');
        const chkId = `multi_nd_p_${i}`;
        wrap.innerHTML = `
            <input type="checkbox" class="btn-check multi-person-chk" id="${chkId}" value="${i}" autocomplete="off">
            <label class="btn btn-outline-secondary btn-sm w-100 text-truncate text-start" for="${chkId}">
                <span class="color-dot" style="background-color: ${get_duty_color(i)};"></span>${escapeHtml(personLabel(i, false))}
            </label>
        `;
        multiCheckContainer.appendChild(wrap);
    }

    if (event) {
        modalTitle.textContent = `編輯班表事件 (${dateStr})`;
        deleteBtn.classList.remove('d-none');
        eventOrigTitle.value = event.title;
        eventId.value = event.id;

        if (event.classNames.includes('preset-duty-event') || event.classNames.includes('duty-event')) {
            document.getElementById('eventPropDuty').checked = true;
            const pVal = event.extendedProps?.person ?? parseInt(event.title, 10);
            personSelect.value = String(pVal);
        } else if (event.classNames.includes('preset-non-duty-event')) {
            document.getElementById('eventPropNonduty').checked = true;
            const pVal = event.extendedProps?.person ?? parseInt(event.title, 10);
            personSelect.value = String(pVal);
        } else if (event.classNames.includes('holiday-event')) {
            document.getElementById('eventPropHoliday').checked = true;
            holidayInput.value = event.title.replace(/^假日\s*/, '');
        }
    } else {
        const endInclusiveStr = dayjs(effectiveEnd).subtract(1, 'day').format('YYYY-MM-DD');
        modalTitle.textContent = spanDays > 1
            ? `批次新增區間事件 (${dateStr} ~ ${endInclusiveStr}，共 ${spanDays} 天)`
            : `新增班表事件 (${dateStr})`;
        deleteBtn.classList.add('d-none');
        eventOrigTitle.value = '';
        eventId.value = '';

        if (spanDays > 1) {
            document.getElementById('eventPropNonduty').checked = true;
        } else {
            document.getElementById('eventPropDuty').checked = true;
        }
    }

    updateEventModalFieldVisibility();
    calEventModal.show();
}

/**
 * Handle saving event(s) from Event Modal.
 */
function handleSaveCalEvent() {
    const eventType = document.querySelector('input[name="eventProp"]:checked').value;
    const startStr = document.getElementById('eventStart').value;
    const endExclusiveStr = document.getElementById('eventEndExclusive').value || dayjs(startStr).add(1, 'day').format('YYYY-MM-DD');
    const existingId = document.getElementById('eventId').value;

    const datesList = [];
    for (let cur = dayjs(startStr); cur.isBefore(dayjs(endExclusiveStr)); cur = cur.add(1, 'day')) {
        datesList.push(cur.format('YYYY-MM-DD'));
    }

    if (eventType === 'eventPropDuty') {
        const dateStr = datesList[0];
        const person = parseInt(document.getElementById('eventTitleSelect').value, 10);
        const sameDayOthers = store.getSameDayScheduleEvents(dateStr, existingId);
        const existingDuty = sameDayOthers.find(
            e => e.className.includes('duty-event') || e.className.includes('preset-duty-event')
        );
        if (existingDuty) {
            showWarningModal(`該日期 (${dateStr}) 已有 ${personLabel(existingDuty.person, true)} 值班！`);
            return;
        }
        const conflict = get_drop_conflict_status(
            { title: String(person), className: ['preset-duty-event'] },
            sameDayOthers
        );
        if (conflict) {
            showWarningModal(conflict);
            return;
        }

        store.pushUndo();
        if (existingId) store.removeById(existingId);
        store.addDutyItem({ date: dateStr, person, isPreset: true });
    } else if (eventType === 'eventPropNonduty') {
        if (existingId) {
            const dateStr = datesList[0];
            const person = parseInt(document.getElementById('eventTitleSelect').value, 10);
            const sameDayOthers = store.getSameDayScheduleEvents(dateStr, existingId);
            const conflict = get_drop_conflict_status(
                { title: String(person), className: ['preset-non-duty-event'] },
                sameDayOthers
            );
            if (conflict) {
                showWarningModal(conflict);
                return;
            }
            store.pushUndo();
            store.removeById(existingId);
            store.addNonDutyItem({ date: dateStr, person });
        } else {
            const selectedPeople = Array.from(document.querySelectorAll('.multi-person-chk:checked'))
                .map(chk => parseInt(chk.value, 10));
            if (selectedPeople.length === 0) {
                showWarningModal('請至少勾選一位不值班人員！');
                return;
            }

            // Validate against existing duty conflicts across selected dates
            for (const dStr of datesList) {
                const sameDayOthers = store.getSameDayScheduleEvents(dStr);
                for (const p of selectedPeople) {
                    const hasDuty = sameDayOthers.some(
                        e => e.person === p && (e.className.includes('duty-event') || e.className.includes('preset-duty-event'))
                    );
                    if (hasDuty) {
                        showWarningModal(`${personLabel(p, true)} 於 ${dStr} 已設為值班，不可同時設為不值！`);
                        return;
                    }
                }
            }

            store.pushUndo();
            for (const dStr of datesList) {
                for (const p of selectedPeople) {
                    store.addNonDutyItem({ date: dStr, person: p });
                }
            }
        }
    } else if (eventType === 'eventPropHoliday') {
        const rawTitle = document.getElementById('eventTitleInput').value;
        store.pushUndo();
        if (existingId) store.removeById(existingId);
        for (const dStr of datesList) {
            store.addCustomHoliday({ date: dStr, title: rawTitle });
        }
    }

    calEventModal.hide();
    syncAllViews();
    triggerAutoSaveDraft();
}

/**
 * Handle deleting event from Event Modal.
 */
function handleDeleteCalEvent() {
    const existingId = document.getElementById('eventId').value;
    if (!existingId) return;

    store.pushUndo();
    store.removeById(existingId);

    calEventModal.hide();
    syncAllViews({ includeOfficialHolidays: true });
    triggerAutoSaveDraft();
}

/**
 * Open Staff Names configuration modal.
 */
function openStaffNamesModal() {
    const container = document.getElementById('staff_names_inputs');
    const bulkInput = document.getElementById('staff_bulk_paste');
    if (!container) return;
    if (bulkInput) bulkInput.value = '';

    let html = '';
    for (let i = 1; i <= state.people; i++) {
        const currentName = state.staffNames[String(i)] || '';
        html += `
            <div class="col-6">
                <div class="input-group input-group-sm">
                    <span class="input-group-text fw-semibold" style="min-width: 58px;">
                        <span class="color-dot" style="background-color: ${get_duty_color(i)};"></span>#${i}
                    </span>
                    <input type="text" class="form-control staff-name-input" data-person="${i}" value="${escapeHtml(currentName)}" maxlength="20" placeholder="人員 ${i} 姓名">
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
    staffNamesModal.show();
}

/**
 * Apply bulk-pasted staff names into the modal input fields.
 */
function handleApplyBulkStaffNames() {
    const raw = document.getElementById('staff_bulk_paste')?.value || '';
    const tokens = raw.split(/[,，、;\n\t\s]+/).map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) return;

    const inputs = document.querySelectorAll('#staff_names_inputs .staff-name-input');
    inputs.forEach((input, idx) => {
        if (tokens[idx] !== undefined) {
            input.value = tokens[idx];
        }
    });
}

/**
 * Save customized staff names.
 */
function handleSaveStaffNames() {
    const inputs = document.querySelectorAll('#staff_names_inputs .staff-name-input');
    const updated = { ...state.staffNames };
    inputs.forEach(input => {
        const p = input.dataset.person;
        const val = input.value.trim();
        if (val) {
            updated[p] = val;
        } else {
            delete updated[p];
        }
    });
    state.staffNames = updated;
    staffNamesModal.hide();
    syncAllViews();
    triggerAutoSaveDraft();
    showToast('success', '名單已更新', '人員顯示名稱已套用至日曆、統計表與匯出檔。');
}

/**
 * Shared FullCalendar options builder.
 */
function createCalendarOptions(initialDateStr) {
    return {
        plugins: [dayGridPlugin, interactionPlugin],
        initialView: 'dayGridMonth',
        initialDate: initialDateStr,
        headerToolbar: false,
        editable: true,
        droppable: false,
        selectable: true,
        longPressDelay: 350,
        eventLongPressDelay: 350,
        firstDay: 1,
        height: 'auto',
        eventSources: [
            { id: 'official-holidays', events: fetchOfficialHolidaysSource },
            { id: 'schedule-state', events: buildScheduleStateEvents },
        ],
        eventDidMount(info) {
            const hint = info.event.extendedProps?.violationHint;
            if (hint) {
                info.el.setAttribute('title', hint);
            }
        },
        dateClick(info) {
            openEventModal({ dateStr: info.dateStr });
        },
        select(info) {
            const spanDays = dayjs(info.endStr).diff(dayjs(info.startStr), 'day');
            if (spanDays > 1) {
                openEventModal({ dateStr: info.startStr, endExclusiveStr: info.endStr });
            }
            info.view.calendar.unselect();
        },
        eventClick(info) {
            const evt = info.event;
            if (evt.classNames.includes('gcal-holiday')) {
                showConfirmModal({
                    title: '刪除國定假日',
                    message: `確定要刪除「${evt.title}」嗎？刪除後該日將視為平日運算。`,
                    confirmText: '刪除假日',
                    onConfirm: () => {
                        store.pushUndo();
                        state.deletedHolidays.add(evt.id);
                        syncAllViews({ includeOfficialHolidays: true });
                        triggerAutoSaveDraft();
                    },
                });
            } else {
                openEventModal({ dateStr: dayjs(evt.start).format('YYYY-MM-DD'), event: evt });
            }
        },
        eventDrop(info) {
            const evt = info.event;
            const oldDateStr = dayjs(info.oldEvent.start).format('YYYY-MM-DD');
            const targetDateStr = dayjs(evt.start).format('YYYY-MM-DD');
            const sameDayOthers = store.getSameDayScheduleEvents(targetDateStr, evt.id);
            const person = evt.extendedProps?.person ?? parseInt(evt.title, 10);
            const isNonDuty = evt.classNames.includes('preset-non-duty-event');
            const isPreset = evt.classNames.includes('preset-duty-event');

            const pseudoEvent = {
                title: String(person),
                className: evt.classNames,
            };

            const conflict = get_drop_conflict_status(pseudoEvent, sameDayOthers);
            if (conflict) {
                showToast('warning', '班表衝突', conflict);
                info.revert();
                return;
            }

            // Check if dropping a duty onto another person's single duty -> offer 1-step Swap!
            const otherDutiesOnTarget = !isNonDuty
                ? sameDayOthers.filter(e => e.className.includes('duty-event') || e.className.includes('preset-duty-event'))
                : [];

            if (!isNonDuty && oldDateStr !== targetDateStr && otherDutiesOnTarget.length === 1 && otherDutiesOnTarget[0].person !== person) {
                const otherDuty = otherDutiesOnTarget[0];
                const applyOverlapOnly = () => {
                    store.pushUndo();
                    store.removeById(evt.id);
                    store.addDutyItem({ date: targetDateStr, person, isPreset });
                    syncAllViews();
                    triggerAutoSaveDraft();
                };

                showConfirmModal({
                    title: '是否直接互換班次？',
                    message: `${targetDateStr} 目前已由「${personLabel(otherDuty.person, true)}」值班。\n是否直接將兩人的班次對調（把「${personLabel(otherDuty.person, true)}」移至 ${oldDateStr}）？`,
                    confirmText: '直接互換班次',
                    cancelText: '僅並排於同日',
                    confirmClass: 'btn-primary',
                    onConfirm: () => {
                        const oldDayOthers = store.getSameDayScheduleEvents(oldDateStr, evt.id);
                        const reverseConflict = get_drop_conflict_status(
                            { title: String(otherDuty.person), className: otherDuty.className },
                            oldDayOthers
                        );
                        if (reverseConflict) {
                            showToast('warning', '無法互換班次', `${oldDateStr}：${reverseConflict}`);
                            info.revert();
                            return;
                        }
                        store.pushUndo();
                        store.removeById(evt.id);
                        store.removeById(otherDuty.id);
                        store.addDutyItem({ date: targetDateStr, person, isPreset });
                        store.addDutyItem({ date: oldDateStr, person: otherDuty.person, isPreset: Boolean(otherDuty.isPreset) });
                        syncAllViews();
                        triggerAutoSaveDraft();
                        showToast('success', '換班完成', `已對調 ${oldDateStr} 與 ${targetDateStr} 之值班人員。`);
                    },
                    onCancel: applyOverlapOnly,
                });
                return;
            }

            store.pushUndo();
            store.removeById(evt.id);
            if (isNonDuty) {
                store.addNonDutyItem({ date: targetDateStr, person });
            } else {
                store.addDutyItem({ date: targetDateStr, person, isPreset });
            }

            syncAllViews();
            triggerAutoSaveDraft();
        },
    };
}

/**
 * Initialize primary calendar.
 */
function initCalendars() {
    const cal1El = document.getElementById('cal1');
    cal1 = new Calendar(cal1El, createCalendarOptions(state.currentMonth.format('YYYY-MM-01')));
    cal1.render();
    updateCalendarToolbar();
}

/**
 * Lazily instantiate cal2 when switching to 2-month mode.
 */
function ensureSecondCalendar() {
    if (cal2) return;
    const cal2El = document.getElementById('cal2');
    if (!cal2El) return;
    const nextMonthStr = state.currentMonth.clone().add(1, 'month').format('YYYY-MM-01');
    cal2 = new Calendar(cal2El, createCalendarOptions(nextMonthStr));
    cal2.render();
}

/**
 * Switch month span (1 month vs 2 months).
 */
function setMonthSpan(span, { persist = true } = {}) {
    state.monthSpan = span;
    const mode1m = document.getElementById('mode_1m');
    const mode2m = document.getElementById('mode_2m');
    const firstCalCol = document.querySelector('.first_cal');
    const secondCalCol = document.querySelector('.second_cal');

    if (span === 2) {
        if (mode2m) mode2m.checked = true;
        if (firstCalCol) firstCalCol.className = 'col-12 col-xxl-6 first_cal';
        if (secondCalCol) secondCalCol.classList.remove('d-none');
        ensureSecondCalendar();
        if (cal2) {
            cal2.gotoDate(state.currentMonth.clone().add(1, 'month').format('YYYY-MM-01'));
            cal2.updateSize();
        }
    } else {
        if (mode1m) mode1m.checked = true;
        if (firstCalCol) firstCalCol.className = 'col-12 first_cal';
        if (secondCalCol) secondCalCol.classList.add('d-none');
    }

    if (cal1) cal1.updateSize();
    updateCalendarToolbar();
    syncAllViews();
    if (persist) {
        savePreferences({ mode_switch: span === 2 });
    }
}

/**
 * Navigate calendar month.
 */
function navigateMonth(delta) {
    state.currentMonth = state.currentMonth.add(delta, 'month');
    cal1.gotoDate(state.currentMonth.format('YYYY-MM-01'));
    if (cal2 && state.monthSpan === 2) {
        cal2.gotoDate(state.currentMonth.clone().add(1, 'month').format('YYYY-MM-01'));
    }
    updateCalendarToolbar();
    syncAllViews();
    triggerAutoSaveDraft();
}

/**
 * Reset calendars to default month (Next Month).
 */
function resetToDefaultMonth() {
    state.currentMonth = dayjs().add(1, 'month').startOf('month');
    cal1.gotoDate(state.currentMonth.format('YYYY-MM-01'));
    if (cal2 && state.monthSpan === 2) {
        cal2.gotoDate(state.currentMonth.clone().add(1, 'month').format('YYYY-MM-01'));
    }
    updateCalendarToolbar();
    syncAllViews();
    triggerAutoSaveDraft();
}

/**
 * Execute Web Worker background random duty solver.
 */
function executeRandomDuty() {
    const patternsData = document.getElementById('suggested_pattern_body')?.dataset?.patterns;
    if (!patternsData) {
        showWarningModal('請先產生建議排班樣式！');
        return;
    }

    const patterns = JSON.parse(patternsData);
    const range = store.getDateRange();
    const totalDays = range.end_date.diff(range.start_date, 'day');
    const presetHolidays = store.getHolidaysInRange();
    const presetDuties = store.getPresetDuties();
    const presetNonDuties = store.getPresetNonDuties();
    const boundaryDuties = store.getBoundaryDuties();

    const presetValidationError = validate_presets_for_schedule({
        preset_duties: presetDuties,
        preset_non_duties: presetNonDuties,
        preset_holidays: presetHolidays,
        patterns,
        people: state.people,
    });
    if (presetValidationError) {
        showWarningModal(presetValidationError);
        return;
    }

    const groups = calculate_group_duties(presetDuties);
    if (has_continuous_duties(groups)) {
        showWarningModal('目前已設定之預排班中出現連續值班狀況，請先調整後再執行自動排班！');
        return;
    }
    if (state.useQodLimit && !less_than_qod_times(groups, state.qodLimit)) {
        showWarningModal(`目前預排班已超過 QOD 設定上限 (${state.qodLimit} 次)，請先調整！`);
        return;
    }
    if (has_boundary_conflict(groups, boundaryDuties, state.useQodLimit, state.qodLimit)) {
        showWarningModal('目前預排班與相鄰月份已排定之班表產生跨月連值或超過 QOD 上限，請先調整！');
        return;
    }
    if (state.useWeekHoursLimit) {
        const weekOpts = {
            preset_holidays: presetHolidays,
            since_date_str: range.startStr,
            total_days: totalDays,
            use_pm_off: true,
            boundary_duties: boundaryDuties,
        };
        if (!less_than_max_week_hours(groups, state.weekHoursLimit, weekOpts)) {
            showWarningModal(`目前預排班已超過週工時上限 (${state.weekHoursLimit} 小時)，請先調整！`);
            return;
        }
    }

    const overlay = document.getElementById('loadingOverlay');
    const msgEl = document.getElementById('block_ui_message');
    if (overlay) overlay.classList.remove('d-none');
    if (msgEl) msgEl.textContent = '初始化排班求解引擎...';

    if (activeWorker) activeWorker.terminate();
    activeWorker = new Worker(new URL('./random_duty_worker.js', import.meta.url), { type: 'module' });

    activeWorker.postMessage({
        presets: {
            duties: presetDuties,
            non_duties: presetNonDuties,
            holidays: presetHolidays,
            boundary_duties: boundaryDuties,
        },
        since_date_str: range.startStr,
        total_days: totalDays,
        filters: {
            patterns,
            use_qod_limit: state.useQodLimit,
            qod_limit: state.qodLimit,
            use_week_hours_limit: state.useWeekHoursLimit,
            max_week_hours: state.weekHoursLimit,
        },
    });

    activeWorker.onmessage = (e) => {
        const { status, msg, duties } = e.data;

        if (status === 'running') {
            if (msgEl) msgEl.textContent = msg;
        } else if (status === 'success') {
            if (overlay) overlay.classList.add('d-none');
            activeWorker.terminate();
            activeWorker = null;

            store.pushUndo();
            store.replaceGeneratedDutiesInRange(range.startStr, range.endStr, duties);
            const patternKey = `${range.month_str}_${state.monthSpan}_${state.people}`;
            state.customPatterns[patternKey] = patterns;

            syncAllViews();
            triggerAutoSaveDraft();
            showToast('success', '自動排班完成', '已成功依設定條件產生班距最佳化之排班表！');
        } else if (status === 'fail') {
            if (overlay) overlay.classList.add('d-none');
            activeWorker.terminate();
            activeWorker = null;
            showWarningModal(msg || '無法找到符合所有約束條件的排班解，建議適度放寬 QOD 或週工時條件。');
        }
    };
}

/**
 * Clear generated duties from active month range.
 */
function clearGeneratedDuties() {
    showConfirmModal({
        title: '清除排班',
        message: '確定要清除目前顯示月份所有自動產生之值班表嗎？（預先指定之值班、不值、自訂假日與其他月份班表將完整保留）',
        confirmText: '清除班表',
        onConfirm: () => {
            const range = store.getDateRange();
            store.pushUndo();
            store.clearGeneratedDutiesInRange(range.startStr, range.endStr);
            syncAllViews();
            triggerAutoSaveDraft();
            showToast('info', '班表已清除', '已清除目前區間之自動排班紀錄。');
        },
    });
}

/**
 * Open Pattern Editor Modal.
 */
function openPatternEditor() {
    const patternsData = document.getElementById('suggested_pattern_body')?.dataset?.patterns;
    if (!patternsData) return;

    const patterns = JSON.parse(patternsData);
    const container = document.getElementById('edit_patterns_table_container');
    const presetHolidays = store.getHolidaysInRange();
    const { ordinaryCount, fridayCount, holidayCount } = countRangeCategoryDays(presetHolidays);

    const presetGroups = calculate_group_duties_status(
        calculate_group_duties(store.getPresetDuties()),
        presetHolidays
    );

    let html = `
        <table class="table table-bordered align-middle text-center" id="edit_patterns_table">
            <thead class="table-light">
                <tr>
                    <th style="width: 28%;">人員</th>
                    <th style="width: 19%;">平</th>
                    <th style="width: 19%;">五</th>
                    <th style="width: 19%;">假</th>
                    <th style="width: 15%;">積點</th>
                </tr>
            </thead>
            <tbody>
    `;

    patterns.forEach((pat, idx) => {
        const personNo = idx + 1;
        const pts = calculate_pattern_points(pat);
        const pg = presetGroups[personNo] || { ordinary_count: 0, friday_count: 0, holiday_count: 0 };
        html += `
            <tr data-person="${personNo}">
                <td class="fw-bold text-start ps-3">
                    <span class="color-dot" style="background-color: ${get_duty_color(personNo)};"></span>${escapeHtml(personLabel(personNo, true))}
                </td>
                <td><input type="number" min="${pg.ordinary_count}" class="form-control form-control-sm text-center duty_input input_o" value="${pat[0]}" title="已預排平日班：${pg.ordinary_count}"></td>
                <td><input type="number" min="${pg.friday_count}" class="form-control form-control-sm text-center duty_input input_f" value="${pat[1]}" title="已預排週五班：${pg.friday_count}"></td>
                <td><input type="number" min="${pg.holiday_count}" class="form-control form-control-sm text-center duty_input input_h" value="${pat[2]}" title="已預排假日班：${pg.holiday_count}"></td>
                <td class="fw-bold text-primary points_cell font-monospace">${pts}</td>
            </tr>
        `;
    });

    html += `
            <tr class="table-light fw-bold" id="pattern_total_row">
                <td>加總 (應為 ${ordinaryCount}/${fridayCount}/${holidayCount})</td>
                <td id="total_o" class="font-monospace">0</td>
                <td id="total_f" class="font-monospace">0</td>
                <td id="total_h" class="font-monospace">0</td>
                <td id="total_pts" class="font-monospace text-primary">0</td>
            </tr>
        </tbody>
    </table>
    `;

    container.innerHTML = html;

    function updateTotals() {
        let sumO = 0;
        let sumF = 0;
        let sumH = 0;
        let sumPts = 0;

        const rows = container.querySelectorAll('tbody tr[data-person]');
        rows.forEach(row => {
            const o = parseInt(row.querySelector('.input_o').value, 10) || 0;
            const f = parseInt(row.querySelector('.input_f').value, 10) || 0;
            const h = parseInt(row.querySelector('.input_h').value, 10) || 0;
            const rowPts = calculate_pattern_points([o, f, h]);

            row.querySelector('.points_cell').textContent = rowPts;
            sumO += o;
            sumF += f;
            sumH += h;
            sumPts += rowPts;
        });

        document.getElementById('total_o').textContent = sumO;
        document.getElementById('total_f').textContent = sumF;
        document.getElementById('total_h').textContent = sumH;
        document.getElementById('total_pts').textContent = sumPts;

        const statusBadge = document.getElementById('pattern_status_badge');
        const isMatch = (sumO === ordinaryCount) && (sumF === fridayCount) && (sumH === holidayCount);
        if (isMatch) {
            statusBadge.className = 'badge bg-success-subtle text-success-emphasis px-3 py-2';
            statusBadge.textContent = '總班數與當月天數完全符合';
        } else {
            statusBadge.className = 'badge bg-danger-subtle text-danger-emphasis px-3 py-2';
            statusBadge.textContent = `差額：平 (${sumO - ordinaryCount}), 五 (${sumF - fridayCount}), 假 (${sumH - holidayCount})`;
        }
    }

    container.querySelectorAll('.duty_input').forEach(input => {
        input.addEventListener('input', updateTotals);
    });

    updateTotals();
    editPatternModal.show();
}

/**
 * Save manual changes from Pattern Editor Modal.
 */
function handleSavePattern() {
    const container = document.getElementById('edit_patterns_table_container');
    const presetHolidays = store.getHolidaysInRange();
    const { ordinaryCount, fridayCount, holidayCount } = countRangeCategoryDays(presetHolidays);

    const rows = container.querySelectorAll('tbody tr[data-person]');
    const newPatterns = [];
    let sumO = 0, sumF = 0, sumH = 0;

    rows.forEach(row => {
        const o = parseInt(row.querySelector('.input_o').value, 10) || 0;
        const f = parseInt(row.querySelector('.input_f').value, 10) || 0;
        const h = parseInt(row.querySelector('.input_h').value, 10) || 0;
        sumO += o;
        sumF += f;
        sumH += h;
        newPatterns.push([o, f, h]);
    });

    if (sumO !== ordinaryCount || sumF !== fridayCount || sumH !== holidayCount) {
        showWarningModal(`總班數加總與當月天數不符合！\n目前輸入：平日 ${sumO} (應為 ${ordinaryCount})、週五 ${sumF} (應為 ${fridayCount})、假日 ${sumH} (應為 ${holidayCount})`);
        return;
    }

    const presetErr = validate_presets_for_schedule({
        preset_duties: store.getPresetDuties(),
        preset_non_duties: store.getPresetNonDuties(),
        preset_holidays: presetHolidays,
        patterns: newPatterns,
        people: state.people,
    });
    if (presetErr) {
        showWarningModal(presetErr);
        return;
    }

    const patternKey = document.getElementById('suggested_pattern_body')?.dataset?.patternKey;
    if (patternKey) {
        store.pushUndo();
        state.customPatterns[patternKey] = newPatterns;
    }

    editPatternModal.hide();
    updateSuggestedPatterns();
    triggerAutoSaveDraft();
    showToast('success', '排班樣式已更新', '自訂排班樣式已儲存，自動排班將依照此分配進行運算。');
}

/**
 * Download high-resolution screenshot of the clean schedule workspace (without sidebar controls).
 */
async function handleDownloadScreenshot() {
    try {
        const targetNode = document.getElementById('schedule-workspace') || document.getElementById('app-content');
        const range = store.getDateRange();
        const filename = `random_duty_${range.month_str}.png`;
        await downloadScheduleScreenshot({ targetNode, filename });
        showToast('success', '截圖成功', `已輸出高畫質班表圖檔：${filename}`);
    } catch (err) {
        console.error('Screenshot failed:', err);
        showToast('error', '輸出失敗', '截圖過程發生錯誤，請稍後重試。');
    }
}

/**
 * Download Excel file via ExcellentExport (including custom staff names if set).
 */
async function handleDownloadExcel() {
    const range = store.getDateRange();
    const duties = store.getAllDuties();
    const totalDays = range.end_date.diff(range.start_date, 'day');
    const check = validate_duties_for_export(duties, range.startStr, totalDays);

    const runExport = async () => {
        try {
            const outName = await exportScheduleToExcel({
                currentMonth: state.currentMonth,
                monthSpan: state.monthSpan,
                monthStr: range.month_str,
                dutiesByDate: check.dutiesByDate,
                formatPerson: (p) => personLabel(p, false),
            });
            showToast('success', '匯出成功', `已下載 Excel 值班表：${outName}`);
        } catch (err) {
            console.error('Excel export failed:', err);
            showToast('error', '匯出失敗', '無法產生 Excel 檔案。');
        }
    };

    if (!check.isComplete) {
        const warnings = [];
        if (check.missingDays > 0) {
            warnings.push(`尚有 ${check.missingDays} 天未排定人員（已排 ${check.coveredDays} / ${totalDays} 天）`);
        }
        if (check.duplicateDates.length > 0) {
            warnings.push(`有 ${check.duplicateDates.length} 天重複排入多位人員（${check.duplicateDates.join(', ')}）`);
        }
        showConfirmModal({
            title: '班表檢核提醒',
            message: `目前班表${warnings.join('，且')}，確定仍要下載 Excel 嗎？`,
            confirmText: '仍要下載',
            confirmClass: 'btn-warning',
            onConfirm: runExport,
        });
    } else {
        runExport();
    }
}

/**
 * Export complete JSON backup file.
 */
function handleExportJsonBackup() {
    const range = store.getDateRange();
    const filename = exportScheduleBackupJson(
        {
            preferences: loadPreferences(),
            draft: store.toDraftPayload(),
        },
        range.month_str
    );
    showToast('success', '備份已匯出', `已下載設定與班表備份檔：${filename}`);
}

/**
 * Import JSON backup file and restore preferences + schedule state.
 */
async function handleImportJsonFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
        const { preferences, draft } = await parseScheduleBackupFile(file);
        store.pushUndo();
        if (preferences) {
            const merged = savePreferences(preferences);
            state.monthSpan = merged.mode_switch ? 2 : 1;
            state.people = merged.inputPeopleSlider || 4;
            state.useQodLimit = merged.use_qod_limit !== false;
            state.qodLimit = merged.inputQodLimitSlider ?? 1;
            state.useWeekHoursLimit = merged.use_week_hours_limit !== false;
            state.weekHoursLimit = merged.inputWeekHoursLimitSlider || 80;
            state.autoSaveDraft = merged.auto_save_draft !== false;
            applyStatePreferencesToForm();
        }
        store.hydrateFromDraft(draft);
        if (cal1) cal1.gotoDate(state.currentMonth.format('YYYY-MM-01'));
        setMonthSpan(state.monthSpan, { persist: false });
        syncAllViews({ includeOfficialHolidays: true });
        triggerAutoSaveDraft();
        showToast('success', '備份已匯入', '已成功還原排班資料與人員設定！');
    } catch (err) {
        console.error('Import JSON failed:', err);
        showWarningModal(`無法讀取備份檔案：${err.message || '檔案格式錯誤'}`);
    }
}

/**
 * Sync UI sliders & switches from state.
 */
function applyStatePreferencesToForm() {
    document.getElementById('inputPeopleSlider').value = state.people;
    document.getElementById('people_val_badge').textContent = `${state.people} 人`;

    document.getElementById('use_qod_limit').checked = state.useQodLimit;
    document.getElementById('inputQodLimitSlider').value = state.qodLimit;
    document.getElementById('inputQodLimitSlider').disabled = !state.useQodLimit;
    document.getElementById('qod_val_badge').textContent = `${state.qodLimit} 次`;

    document.getElementById('use_week_hours_limit').checked = state.useWeekHoursLimit;
    document.getElementById('inputWeekHoursLimitSlider').value = state.weekHoursLimit;
    document.getElementById('inputWeekHoursLimitSlider').disabled = !state.useWeekHoursLimit;
    document.getElementById('week_hours_val_badge').textContent = `${state.weekHoursLimit} 小時`;

    document.getElementById('auto_save_draft_switch').checked = state.autoSaveDraft;
}

/**
 * Clear all local storage preferences and drafts.
 */
function handleClearAllStorage() {
    showConfirmModal({
        title: '清除本機紀錄',
        message: '確定要清除所有本機儲存的偏好設定與排班草稿嗎？這將會重置所有參數並清空畫面上的排班資料。',
        confirmText: '清除並重置',
        confirmClass: 'btn-danger',
        onConfirm: () => {
            store.resetAll();
            applyStatePreferencesToForm();

            if (cal1) cal1.gotoDate(state.currentMonth.format('YYYY-MM-01'));
            setMonthSpan(1, { persist: false });
            syncAllViews({ includeOfficialHolidays: true });

            clearAllStorage();
            showToast('success', '已重置', '已清除所有本機儲存紀錄並恢復預設值。');
        },
    });
}

/**
 * Initialize DOM listeners and load saved preferences & drafts.
 */
function initApp() {
    const versionEl = document.getElementById('appVersion');
    if (versionEl) {
        versionEl.textContent = `v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.0.0'}`;
    }

    calEventModal = new Modal(document.getElementById('calEventModal'));
    editPatternModal = new Modal(document.getElementById('editPatternModal'));
    dialogModal = new Modal(document.getElementById('dialogModal'));
    staffNamesModal = new Modal(document.getElementById('staffNamesModal'));

    const prefs = loadPreferences();
    state.monthSpan = prefs.mode_switch ? 2 : 1;
    state.people = prefs.inputPeopleSlider || 4;
    state.useQodLimit = prefs.use_qod_limit !== false;
    state.qodLimit = prefs.inputQodLimitSlider ?? 1;
    state.useWeekHoursLimit = prefs.use_week_hours_limit !== false;
    state.weekHoursLimit = prefs.inputWeekHoursLimitSlider || 80;
    state.autoSaveDraft = prefs.auto_save_draft !== false;

    const draft = state.autoSaveDraft ? loadDraft() : null;
    if (draft) {
        store.hydrateFromDraft(draft);
    }

    applyStatePreferencesToForm();

    // Listeners
    document.getElementById('mode_1m').addEventListener('change', () => setMonthSpan(1));
    document.getElementById('mode_2m').addEventListener('change', () => setMonthSpan(2));

    document.getElementById('inputPeopleSlider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        state.people = val;
        if (state.highlightedPerson && state.highlightedPerson > val) {
            state.highlightedPerson = null;
        }
        document.getElementById('people_val_badge').textContent = `${val} 人`;
        savePreferences({ inputPeopleSlider: val });
        syncAllViews();
    });

    document.getElementById('use_qod_limit').addEventListener('change', (e) => {
        state.useQodLimit = e.target.checked;
        document.getElementById('inputQodLimitSlider').disabled = !state.useQodLimit;
        savePreferences({ use_qod_limit: state.useQodLimit });
        syncAllViews();
    });

    document.getElementById('inputQodLimitSlider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        state.qodLimit = val;
        document.getElementById('qod_val_badge').textContent = `${val} 次`;
        savePreferences({ inputQodLimitSlider: val });
        syncAllViews();
    });

    document.getElementById('use_week_hours_limit').addEventListener('change', (e) => {
        state.useWeekHoursLimit = e.target.checked;
        document.getElementById('inputWeekHoursLimitSlider').disabled = !state.useWeekHoursLimit;
        savePreferences({ use_week_hours_limit: state.useWeekHoursLimit });
        syncAllViews();
    });

    document.getElementById('inputWeekHoursLimitSlider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        state.weekHoursLimit = val;
        document.getElementById('week_hours_val_badge').textContent = `${val} 小時`;
        savePreferences({ inputWeekHoursLimitSlider: val });
        syncAllViews();
    });

    document.getElementById('auto_save_draft_switch').addEventListener('change', (e) => {
        state.autoSaveDraft = e.target.checked;
        savePreferences({ auto_save_draft: state.autoSaveDraft });
        if (state.autoSaveDraft) {
            triggerAutoSaveDraft();
            showToast('info', '草稿自動暫存已啟用', '排班進度異動將即時儲存於本機。');
        } else {
            showToast('warning', '草稿自動暫存已關閉', '本機排班草稿已清除，重整將不會保留排班進度。');
        }
    });

    document.getElementById('prev_month').addEventListener('click', () => navigateMonth(-1));
    document.getElementById('next_month').addEventListener('click', () => navigateMonth(1));
    document.getElementById('today_next_month').addEventListener('click', resetToDefaultMonth);

    document.getElementById('btn_undo').addEventListener('click', handleUndo);
    document.getElementById('btn_redo').addEventListener('click', handleRedo);
    document.getElementById('active_person_filter_btn').addEventListener('click', () => toggleHighlightPerson(null));

    // Global keyboard shortcuts for Undo / Redo (ignored when typing in inputs)
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) handleRedo();
            else handleUndo();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            handleRedo();
        }
    });

    document.querySelectorAll('input[name="eventProp"]').forEach(radio => {
        radio.addEventListener('change', updateEventModalFieldVisibility);
    });

    document.getElementById('btn_save_cal_event').addEventListener('click', handleSaveCalEvent);
    document.getElementById('btn_delete_cal_event').addEventListener('click', handleDeleteCalEvent);

    // Staff names modal listeners
    document.getElementById('btn_open_staff_names').addEventListener('click', openStaffNamesModal);
    document.getElementById('btn_apply_bulk_staff').addEventListener('click', handleApplyBulkStaffNames);
    document.getElementById('btn_save_staff_names').addEventListener('click', handleSaveStaffNames);
    document.getElementById('btn_clear_staff_names').addEventListener('click', () => {
        document.querySelectorAll('#staff_names_inputs .staff-name-input').forEach(el => { el.value = ''; });
    });

    document.getElementById('func_get_holiday_condition').addEventListener('click', () => {
        const patternKey = document.getElementById('suggested_pattern_body')?.dataset?.patternKey;
        if (patternKey) {
            delete state.customPatterns[patternKey];
            delete state.sessionPatterns[patternKey];
        }
        updateSuggestedPatterns({ forceRegenerate: true });
        triggerAutoSaveDraft();
        showToast('info', '排班樣式已更新', '已重新隨機生成排班樣式。');
    });
    document.getElementById('func_edit_duty_patterns').addEventListener('click', openPatternEditor);
    document.getElementById('btn_save_pattern').addEventListener('click', handleSavePattern);

    document.getElementById('func_random_duty').addEventListener('click', executeRandomDuty);
    document.getElementById('func_clear_calendar').addEventListener('click', clearGeneratedDuties);
    document.querySelectorAll('.btn_stop_random_duty_worker').forEach(btn => {
        btn.addEventListener('click', () => {
            if (activeWorker) {
                activeWorker.terminate();
                activeWorker = null;
            }
            document.getElementById('loadingOverlay').classList.add('d-none');
            showToast('info', '運算已取消', '已終止排班背景運算。');
        });
    });

    document.getElementById('func_download_screenshot').addEventListener('click', handleDownloadScreenshot);
    document.getElementById('func_download_excel').addEventListener('click', handleDownloadExcel);
    document.getElementById('func_export_json').addEventListener('click', handleExportJsonBackup);
    document.getElementById('func_import_json').addEventListener('click', () => {
        document.getElementById('json_import_file_input')?.click();
    });
    document.getElementById('json_import_file_input').addEventListener('change', handleImportJsonFile);
    document.getElementById('func_clear_local_storage').addEventListener('click', handleClearAllStorage);

    initCalendars();
    setMonthSpan(state.monthSpan, { persist: false });

    if (draft) {
        triggerAutoSaveDraft();
        showToast('info', '草稿已還原', '已還原上次暫存之排班草稿。');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
