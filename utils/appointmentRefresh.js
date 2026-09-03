const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

const isRateLimitError = (error) => {
    const status = error?.response?.status ?? error?.code;
    const details = [
        error?.response?.data?.error?.status,
        ...(error?.response?.data?.error?.errors ?? []).map(item => item.reason),
        error?.message,
    ].filter(Boolean).join(" ");

    return Number(status) === 429 || /rate.?limit|quota/i.test(details);
};

const createAppointmentRefreshCoordinator = ({
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    backoffMs = RATE_LIMIT_BACKOFF_MS,
    now = () => Date.now(),
} = {}) => {
    const state = {
        inFlight: null,
        lastCompletedAt: 0,
        lastResult: null,
        blockedUntil: 0,
    };

    const cachedResult = (rateLimited = false) => ({
        ...(state.lastResult ?? { newMessages: 0, threads: null }),
        newMessages: 0,
        cached: true,
        rateLimited,
        checkedAt: state.lastCompletedAt ? new Date(state.lastCompletedAt) : null,
    });

    const run = async ({ force = false, execute }) => {
        const currentTime = now();
        if (state.inFlight) return state.inFlight;

        if (currentTime < state.blockedUntil) {
            if (state.lastResult) return cachedResult(true);
            throw new Error("Gmail refresh is temporarily paused after reaching a rate limit");
        }

        const cacheIsFresh = state.lastResult
            && currentTime - state.lastCompletedAt < intervalMs;
        if (!force && cacheIsFresh) return cachedResult();

        state.inFlight = execute()
            .then(result => {
                state.lastResult = result;
                state.lastCompletedAt = now();
                state.blockedUntil = 0;
                return {
                    ...result,
                    cached: false,
                    rateLimited: false,
                    checkedAt: new Date(state.lastCompletedAt),
                };
            })
            .catch(error => {
                if (!isRateLimitError(error)) throw error;
                state.blockedUntil = now() + backoffMs;
                if (state.lastResult) return cachedResult(true);
                throw error;
            })
            .finally(() => { state.inFlight = null; });

        return state.inFlight;
    };

    return { run, state };
};

module.exports = {
    DEFAULT_REFRESH_INTERVAL_MS,
    isRateLimitError,
    createAppointmentRefreshCoordinator,
};
