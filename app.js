const CARPARKS_API_URL = "/api/carparks";
const AUTO_REFRESH_MS = 60_000;
const MAX_RESULTS = 24;

const state = {
  carparks: [],
  query: "",
  lastUpdated: null,
  sourceSummary: "",
};

const elements = {
  clearButton: document.querySelector("#clear-button"),
  refreshButton: document.querySelector("#refresh-button"),
  resultCount: document.querySelector("#result-count"),
  results: document.querySelector("#results"),
  searchInput: document.querySelector("#search-input"),
  sourceNote: document.querySelector("#source-note"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  suggestions: document.querySelector("#suggestions"),
  template: document.querySelector("#carpark-card-template"),
  updatedAt: document.querySelector("#updated-at"),
};

initialize().catch((error) => {
  console.error(error);
  setStatus("error", "Unable to load carpark data right now.");
  renderEmptyState(
    "Data could not be loaded",
    "The app could not reach its carpark feeds. Check the server logs and try refreshing again."
  );
});

async function initialize() {
  bindEvents();
  await refreshAvailability();
  window.setInterval(() => {
    refreshAvailability({ silent: true }).catch((error) => {
      console.error(error);
      setStatus("error", "Live refresh failed. Showing the last successful snapshot.");
    });
  }, AUTO_REFRESH_MS);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    render();
  });

  elements.clearButton.addEventListener("click", () => {
    state.query = "";
    elements.searchInput.value = "";
    render();
    elements.searchInput.focus();
  });

  elements.refreshButton.addEventListener("click", () => {
    refreshAvailability().catch((error) => {
      console.error(error);
      setStatus("error", "Live refresh failed. Try again in a moment.");
    });
  });
}

async function refreshAvailability(options = {}) {
  if (!options.silent) {
    setStatus("loading", "Refreshing live availability...");
  }

  const response = await fetchJson(CARPARKS_API_URL);
  const sources = response.sources || {};

  state.carparks = Array.isArray(response.carparks) ? response.carparks : [];
  state.lastUpdated = response.generatedAt ? new Date(response.generatedAt) : new Date();
  state.sourceSummary = buildSourceSummary(sources);

  const liveLabel = response.summary?.liveLabel || "Showing live carpark availability.";
  setStatus("live", liveLabel);
  render();
}

function render() {
  const filtered = filterCarparks(state.carparks, state.query);

  elements.resultCount.textContent = `${filtered.length.toLocaleString()} result${
    filtered.length === 1 ? "" : "s"
  }`;
  elements.updatedAt.textContent = state.lastUpdated
    ? `Last refreshed ${formatRelativeTime(state.lastUpdated)}`
    : "Waiting for first live refresh";

  if (elements.sourceNote) {
    elements.sourceNote.textContent = state.sourceSummary;
  }

  renderSuggestions(filtered);
  renderResults(filtered);
}

function renderSuggestions(filtered) {
  elements.suggestions.replaceChildren();

  const quickPicks = state.query ? filtered.slice(0, 5) : state.carparks.slice(0, 5);

  quickPicks.forEach((carpark) => {
    const button = document.createElement("button");
    button.className = "suggestion-button";
    button.type = "button";
    button.textContent = carpark.displayName;
    button.addEventListener("click", () => {
      state.query = carpark.displayName;
      elements.searchInput.value = carpark.displayName;
      render();
    });
    elements.suggestions.append(button);
  });
}

function renderResults(filtered) {
  elements.results.replaceChildren();

  if (!filtered.length) {
    renderEmptyState(
      "No matching carparks",
      "Try a town, mall name, or street. Example searches: Hougang, Albert Centre, Orchard, Aliwal."
    );
    return;
  }

  filtered.slice(0, MAX_RESULTS).forEach((carpark) => {
    const fragment = elements.template.content.cloneNode(true);
    const title = fragment.querySelector(".card-title");
    const kicker = fragment.querySelector(".card-kicker");
    const address = fragment.querySelector(".card-address");
    const availabilityPill = fragment.querySelector(".availability-pill");
    const totalLots = fragment.querySelector(".total-lots");
    const availableLots = fragment.querySelector(".available-lots");
    const carparkCode = fragment.querySelector(".carpark-code");
    const updateTime = fragment.querySelector(".update-time");
    const vehicleBreakdown = fragment.querySelector(".vehicle-breakdown");
    const mapLink = fragment.querySelector(".map-link");

    title.textContent = carpark.displayName;
    kicker.textContent = carpark.categoryLabel;
    address.textContent = carpark.secondaryText;
    totalLots.textContent = formatLotCount(carpark.totalLots);
    availableLots.textContent = formatNumber(carpark.availableLots);
    carparkCode.textContent = carpark.code;
    updateTime.textContent = formatApiDate(carpark.updateDateTime);
    vehicleBreakdown.textContent = carpark.vehicleBreakdown || "Vehicle breakdown not available";
    mapLink.href = carpark.mapUrl || buildFallbackMapUrl(carpark.displayName);

    availabilityPill.textContent = getAvailabilityLabel(carpark.availableLots, carpark.totalLots);
    availabilityPill.classList.remove("low", "empty");
    if (carpark.availableLots === 0) {
      availabilityPill.classList.add("empty");
    } else if (carpark.totalLots > 0 && carpark.availableLots / carpark.totalLots <= 0.2) {
      availabilityPill.classList.add("low");
    }

    elements.results.append(fragment);
  });
}

function renderEmptyState(title, message) {
  elements.results.replaceChildren();

  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  wrapper.innerHTML = `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>`;
  elements.results.append(wrapper);
}

function filterCarparks(carparks, query) {
  if (!query) {
    return carparks;
  }

  const normalizedQuery = query.toLowerCase();
  return carparks.filter((carpark) => carpark.searchText.includes(normalizedQuery));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with ${response.status}`);
  }
  return response.json();
}

function setStatus(mode, text) {
  elements.statusDot.classList.remove("live", "error");

  if (mode === "live") {
    elements.statusDot.classList.add("live");
  }

  if (mode === "error") {
    elements.statusDot.classList.add("error");
  }

  elements.statusText.textContent = text;
}

function buildSourceSummary(sources) {
  if (sources.lta?.enabled) {
    return "Live sources: HDB via data.gov.sg and mall/non-HDB records via LTA DataMall.";
  }

  // if (sources.lta?.configured === false) {
  //   return "Live sources: HDB via data.gov.sg. LTA mall carparks are ready to enable with an LTA AccountKey.";
  // }

  return "Live sources: HDB via data.gov.sg.";
}

function formatRelativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));

  if (diffSeconds < 10) {
    return "just now";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  return `${diffHours}h ago`;
}

function formatApiDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function getAvailabilityLabel(availableLots, totalLots) {
  if (availableLots === 0) {
    return "Full";
  }

  if (totalLots > 0 && availableLots / totalLots <= 0.2) {
    return "Low";
  }

  return "Available";
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function formatLotCount(value) {
  return Number.isFinite(value) && value >= 0 ? value.toLocaleString() : "Not available";
}

function buildFallbackMapUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
