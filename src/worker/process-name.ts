/** Imported first by the worker entrypoint so logger/db pick up the process name. */
process.env.ROSTER_PROCESS ??= "roster-worker";
export {};
