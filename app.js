(function () {
  const cities = window.METRO_CITY_INDEX.cities;
  const cityById = new Map(cities.map((city) => [city.id, city]));
  const homeView = document.getElementById("home-view");
  const mapView = document.getElementById("map-view");
  const provinceFilter = document.getElementById("province-filter");
  const citySearch = document.getElementById("city-search");
  const cityGrid = document.getElementById("city-grid");
  const cityTitle = document.getElementById("city-title");
  const citySubtitle = document.getElementById("city-subtitle");
  const mapTopbar = document.getElementById("map-topbar");
  const lineLegend = document.getElementById("line-legend");
  const styleSelect = document.getElementById("style-select");
  const lineFilters = document.getElementById("line-filters");
  const stationSearch = document.getElementById("station-search");
  const toggleStations = document.getElementById("toggle-stations");
  const toggleLabels = document.getElementById("toggle-labels");
  const toggleLines = document.getElementById("toggle-lines");
  const locateMe = document.getElementById("locate-me");
  const collapseTopbar = document.getElementById("collapse-topbar");
  const collapseLegend = document.getElementById("collapse-legend");

  const styleConfigs = {
    "osm-muted": {
      name: "OSM muted",
      crs: "wgs84",
      muted: true,
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    "osm-colorful": {
      name: "OSM colorful",
      crs: "wgs84",
      muted: false,
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    "amap-muted": {
      name: "高德黑白",
      crs: "gcj02",
      muted: true,
      url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      options: {
        subdomains: ["1", "2", "3", "4"],
        maxZoom: 19,
        attribution: "Basemap &copy; AutoNavi / 高德地图",
      },
    },
    "amap-colorful": {
      name: "高德彩色",
      crs: "gcj02",
      muted: false,
      url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      options: {
        subdomains: ["1", "2", "3", "4"],
        maxZoom: 19,
        attribution: "Basemap &copy; AutoNavi / 高德地图",
      },
    },
  };

  let map;
  let tileLayer;
  let activeCity;
  let activeCityRequest = 0;
  const cityDataCache = new Map();
  let lineLayers = new Map();
  let lineLabels = new Map();
  let stationMarkers = [];
  let stationLabels = [];
  let activeBounds = L.latLngBounds([]);
  let stationsVisible = true;
  let labelsVisible = true;
  let linesVisible = true;
  let highlightedStation = null;
  let locateWatchId = null;
  let locationMarker = null;
  let locationAccuracy = null;
  let lastLocation = null;
  let locationCenteredOnce = false;
  const stationLabelMinZoom = 12;
  const PI = Math.PI;
  const EARTH_A = 6378245.0;
  const EARTH_EE = 0.006693421622965943;

  function provinceOptions() {
    const provinces = [...new Map(cities.map((city) => [city.province, city.province_en])).entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
    provinceFilter.innerHTML = '<option value="">全部省份 / All provinces</option>';
    provinces.forEach(([province, provinceEn]) => {
      const option = document.createElement("option");
      option.value = province;
      option.textContent = `${province} / ${provinceEn}`;
      provinceFilter.append(option);
    });
  }

  function renderCityCards() {
    const province = provinceFilter.value;
    const query = citySearch.value.trim().toLowerCase();
    cityGrid.innerHTML = "";
    cities
      .filter((city) => !province || city.province === province)
      .filter((city) => {
        if (!query) return true;
        return [city.name, city.name_en, city.province, city.province_en]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .forEach((city) => {
        const button = document.createElement("button");
        button.className = "city-card";
        button.type = "button";
        button.innerHTML = `
          <div class="mini-map" aria-hidden="true"></div>
          <h2>${city.name} <span>${city.name_en}</span></h2>
          <p class="meta">${city.province} / ${city.province_en} · ${city.line_count} lines · ${city.station_count} stations</p>
        `;
        button.addEventListener("click", () => openCity(city.id, true));
        cityGrid.append(button);
      });
  }

  function ensureMap() {
    if (map) return;
    map = L.map("map", { zoomControl: false, preferCanvas: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomright", metric: true, imperial: false }).addTo(map);
    const northControl = L.control({ position: "bottomright" });
    northControl.onAdd = () => {
      const container = L.DomUtil.create("div", "north-arrow");
      container.innerHTML = '<span class="north-arrow-symbol">↑</span><span>N</span>';
      container.title = "North / 北";
      return container;
    };
    northControl.addTo(map);
    map.on("zoomend", updateStationLabels);
  }

  function setTileLayer() {
    const config = styleConfigs[styleSelect.value];
    if (tileLayer) tileLayer.remove();
    tileLayer = L.tileLayer(config.url, config.options).addTo(map);
    const pane = map.getPane("tilePane");
    pane.classList.toggle("muted-tiles", config.muted);
  }

  function outOfChina(lon, lat) {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return ret;
  }

  function wgs84ToGcj02(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    let dLat = transformLat(lon - 105.0, lat - 35.0);
    let dLon = transformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EARTH_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((EARTH_A * (1 - EARTH_EE)) / (magic * sqrtMagic)) * PI);
    dLon = (dLon * 180.0) / ((EARTH_A / sqrtMagic) * Math.cos(radLat) * PI);
    return [lon + dLon, lat + dLat];
  }

  function locationLatLng() {
    if (!lastLocation) return null;
    const config = styleConfigs[styleSelect.value];
    const [lon, lat] = config.crs === "gcj02"
      ? wgs84ToGcj02(lastLocation.lon, lastLocation.lat)
      : [lastLocation.lon, lastLocation.lat];
    return [lat, lon];
  }

  function updateLocationLayer(shouldFollow = true) {
    if (!map || !lastLocation) return;
    const latLng = locationLatLng();
    if (!locationMarker) {
      locationMarker = L.circleMarker(latLng, {
        radius: 8,
        color: "#fff",
        weight: 3,
        fillColor: "#1677ff",
        fillOpacity: 1,
        interactive: false,
        className: "user-location-dot",
      }).addTo(map);
      locationAccuracy = L.circle(latLng, {
        radius: lastLocation.accuracy || 0,
        color: "#1677ff",
        weight: 1,
        fillColor: "#1677ff",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    } else {
      locationMarker.setLatLng(latLng);
      locationAccuracy.setLatLng(latLng);
      locationAccuracy.setRadius(lastLocation.accuracy || 0);
    }
    if (shouldFollow) {
      map.setView(latLng, Math.max(map.getZoom(), 15), { animate: true });
    }
  }

  function stopLocate() {
    if (locateWatchId !== null) {
      navigator.geolocation.clearWatch(locateWatchId);
      locateWatchId = null;
    }
    locateMe.setAttribute("aria-pressed", "false");
    locateMe.textContent = "定位 / Locate";
  }

  function startLocate() {
    if (!navigator.geolocation) {
      alert("当前浏览器不支持定位 / Geolocation is not supported by this browser.");
      return;
    }
    locateMe.textContent = "定位中 / Locating";
    locateMe.setAttribute("aria-pressed", "true");
    locationCenteredOnce = false;
    locateWatchId = navigator.geolocation.watchPosition(
      (position) => {
        lastLocation = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        locateMe.textContent = "停止定位 / Stop";
        updateLocationLayer(!locationCenteredOnce);
        locationCenteredOnce = true;
      },
      (error) => {
        stopLocate();
        alert(`定位失败 / Location failed: ${error.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }

  function currentGeometry(feature) {
    const config = styleConfigs[styleSelect.value];
    return config.crs === "gcj02" ? feature.geometry_gcj02 : feature.geometry;
  }

  function featureForDisplay(feature) {
    return {
      type: "Feature",
      properties: feature.properties,
      geometry: currentGeometry(feature),
    };
  }

  function asColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
  }

  function midpointOfGeometry(geometry) {
    const coords = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
    const index = Math.floor(coords.length / 2);
    return [coords[index][1], coords[index][0]];
  }

  function pointSegmentDistanceSq(point, start, end) {
    const [px, py] = point;
    const [ax, ay] = start;
    const [bx, by] = end;
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const x = ax + t * dx;
    const y = ay + t * dy;
    return (px - x) ** 2 + (py - y) ** 2;
  }

  function selectedLineRefs() {
    return new Set([...lineFilters.querySelectorAll("input:checked")].map((input) => input.value));
  }

  function stationNearLine(point, lineRefs) {
    if (!lineRefs.size) return false;
    if (lineRefs.size === lineLayers.size) return true;
    const maxDistanceSq = 0.0045 ** 2;
    for (const lineRef of lineRefs) {
      const feature = activeCity.lines.features.find((item) => String(item.properties.line_ref) === lineRef);
      if (!feature) continue;
      const geometry = currentGeometry(feature);
      for (const line of geometry.coordinates) {
        for (let index = 0; index < line.length - 1; index += 1) {
          if (pointSegmentDistanceSq(point, line[index], line[index + 1]) <= maxDistanceSq) return true;
        }
      }
    }
    return false;
  }

  function clearMetroLayers() {
    [...lineLayers.values()].forEach((set) => {
      set.halo.remove();
      set.color.remove();
    });
    [...lineLabels.values()].forEach((label) => label.remove());
    stationMarkers.forEach((marker) => marker.remove());
    stationLabels.forEach((label) => label.remove());
    lineLayers = new Map();
    lineLabels = new Map();
    stationMarkers = [];
    stationLabels = [];
    lineFilters.innerHTML = "";
    activeBounds = L.latLngBounds([]);
  }

  function renderMetroLayers(options = {}) {
    clearMetroLayers();
    setTileLayer();
    const city = activeCity;

    city.lines.features.forEach((feature) => {
      const displayFeature = featureForDisplay(feature);
      const properties = displayFeature.properties || {};
      const lineRef = String(properties.line_ref || "");
      const color = asColor(properties.colour, "#334155");
      const halo = L.geoJSON(displayFeature, {
        interactive: false,
        style: { color: "#fff", weight: 12, opacity: 0.94, lineCap: "round", lineJoin: "round" },
      });
      const colorLayer = L.geoJSON(displayFeature, {
        style: { color, weight: 7, opacity: 0.98, lineCap: "round", lineJoin: "round" },
      }).bindPopup(
        `<div class="popup-title">${properties.line_name || `${city.name} ${lineRef}`}</div>` +
          `<div class="popup-meta">${properties.way_count || ""} source segments</div>`,
      );
      if (linesVisible) {
        halo.addTo(map);
        colorLayer.addTo(map);
      }
      activeBounds.extend(colorLayer.getBounds());
      lineLayers.set(lineRef, { halo, color: colorLayer });

      const label = L.marker(midpointOfGeometry(displayFeature.geometry), {
        interactive: false,
        icon: L.divIcon({
          className: "line-label",
          html: `<span style="background:${color}">${lineRef}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      });
      if (linesVisible) label.addTo(map);
      lineLabels.set(lineRef, label);
    });

    city.stations.features.forEach((feature) => {
      const properties = feature.properties || {};
      const rawName = properties.name || "";
      const isPlaceholderName = /^Stop \d+$/.test(rawName);
      const displayName = isPlaceholderName ? "" : rawName;
      const coords = currentGeometry(feature).coordinates;
      const latLng = [coords[1], coords[0]];
      const marker = L.marker(latLng, {
        title: displayName,
        icon: L.divIcon({ className: "station-marker", iconSize: [8, 8], iconAnchor: [4, 4] }),
      }).bindPopup(
        `<div class="popup-title">${displayName || "站点"}</div>` +
          `<div class="popup-meta">${city.name} · ${styleConfigs[styleSelect.value].name}</div>`,
      );
      marker.stationName = displayName;
      marker.stationPoint = coords;
      if (stationsVisible) marker.addTo(map);
      stationMarkers.push(marker);
      activeBounds.extend(latLng);

      const label = L.marker(latLng, {
        interactive: false,
        icon: L.divIcon({
          className: "station-label",
          html: displayName ? `<span>${displayName}</span>` : "",
          iconAnchor: [-8, 18],
        }),
      });
      label.stationPoint = coords;
      stationLabels.push(label);
    });

    renderLineFilters();
    updateStationLabels();
    if (options.fitBounds) {
      map.fitBounds(activeBounds.pad(0.08));
    }
  }

  function renderLineFilters() {
    [...lineLayers.keys()].forEach((lineRef) => {
      const feature = activeCity.lines.features.find((item) => String(item.properties.line_ref) === lineRef);
      const color = asColor(feature?.properties?.colour, "#334155");
      const label = document.createElement("label");
      label.className = "line-filter";
      label.innerHTML = `
        <input type="checkbox" value="${lineRef}" checked>
        <span class="swatch" style="background:${color}"></span>
        <span>${lineRef}</span>
      `;
      label.querySelector("input").addEventListener("change", updateLineAndStationVisibility);
      lineFilters.append(label);
    });
    updateLineAndStationVisibility();
  }

  function updateStationLabels() {
    if (!map) return;
    const selected = selectedLineRefs();
    const shouldShow = stationsVisible && labelsVisible && map.getZoom() >= stationLabelMinZoom;
    stationLabels.forEach((label) => {
      if (shouldShow && stationNearLine(label.stationPoint, selected)) label.addTo(map);
      else label.remove();
    });
  }

  function updateStationVisibility() {
    const selected = selectedLineRefs();
    stationMarkers.forEach((marker) => {
      if (stationsVisible && stationNearLine(marker.stationPoint, selected)) marker.addTo(map);
      else marker.remove();
    });
    updateStationLabels();
  }

  function updateLineAndStationVisibility() {
    const selected = selectedLineRefs();
    linesVisible = selected.size > 0;
    toggleLines.setAttribute("aria-pressed", String(linesVisible));
    lineLayers.forEach((layerSet, lineRef) => {
      const enabled = selected.has(lineRef);
      const lineLabel = lineLabels.get(lineRef);
      if (enabled) {
        layerSet.halo.addTo(map);
        layerSet.color.addTo(map);
        lineLabel.addTo(map);
      } else {
        layerSet.halo.remove();
        layerSet.color.remove();
        lineLabel.remove();
      }
    });
    updateStationVisibility();
  }

  function siteBasePath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (cityById.has(last)) {
      parts.pop();
    }
    return `/${parts.join("/")}${parts.length ? "/" : ""}`;
  }

  function loadCityData(cityId) {
    if (cityDataCache.has(cityId)) return Promise.resolve(cityDataCache.get(cityId));
    if (window.METRO_CITY_DETAILS?.[cityId]) {
      cityDataCache.set(cityId, window.METRO_CITY_DETAILS[cityId]);
      return Promise.resolve(window.METRO_CITY_DETAILS[cityId]);
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${siteBasePath()}data/${cityId}.js`;
      script.async = true;
      script.onload = () => {
        const city = window.METRO_CITY_DETAILS?.[cityId];
        if (!city) {
          reject(new Error(`City data did not load: ${cityId}`));
          return;
        }
        cityDataCache.set(cityId, city);
        resolve(city);
      };
      script.onerror = () => reject(new Error(`Failed to load city data: ${cityId}`));
      document.head.append(script);
    });
  }

  async function openCity(cityId, updateUrl = false) {
    const cityMeta = cityById.get(cityId);
    if (!cityMeta) return;
    const requestId = ++activeCityRequest;
    if (updateUrl) {
      history.pushState({ cityId }, "", `${siteBasePath()}${cityId}/`);
    }
    homeView.hidden = true;
    mapView.hidden = false;
    cityTitle.textContent = `${cityMeta.name} ${cityMeta.name_en}`;
    citySubtitle.textContent = `${cityMeta.province} / ${cityMeta.province_en} · loading...`;
    stationSearch.value = "";
    ensureMap();
    try {
      activeCity = await loadCityData(cityId);
    } catch (error) {
      citySubtitle.textContent = `${cityMeta.province} / ${cityMeta.province_en} · failed to load data`;
      console.error(error);
      return;
    }
    if (requestId !== activeCityRequest) return;
    citySubtitle.textContent = `${activeCity.province} / ${activeCity.province_en} · ${activeCity.line_count} lines · ${activeCity.station_count} stations`;
    setTimeout(() => {
      map.invalidateSize();
      renderMetroLayers({ fitBounds: true });
    }, 0);
  }

  function goHome() {
    history.pushState({ cityId: null }, "", siteBasePath());
    mapView.hidden = true;
    homeView.hidden = false;
  }

  document.getElementById("back-home").addEventListener("click", goHome);
  document.getElementById("fit-map").addEventListener("click", () => map.fitBounds(activeBounds.pad(0.08)));
  collapseTopbar.addEventListener("click", () => {
    const collapsed = mapTopbar.classList.toggle("is-collapsed");
    collapseTopbar.textContent = collapsed ? "工具 / Tools" : "⌃";
    collapseTopbar.setAttribute("aria-expanded", String(!collapsed));
    setTimeout(() => map?.invalidateSize(), 160);
  });
  collapseLegend.addEventListener("click", () => {
    const collapsed = lineLegend.classList.toggle("is-collapsed");
    collapseLegend.textContent = collapsed ? "线路 / Lines" : "⌄";
    collapseLegend.setAttribute("aria-expanded", String(!collapsed));
    setTimeout(() => map?.invalidateSize(), 160);
  });
  styleSelect.addEventListener("change", () => renderMetroLayers());
  styleSelect.addEventListener("change", () => updateLocationLayer(false));
  locateMe.addEventListener("click", () => {
    if (locateWatchId === null) startLocate();
    else stopLocate();
  });
  toggleStations.addEventListener("click", (event) => {
    stationsVisible = !stationsVisible;
    event.currentTarget.setAttribute("aria-pressed", String(stationsVisible));
    updateStationVisibility();
  });
  toggleLabels.addEventListener("click", (event) => {
    labelsVisible = !labelsVisible;
    event.currentTarget.setAttribute("aria-pressed", String(labelsVisible));
    updateStationLabels();
  });
  toggleLines.addEventListener("click", (event) => {
    const shouldSelectAll = selectedLineRefs().size === 0;
    lineFilters.querySelectorAll("input").forEach((input) => {
      input.checked = shouldSelectAll;
    });
    event.currentTarget.setAttribute("aria-pressed", String(shouldSelectAll));
    updateLineAndStationVisibility();
  });
  stationSearch.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (highlightedStation) {
      highlightedStation.getElement()?.classList.remove("highlight");
      highlightedStation = null;
    }
    if (!query) return;
    const match = stationMarkers.find((marker) => marker.stationName.toLowerCase().includes(query));
    if (!match) return;
    if (!stationsVisible) {
      stationsVisible = true;
      toggleStations.setAttribute("aria-pressed", "true");
      updateStationVisibility();
    }
    map.setView(match.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
    match.openPopup();
    highlightedStation = match;
    setTimeout(() => match.getElement()?.classList.add("highlight"), 180);
  });

  provinceFilter.addEventListener("change", renderCityCards);
  citySearch.addEventListener("input", renderCityCards);

  provinceOptions();
  renderCityCards();

  window.addEventListener("popstate", () => {
    const currentCityId = location.pathname
      .split("/")
      .filter(Boolean)
      .pop();
    if (cityById.has(currentCityId)) {
      openCity(currentCityId, false);
    } else {
      mapView.hidden = true;
      homeView.hidden = false;
    }
  });

  const pathCityId = location.pathname
    .split("/")
    .filter(Boolean)
    .pop();
  if (cityById.has(pathCityId)) {
    openCity(pathCityId);
  }
})();
