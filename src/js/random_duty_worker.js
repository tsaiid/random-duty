import { solve_random_duty } from './lib_solver.js';

onmessage = function(oEvent) {
    const { presets, since_date_str, total_days, filters } = oEvent.data;

    const result = solve_random_duty(total_days, since_date_str, presets, filters, (progressMsg) => {
        postMessage({
            status: 'running',
            msg: progressMsg,
        });
    });

    postMessage({
        status: result.status,
        msg: result.msg,
        duties: result.duties,
        groups: result.groups,
    });
};
