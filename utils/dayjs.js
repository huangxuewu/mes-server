const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const database = require("../config/database");
const Config = require("../models/config");

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_FACTORY_TIMEZONE = "America/New_York";
const FACTORY_TIMEZONE_CACHE_TTL_MS = 60 * 1000;
const FACTORY_TIMEZONE_ALIASES = {
	UTC: "UTC",
	EST: "America/New_York",
	EDT: "America/New_York",
	CST: "America/Chicago",
	CDT: "America/Chicago",
	MST: "America/Denver",
	MDT: "America/Denver",
	PST: "America/Los_Angeles",
	PDT: "America/Los_Angeles"
};

let cachedFactoryTimeZone = DEFAULT_FACTORY_TIMEZONE;
let cachedFactoryTimeZoneExpiresAt = 0;
let factoryTimeZoneRefreshPromise = null;

function normalizeFactoryTimeZone(timeZone) {
	if (typeof timeZone !== "string") return DEFAULT_FACTORY_TIMEZONE;

	const trimmedTimeZone = timeZone.trim();
	if (!trimmedTimeZone) return DEFAULT_FACTORY_TIMEZONE;

	const resolvedTimeZone = FACTORY_TIMEZONE_ALIASES[trimmedTimeZone] || trimmedTimeZone;

	try {
		Intl.DateTimeFormat("en-US", { timeZone: resolvedTimeZone }).format(new Date());
		return resolvedTimeZone;
	} catch (error) {
		return DEFAULT_FACTORY_TIMEZONE;
	}
}

function applyFactoryTimeZone(timeZone) {
	const resolvedTimeZone = normalizeFactoryTimeZone(timeZone);
	cachedFactoryTimeZone = resolvedTimeZone;
	cachedFactoryTimeZoneExpiresAt = Date.now() + FACTORY_TIMEZONE_CACHE_TTL_MS;
	dayjs.tz.setDefault(resolvedTimeZone);
	return resolvedTimeZone;
}

async function refreshFactoryTimeZone() {
	if (factoryTimeZoneRefreshPromise) {
		return factoryTimeZoneRefreshPromise;
	}

	factoryTimeZoneRefreshPromise = (async () => {
		try {
			if (database.connection.readyState !== 1) {
				return applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);
			}

			const config = await Config.findOne({ key: "manufacturer.timezone", status: "Active" })
				.sort({ updatedAt: -1 })
				.lean();

			return applyFactoryTimeZone(config?.value);
		} catch (error) {
			return applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);
		} finally {
			factoryTimeZoneRefreshPromise = null;
		}
	})();

	return factoryTimeZoneRefreshPromise;
}

async function getFactoryTimeZone({ forceRefresh = false } = {}) {
	const now = Date.now();

	if (!forceRefresh && cachedFactoryTimeZone && now < cachedFactoryTimeZoneExpiresAt) {
		return cachedFactoryTimeZone;
	}

	return refreshFactoryTimeZone();
}

applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);

database.connection.on("connected", () => {
	refreshFactoryTimeZone().catch(() => {
		applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);
	});
});

database.connection.on("disconnected", () => {
	applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);
});

if (database.connection.readyState === 1) {
	refreshFactoryTimeZone().catch(() => {
		applyFactoryTimeZone(DEFAULT_FACTORY_TIMEZONE);
	});
}

dayjs.extend((_options, _dayjsClass, dayjsFactory) => {
	dayjsFactory.normalizeFactoryTimeZone = normalizeFactoryTimeZone;
	dayjsFactory.applyFactoryTimeZone = applyFactoryTimeZone;
	dayjsFactory.refreshFactoryTimeZone = refreshFactoryTimeZone;
	dayjsFactory.getFactoryTimeZone = getFactoryTimeZone;
	dayjsFactory.businessDate = async (format = "YYYY-MM-DD") => {
		const factoryTimeZone = await getFactoryTimeZone();
		return dayjsFactory().tz(factoryTimeZone).format(format);
	};
});

module.exports = dayjs;