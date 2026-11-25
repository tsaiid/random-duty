/**
 * Export utilities for high-resolution PNG screenshots and Excel (.xlsx) schedules.
 */

/**
 * Download high-resolution screenshot of the target DOM node via html-to-image.
 * Temporarily expands horizontally scrollable tables so no columns are clipped on narrow screens.
 *
 * @param {Object} params
 * @param {HTMLElement} params.targetNode DOM container to capture.
 * @param {string} params.filename Output PNG filename.
 * @return {Promise<void>}
 */
export async function downloadScheduleScreenshot({ targetNode, filename }) {
    if (!targetNode) return;
    const { toPng } = await import('html-to-image');

    const scrollWrappers = Array.from(targetNode.querySelectorAll('.table-responsive'));
    const savedStyles = scrollWrappers.map(el => ({
        el,
        overflow: el.style.overflow,
        maxWidth: el.style.maxWidth,
    }));

    try {
        scrollWrappers.forEach(el => {
            el.style.overflow = 'visible';
            el.style.maxWidth = 'none';
        });

        const exportWidth = Math.max(targetNode.scrollWidth, targetNode.offsetWidth);
        const dataUrl = await toPng(targetNode, {
            pixelRatio: 2,
            backgroundColor: '#f8fafc',
            width: exportWidth,
        });

        const link = document.getElementById('screenshot_download_link') || document.createElement('a');
        link.href = dataUrl;
        link.download = filename;
        link.click();
    } finally {
        savedStyles.forEach(({ el, overflow, maxWidth }) => {
            el.style.overflow = overflow;
            el.style.maxWidth = maxWidth;
        });
    }
}

/**
 * Export schedule data into an Excel (.xlsx) workbook via ExcellentExport.
 *
 * @param {Object} params
 * @param {Object} params.currentMonth Dayjs start month object.
 * @param {number} params.monthSpan 1 or 2.
 * @param {string} params.monthStr Formatted range label (e.g. '2026-11').
 * @param {Object<string, number[]>} params.dutiesByDate Map of dateStr -> array of person numbers.
 * @param {Function} [params.formatPerson] Optional person label formatter (defaults to number string).
 * @return {Promise<string>} Output filename with extension.
 */
export async function exportScheduleToExcel({
    currentMonth,
    monthSpan,
    monthStr,
    dutiesByDate,
    formatPerson = (p) => String(p),
}) {
    const container = document.getElementById('duties_datatable_div');
    if (!container) throw new Error('Missing #duties_datatable_div container');

    const table = document.createElement('table');
    table.id = 'duties_datatable';
    table.className = 'd-none';
    const tbody = document.createElement('tbody');

    for (let i = 0; i < monthSpan; i++) {
        const monthStart = currentMonth.clone().add(i, 'month').startOf('month');
        const monthEnd = monthStart.clone().endOf('month').startOf('day');
        const viewStart = monthStart.startOf('isoWeek');
        const viewEnd = monthEnd.endOf('isoWeek').startOf('day');

        const titleRow = document.createElement('tr');
        const titleCell = document.createElement('td');
        titleCell.colSpan = 7;
        const bold = document.createElement('b');
        bold.textContent = monthStart.format('YYYY / MM');
        titleCell.appendChild(bold);
        titleRow.appendChild(titleCell);
        tbody.appendChild(titleRow);

        for (let cur = viewStart.clone(); cur.isBefore(viewEnd) || cur.isSame(viewEnd, 'day'); cur = cur.add(7, 'day')) {
            const headerRow = document.createElement('tr');
            const dutyRow = document.createElement('tr');

            for (let day = 0; day < 7; day++) {
                const d = cur.add(day, 'day');
                const dStr = d.format('YYYY-MM-DD');

                const th = document.createElement('th');
                th.textContent = d.format('MM/DD');
                headerRow.appendChild(th);

                const td = document.createElement('td');
                const peopleList = dutiesByDate[dStr];
                td.textContent = peopleList ? peopleList.map(formatPerson).join(', ') : '';
                dutyRow.appendChild(td);
            }

            tbody.appendChild(headerRow);
            tbody.appendChild(dutyRow);
        }

        const spacerRow = document.createElement('tr');
        const spacerCell = document.createElement('td');
        spacerCell.colSpan = 7;
        spacerRow.appendChild(spacerCell);
        tbody.appendChild(spacerRow);
    }

    table.appendChild(tbody);
    container.replaceChildren(table);

    const { default: ExcellentExport } = await import('excellentexport');
    const filename = `random_duty_${monthStr}`;
    ExcellentExport.convert(
        { openAsDownload: true, filename, format: 'xlsx' },
        [{ name: '值班表', from: { table: 'duties_datatable' } }]
    );
    return `${filename}.xlsx`;
}
