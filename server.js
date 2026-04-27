const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
loadEnvFile(path.join(root, ".env"));

const port = Number(process.env.PORT || 4173);
const cacheStaleMs = Number(process.env.CACHE_STALE_MS || 60_000);
const refreshCooldownMs = Number(process.env.REFRESH_COOLDOWN_MS || cacheStaleMs);
const databasePath = process.env.DATABASE_PATH || path.join(root, "data", "parkwhere.sqlite");

const HDB_STATIC_INFO_URL =
  "https://data.gov.sg/api/action/datastore_search?resource_id=d_23f946fa557947f93a8043bbef41dd09&limit=5000";
const HDB_AVAILABILITY_URL =
  "https://api.data.gov.sg/v1/transport/carpark-availability";
const LTA_CARPARK_AVAILABILITY_URL =
  "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2";
const LTA_ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY || "";
const PAGE_SIZE = 500;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sqlite": "application/octet-stream",
  ".svg": "image/svg+xml",
};

const cache = {
  hdbStatic: { value: null, fetchedAt: 0 },
};

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
initializeDatabase();

const statements = {
  insertSnapshot: db.prepare(`
    INSERT INTO sync_snapshots (
      status,
      trigger_reason,
      fetched_at,
      payload_json,
      error_text
    ) VALUES (?, ?, ?, ?, ?)
  `),
  latestSuccessfulSnapshot: db.prepare(`
    SELECT id, fetched_at, payload_json
    FROM sync_snapshots
    WHERE status = 'success'
    ORDER BY id DESC
    LIMIT 1
  `),
  latestSnapshot: db.prepare(`
    SELECT id, status, trigger_reason, fetched_at, error_text
    FROM sync_snapshots
    ORDER BY id DESC
    LIMIT 1
  `),
  upsertStaticDataset: db.prepare(`
    INSERT INTO static_datasets (
      dataset_key,
      fetched_at,
      payload_json
    ) VALUES (?, ?, ?)
    ON CONFLICT(dataset_key) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      payload_json = excluded.payload_json
  `),
  staticDatasetByKey: db.prepare(`
    SELECT dataset_key, fetched_at, payload_json
    FROM static_datasets
    WHERE dataset_key = ?
    LIMIT 1
  `),
};

let syncInFlight = null;

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = request.url === "/" ? "/index.html" : request.url;
    const pathname = decodeURIComponent(requestPath.split("?")[0]);

    if (pathname === "/api/carparks") {
      const payload = await getServablePayload();
      if (!payload) {
        respondJson(response, 503, {
          error: "No cached carpark snapshot yet",
          detail: "The first sync has not completed successfully yet.",
        });
        return;
      }

      respondJson(response, 200, payload);
      return;
    }

    const filePath = path.join(root, pathname);
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end(error.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(data);
    });
  } catch (error) {
    console.error(error);
    respondJson(response, 500, {
      error: "Unable to load carpark data",
      detail: error.message,
    });
  }
});

server.listen(port, () => {
  console.log(`ParkWhere SG is running on http://localhost:${port}`);
});

async function getServablePayload() {
  let stored = loadLatestSuccessfulPayload();
  const latestAttempt = loadLatestAttempt();

  if (!stored) {
    await ensureFreshData("cold-start", { waitForCompletion: true });
    stored = loadLatestSuccessfulPayload();
    if (!stored) {
      return null;
    }
  } else if (shouldRefresh(stored, latestAttempt)) {
    void ensureFreshData("stale-request", { waitForCompletion: false });
  }

  return decorateStoredPayload(stored, loadLatestAttempt());
}

function shouldRefresh(stored, latestAttempt) {
  const now = Date.now();
  const lastSuccessfulAt = Date.parse(stored.fetched_at);
  if (!Number.isFinite(lastSuccessfulAt)) {
    return true;
  }

  const isStale = now - lastSuccessfulAt >= cacheStaleMs;
  if (!isStale) {
    return false;
  }

  if (!latestAttempt) {
    return true;
  }

  const lastAttemptAt = Date.parse(latestAttempt.fetched_at);
  if (!Number.isFinite(lastAttemptAt)) {
    return true;
  }

  return now - lastAttemptAt >= refreshCooldownMs;
}

async function ensureFreshData(triggerReason, options = {}) {
  if (syncInFlight) {
    return options.waitForCompletion ? syncInFlight : null;
  }

  syncInFlight = (async () => {
    try {
      const payload = await fetchLivePayload();
      saveSnapshot({
        status: "success",
        triggerReason,
        fetchedAt: payload.generatedAt,
        payloadJson: JSON.stringify(payload),
        errorText: null,
      });
      console.log(`[sync] ${triggerReason} success at ${payload.generatedAt}`);
    } catch (error) {
      const failedAt = new Date().toISOString();
      saveSnapshot({
        status: "failed",
        triggerReason,
        fetchedAt: failedAt,
        payloadJson: null,
        errorText: error.message,
      });
      console.error(`[sync] ${triggerReason} failed at ${failedAt}:`, error.message);
    } finally {
      syncInFlight = null;
    }
  })();

  return options.waitForCompletion ? syncInFlight : null;
}

function decorateStoredPayload(stored, latestAttempt) {
  const payload = JSON.parse(stored.payload_json);
  const lastSuccessfulAt = Date.parse(stored.fetched_at);
  const isStale =
    Number.isFinite(lastSuccessfulAt) && Date.now() - lastSuccessfulAt >= cacheStaleMs;

  payload.storage = {
    provider: "sqlite",
    cacheStaleMs,
    refreshCooldownMs,
    servedFromCache: true,
    isStale,
    lastSuccessfulSyncAt: stored.fetched_at,
    lastAttemptStatus: latestAttempt?.status || "unknown",
    lastAttemptAt: latestAttempt?.fetched_at || stored.fetched_at,
    lastAttemptError: latestAttempt?.error_text || null,
    refreshInFlight: Boolean(syncInFlight),
  };
  return payload;
}

function loadLatestSuccessfulPayload() {
  return statements.latestSuccessfulSnapshot.get();
}

function loadLatestAttempt() {
  return statements.latestSnapshot.get();
}

function saveSnapshot(snapshot) {
  statements.insertSnapshot.run(
    snapshot.status,
    snapshot.triggerReason,
    snapshot.fetchedAt,
    snapshot.payloadJson,
    snapshot.errorText
  );
}

function saveStaticDataset(datasetKey, payloadJson) {
  statements.upsertStaticDataset.run(datasetKey, new Date().toISOString(), payloadJson);
}

function loadStaticDataset(datasetKey) {
  return statements.staticDatasetByKey.get(datasetKey);
}

async function fetchLivePayload() {
  const [hdbStaticLookup, hdbAvailability, ltaAvailability] = await Promise.all([
    getHdbStaticLookup(),
    fetchJson(HDB_AVAILABILITY_URL),
    fetchLtaAvailability(),
  ]);

  const hdbCarparks = mergeHdbCarparks(
    hdbAvailability?.items?.[0]?.carpark_data || [],
    hdbStaticLookup
  );

  const hdbCodes = new Set(hdbCarparks.map((carpark) => carpark.code));
  const ltaCarparks = buildLtaCarparks(ltaAvailability.records, hdbCodes);
  const generatedAt = new Date().toISOString();
  const carparks = [...hdbCarparks, ...ltaCarparks].sort(compareCarparks);

  return {
    generatedAt,
    summary: {
      liveLabel: buildLiveLabel(hdbCarparks.length, ltaCarparks.length, ltaAvailability.enabled),
    },
    sources: {
      hdb: {
        enabled: true,
      },
      lta: {
        configured: Boolean(LTA_ACCOUNT_KEY),
        enabled: ltaAvailability.enabled,
        error: ltaAvailability.error,
      },
    },
    carparks,
  };
}

async function getHdbStaticLookup() {
  if (cache.hdbStatic.value) {
    return cache.hdbStatic.value;
  }

  const storedStatic = loadStaticDataset("hdb_static_lookup");
  if (storedStatic) {
    const lookup = staticLookupFromJson(storedStatic.payload_json);
    cache.hdbStatic = {
      value: lookup,
      fetchedAt: Date.parse(storedStatic.fetched_at) || Date.now(),
    };
    return lookup;
  }

  const derivedLookup = deriveHdbStaticLookupFromSnapshot();
  if (derivedLookup.size > 0) {
    saveStaticDataset("hdb_static_lookup", lookupToJson(derivedLookup));
    cache.hdbStatic = {
      value: derivedLookup,
      fetchedAt: Date.now(),
    };
    return derivedLookup;
  }

  const response = await fetchJson(HDB_STATIC_INFO_URL);
  const records = response?.result?.records || [];
  const lookup = new Map(
    records.map((record) => [
      record.car_park_no,
      {
        address: record.address || "",
        type: record.car_park_type || "HDB Carpark",
      },
    ])
  );

  cache.hdbStatic = {
    value: lookup,
    fetchedAt: Date.now(),
  };
  saveStaticDataset("hdb_static_lookup", lookupToJson(lookup));

  return lookup;
}

function lookupToJson(lookup) {
  return JSON.stringify(
    Array.from(lookup.entries()).map(([code, value]) => ({
      code,
      address: value.address || "",
      type: value.type || "",
    }))
  );
}

function staticLookupFromJson(payloadJson) {
  const records = JSON.parse(payloadJson);
  return new Map(
    records.map((record) => [
      record.code,
      {
        address: record.address || "",
        type: record.type || "HDB Carpark",
      },
    ])
  );
}

function deriveHdbStaticLookupFromSnapshot() {
  const latestSuccessful = loadLatestSuccessfulPayload();
  if (!latestSuccessful?.payload_json) {
    return new Map();
  }

  const payload = JSON.parse(latestSuccessful.payload_json);
  const carparks = Array.isArray(payload.carparks) ? payload.carparks : [];
  const records = carparks
    .filter((carpark) => carpark.source === "HDB")
    .map((carpark) => ({
      code: carpark.code,
      address: carpark.displayName || "",
      type: String(carpark.secondaryText || "").split(" - ")[0] || "HDB Carpark",
    }))
    .filter((record) => record.code && record.address);

  return new Map(
    records.map((record) => [
      record.code,
      {
        address: record.address,
        type: record.type,
      },
    ])
  );
}

function mergeHdbCarparks(liveCarparks, staticLookup) {
  return liveCarparks.map((entry) => {
    const code = entry.carpark_number;
    const staticInfo = staticLookup.get(code) || {};
    const liveInfo = Array.isArray(entry.carpark_info) ? entry.carpark_info[0] || {} : {};
    const address = toTitleCase(staticInfo.address || code);
    const totalLots = toNumber(liveInfo.total_lots);
    const availableLots = toNumber(liveInfo.lots_available);

    return {
      code,
      displayName: address,
      secondaryText: `${humanizeCarparkType(staticInfo.type || "HDB Carpark")} - HDB official data`,
      categoryLabel: "HDB",
      source: "HDB",
      availableLots,
      totalLots,
      updateDateTime: entry.update_datetime,
      mapUrl: buildAddressMapUrl(address),
      vehicleBreakdown: formatVehicleBreakdown([
        {
          type: "C",
          availableLots,
          totalLots,
        },
      ]),
      searchText: [address, staticInfo.address, code, staticInfo.type, "HDB"].join(" ").toLowerCase(),
    };
  });
}

async function fetchLtaAvailability() {
  if (!LTA_ACCOUNT_KEY) {
    return {
      configured: false,
      enabled: false,
      error: null,
      records: [],
    };
  }

  try {
    const records = await fetchAllLtaPages(LTA_CARPARK_AVAILABILITY_URL);
    return {
      configured: true,
      enabled: true,
      error: null,
      records,
    };
  } catch (error) {
    console.error("LTA load failed:", error);
    return {
      configured: true,
      enabled: false,
      error: error.message,
      records: [],
    };
  }
}

async function fetchAllLtaPages(baseUrl) {
  const allRecords = [];

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const connector = baseUrl.includes("?") ? "&" : "?";
    const pageUrl = `${baseUrl}${connector}$skip=${skip}`;
    const page = await fetchJson(pageUrl, {
      headers: {
        AccountKey: LTA_ACCOUNT_KEY,
        accept: "application/json",
      },
    });

    const records = Array.isArray(page.value) ? page.value : [];
    allRecords.push(...records);

    if (records.length < PAGE_SIZE) {
      break;
    }
  }

  return allRecords;
}

function buildLtaCarparks(records, preferredHdbCodes) {
  const grouped = new Map();

  records.forEach((record) => {
    const code = String(record.CarParkID || "").trim();
    if (!code || preferredHdbCodes.has(code)) {
      return;
    }

    const agency = String(record.Agency || "").trim().toUpperCase();
    const development = String(record.Development || "").trim();
    const lotType = String(record.LotType || "").trim().toUpperCase();
    const location = String(record.Location || "").trim();

    if (!grouped.has(code)) {
      grouped.set(code, {
        code,
        agency,
        area: String(record.Area || "").trim(),
        development,
        location,
        updateDateTime: new Date().toISOString(),
        lotsByType: [],
      });
    }

    grouped.get(code).lotsByType.push({
      type: lotType,
      availableLots: toNumber(record.AvailableLots),
    });
  });

  return Array.from(grouped.values())
    .map((group) => {
      const displayName = buildLtaDisplayName(group);
      const carLots = group.lotsByType.find((entry) => entry.type === "C");
      const vehicleBreakdown = formatVehicleBreakdown(group.lotsByType);
      const sourceLabel =
        group.agency === "LTA" ? "LTA mall/development data" : `${group.agency} via LTA DataMall`;

      return {
        code: group.code,
        displayName,
        secondaryText: buildLtaSecondaryText(group, sourceLabel),
        categoryLabel: group.agency || "LTA",
        source: group.agency || "LTA",
        availableLots: carLots ? carLots.availableLots : sumAvailableLots(group.lotsByType),
        totalLots: null,
        updateDateTime: group.updateDateTime,
        mapUrl: buildLocationMapUrl(group.location, displayName, group.area),
        vehicleBreakdown,
        searchText: [
          displayName,
          group.development,
          group.area,
          group.code,
          group.agency,
          vehicleBreakdown,
        ]
          .join(" ")
          .toLowerCase(),
      };
    })
    .sort(compareCarparks);
}

function buildLtaDisplayName(group) {
  const development = toTitleCase(group.development || group.code);
  if (development.endsWith("Carpark")) {
    return development;
  }
  return `${development} Carpark`;
}

function buildLtaSecondaryText(group, sourceLabel) {
  const parts = [];
  if (group.area) {
    parts.push(toTitleCase(group.area));
  }
  parts.push(sourceLabel);
  return parts.join(" - ");
}

function formatVehicleBreakdown(lotsByType) {
  const labels = lotsByType
    .filter((entry) => Number.isFinite(entry.availableLots))
    .map((entry) => {
      const prefix = vehicleTypeLabel(entry.type);
      if (Number.isFinite(entry.totalLots) && entry.totalLots > 0) {
        return `${prefix}: ${entry.availableLots}/${entry.totalLots}`;
      }
      return `${prefix}: ${entry.availableLots}`;
    });

  return labels.join(" | ");
}

function vehicleTypeLabel(type) {
  if (type === "C") {
    return "Car";
  }
  if (type === "Y") {
    return "Motorcycle";
  }
  if (type === "H") {
    return "Heavy";
  }
  return type || "Other";
}

function sumAvailableLots(lotsByType) {
  return lotsByType.reduce((sum, entry) => sum + toNumber(entry.availableLots), 0);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with ${response.status}`);
  }
  return response.json();
}

function buildLiveLabel(hdbCount, ltaCount, ltaEnabled) {
  if (ltaEnabled) {
    return `Showing ${formatNumber(hdbCount + ltaCount)} live carparks from HDB and LTA DataMall.`;
  }
  return `Showing ${formatNumber(hdbCount)} live HDB carparks.`;
}

function compareCarparks(left, right) {
  if (right.availableLots !== left.availableLots) {
    return right.availableLots - left.availableLots;
  }

  return left.displayName.localeCompare(right.displayName);
}

function humanizeCarparkType(value) {
  return toTitleCase(String(value || "").replaceAll("/", " / "));
}

function toTitleCase(value) {
  return String(value)
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^\d+[a-z]*$/.test(part)) {
        return part.toUpperCase();
      }
      if (part === "/") {
        return "/";
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function buildAddressMapUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${address}, Singapore`)}`;
}

function buildLocationMapUrl(location, displayName, area) {
  const namedQuery = [displayName, area, "Singapore"]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");

  if (namedQuery && displayName) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(namedQuery)}`;
  }

  const [latitude, longitude] = String(location)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (latitude && longitude) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
  }

  const fallback = [displayName, area, "Singapore"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallback)}`;
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  response.end(JSON.stringify(payload));
}

function initializeDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sync_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      trigger_reason TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      payload_json TEXT,
      error_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_snapshots_status_id
      ON sync_snapshots (status, id DESC);

    CREATE TABLE IF NOT EXISTS static_datasets (
      dataset_key TEXT PRIMARY KEY,
      fetched_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) {
      return;
    }

    process.env[key] = rawValue.replace(/^"(.*)"$/, "$1");
  });
}
