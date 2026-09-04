(() => {
    "use strict";

    const API_BASE = "https://esports-api.lolesports.com/persisted/gw";
    const API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
    const LOCALE = "en-US";
    const MAX_PAGES_PER_LEAGUE = 45;
    const STORAGE_KEY = "lol-calendar-selected-leagues-v2";

    let liveScoreTimer = null;

    let polymarketEvents = [];
    let polymarketLoadedAt = 0;

    let polymarketTeams = [];
    let polymarketTeamsLoadedAt = 0;

    const POLYMARKET_CACHE_MS = 5 * 60 * 1000;
    const POLYMARKET_TEAM_CACHE_MS = 60 * 60 * 1000;
    const state = {
        leagues: [],
        selected: new Set(),
        events: [],
        month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        requestId: 0,
    };

    const $ = (selector) => document.querySelector(selector);
    const ui = {
        leagueList: $("#leagueList"),
        leagueSearch: $("#leagueSearch"),
        selectedCount: $("#selectedCount"),
        status: $("#status"),
        monthTitle: $("#monthTitle"),
        matchCount: $("#matchCount"),
        timezone: $("#timezone"),
        calendar: $("#calendar"),
        prev: $("#prevMonth"),
        next: $("#nextMonth"),
        today: $("#todayBtn"),
        major: $("#majorBtn"),
        all: $("#allBtn"),
        none: $("#noneBtn"),
        dialog: $("#matchDialog"),
        dialogClose: $("#closeDialog"),
        matchDetails: $("#matchDetails"),
    };

    function apiUrl(path, params = {}) {
        const url = new URL(API_BASE + path);
        url.searchParams.set("hl", LOCALE);
        for (const [key, value] of Object.entries(params)) {
            if (value !== null && value !== undefined && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }
        return url;
    }

    async function apiGet(path, params = {}) {
        const response = await fetch(apiUrl(path, params), {
            headers: { "x-api-key": API_KEY },
        });

        if (!response.ok) {
            let detail = "";
            try { detail = await response.text(); } catch (_) {}
            throw new Error(`LoL Esports API ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
        }
        return response.json();
    }

    function leagueText(league) {
        return `${league.name || league.slug || "League"}${league.region ? ` · ${league.region}` : ""}`;
    }

    function isMajor(league) {
        const text = `${league.slug || ""} ${league.name || ""}`.toLowerCase();
        return [
            /\blck\b/, /\blpl\b/, /\blec\b/, /\blcs\b/,
            /\bmsi\b/, /mid.?season invitational/, /\bworlds\b/, /world championship/
        ].some((pattern) => pattern.test(text));
    }

    function saveSelection() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selected])); } catch (_) {}
    }

    function restoreSelection() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            if (Array.isArray(saved)) return new Set(saved.map(String));
        } catch (_) {}
        return null;
    }

    function eventKey(event) {
        if (event?.match?.id) return String(event.match.id);
        const teams = event?.match?.teams || [];
        return [
            event?.startTime || "",
            event?.league?.id || "",
            ...teams.map((t) => t?.name || t?.code || ""),
        ].join("|");
    }

    function dateValue(event) {
        const ms = Date.parse(event?.startTime || "");
        return Number.isFinite(ms) ? ms : null;
    }

    function monthBoundsUtcApprox() {
        const y = state.month.getFullYear();
        const m = state.month.getMonth();
        // Padding protects matches near month boundaries after timezone conversion.
        const start = Date.UTC(y, m, 1) - 2 * 86400000;
        const end = Date.UTC(y, m + 1, 1) + 2 * 86400000;
        return { start, end };
    }

    function pageRange(events) {
        const times = events.map(dateValue).filter((v) => v !== null);
        return times.length ? { min: Math.min(...times), max: Math.max(...times) } : null;
    }

    function pageSchedule(payload) {
        return payload?.data?.schedule || {};
    }

    function tokenFrom(schedule, direction) {
        const token = schedule?.pages?.[direction];
        return typeof token === "string" && token.length ? token : null;
    }

    async function fetchPage(leagueId, pageToken = null) {
        const params = { leagueId };
        if (pageToken) params.pageToken = pageToken;
        const payload = await apiGet("/getSchedule", params);
        return pageSchedule(payload);
    }

    async function fetchLeagueForVisibleMonth(leagueId) {
        const { start, end } = monthBoundsUtcApprox();
        const merged = new Map();
        let pagesChecked = 0;

        const first = await fetchPage(leagueId);
        pagesChecked++;
        for (const event of first.events || []) merged.set(eventKey(event), event);

        const firstRange = pageRange(first.events || []);
        if (!firstRange) return { events: [], pagesChecked };

        // If the first page is later than our month, walk older.
        // If it is earlier, walk newer.
        // If it overlaps, walk both ways because a month can straddle pages.
        let directions;
        if (firstRange.min >= end) directions = ["older"];
        else if (firstRange.max < start) directions = ["newer"];
        else directions = ["older", "newer"];

        for (const direction of directions) {
            let schedule = first;
            let token = tokenFrom(schedule, direction);
            const seen = new Set();

            while (token && !seen.has(token) && pagesChecked < MAX_PAGES_PER_LEAGUE) {
                seen.add(token);
                schedule = await fetchPage(leagueId, token);
                pagesChecked++;

                const events = schedule.events || [];
                for (const event of events) merged.set(eventKey(event), event);

                const range = pageRange(events);
                if (!range) break;

                // Once a page is fully beyond the padded visible-month window,
                // continuing farther in the same direction cannot help.
                if (direction === "older" && range.max < start) break;
                if (direction === "newer" && range.min >= end) break;

                token = tokenFrom(schedule, direction);
            }
        }

        return { events: [...merged.values()], pagesChecked };
    }

    function localDateKey(date) {
        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function eventIsInVisibleLocalMonth(event) {
        const d = new Date(event.startTime);
        return d.getFullYear() === state.month.getFullYear() &&
            d.getMonth() === state.month.getMonth();
    }

    function setBusy(busy) {
        [ui.prev, ui.next, ui.today, ui.major, ui.all, ui.none].forEach((b) => b.disabled = busy);
    }

    function setStatus(message, error = false) {
        ui.status.textContent = message;
        ui.status.classList.toggle("error", error);
    }

    function renderLeagueList() {
        const q = ui.leagueSearch.value.trim().toLowerCase();
        const visible = state.leagues.filter((l) => leagueText(l).toLowerCase().includes(q));
        ui.leagueList.replaceChildren();

        for (const league of visible) {
            const label = document.createElement("label");
            label.className = "league-row";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = state.selected.has(String(league.id));
            checkbox.addEventListener("change", () => {
                const id = String(league.id);
                checkbox.checked ? state.selected.add(id) : state.selected.delete(id);
                saveSelection();
                updateSelectedCount();
                loadSchedule();
            });

            const name = document.createElement("span");
            name.textContent = leagueText(league);
            label.append(checkbox, name);
            ui.leagueList.append(label);
        }
        updateSelectedCount();
    }

    function updateSelectedCount() {
        ui.selectedCount.textContent = `${state.selected.size} selected`;
    }
    function matchHasAlreadyStarted(event) {
        /*
         * Keep live matches visually active.
         * Completed matches are always dimmed.
         * Otherwise, once the scheduled start time has passed,
         * treat the calendar card as a past match.
         */
        if (event?.state === "inProgress") {
            return false;
        }

        if (
            event?.state === "completed" ||
            event?.state === "finished"
        ) {
            return true;
        }

        const startTime =
            new Date(
                event?.startTime
            ).getTime();

        return (
            Number.isFinite(startTime) &&
            startTime < Date.now()
        );
    }

    function matchButton(event) {
        const teams = event?.match?.teams || [];
        const a = teams[0]?.name || teams[0]?.code || "TBD";
        const b = teams[1]?.name || teams[1]?.code || "TBD";
        const d = new Date(event.startTime);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "match";

        if (matchHasAlreadyStarted(event)) {
            button.classList.add("past-match");
        }

        const time = document.createElement("span");
        time.className = "time";
        time.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

        const teamText = document.createElement("span");
        teamText.className = "teams";
        teamText.textContent = `${a} vs ${b}`;

        const leagueTextNode = document.createElement("span");
        leagueTextNode.className = "league";
        leagueTextNode.textContent = event?.league?.name || "League";

        button.append(time, teamText, leagueTextNode);
        button.addEventListener("click", () => openMatch(event));
        return button;
    }
    async function getMatchDetails(matchId) {
        const payload = await apiGet("/getEventDetails", {
            id: matchId
        });

        console.log("Match details response:", payload);

        return payload?.data?.event || null;
    }

    function normalizePolymarketText(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\besports\b/g, "")
            .replace(/\bgaming\b/g, "")
            .replace(/[^a-z0-9]/g, "");
    }

    async function loadPolymarketTeams() {
        const now = Date.now();

        if (
            polymarketTeams.length &&
            now - polymarketTeamsLoadedAt < POLYMARKET_TEAM_CACHE_MS
        ) {
            return polymarketTeams;
        }

        try {
            const allTeams = [];
            const limit = 100;
            let offset = 0;

            for (let page = 0; page < 50; page++) {
                const url = new URL(
                    "https://gamma-api.polymarket.com/teams"
                );

                url.searchParams.set("limit", String(limit));
                url.searchParams.set("offset", String(offset));

                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(
                        `Polymarket teams API ${response.status}`
                    );
                }

                const teams = await response.json();

                if (!Array.isArray(teams)) break;

                allTeams.push(...teams);

                if (teams.length < limit) break;

                offset += limit;
            }

            polymarketTeams = allTeams;
            polymarketTeamsLoadedAt = Date.now();

            console.log(
                "Loaded Polymarket teams:",
                polymarketTeams.length
            );

            return polymarketTeams;
        } catch (error) {
            console.error(
                "Could not load Polymarket teams:",
                error
            );

            return [];
        }
    }

    function addPolymarketAliasValue(aliases, value) {
        if (!value) return;

        if (Array.isArray(value)) {
            for (const item of value) {
                addPolymarketAliasValue(
                    aliases,
                    item
                );
            }

            return;
        }

        const normalized =
            normalizePolymarketText(value);

        if (normalized) {
            aliases.add(normalized);
        }
    }

    async function polymarketTeamAliases(name, code) {
        const normalizedName =
            normalizePolymarketText(name);

        const normalizedCode =
            normalizePolymarketText(code);

        const aliases = new Set();

        if (normalizedName) {
            aliases.add(normalizedName);
        }

        if (normalizedCode) {
            aliases.add(normalizedCode);
        }

        /*
         * Keep a few known fallbacks, but most team
         * abbreviations will now come automatically
         * from Polymarket's /teams endpoint.
         */
        const knownAliases = {
            bnkfearx: [
                "bnkfearx",
                "fearx",
                "fox",
                "fox1"
            ],
            dpluskia: [
                "dpluskia",
                "dplus",
                "dk"
            ],
            hanwhalife: [
                "hanwhalife",
                "hle",
                "hle1"
            ],
            geng: [
                "geng",
                "gen"
            ],
            ktrolster: [
                "ktrolster",
                "kt"
            ],
            nongshimredforce: [
                "nongshimredforce",
                "nongshim",
                "ns"
            ],
            drx: ["drx"],
            t1: ["t1"]
        };

        const extras =
            knownAliases[normalizedName];

        if (extras) {
            for (const alias of extras) {
                addPolymarketAliasValue(
                    aliases,
                    alias
                );
            }
        }

        const teams =
            await loadPolymarketTeams();

        let bestTeam = null;
        let bestScore = 0;

        for (const team of teams) {
            const polyName =
                normalizePolymarketText(
                    team?.name
                );

            const polyAbbreviation =
                normalizePolymarketText(
                    team?.abbreviation
                );

            const polyAliases = [];

            if (Array.isArray(team?.alias)) {
                for (const alias of team.alias) {
                    const normalized =
                        normalizePolymarketText(alias);

                    if (normalized) {
                        polyAliases.push(normalized);
                    }
                }
            } else {
                const normalized =
                    normalizePolymarketText(
                        team?.alias
                    );

                if (normalized) {
                    polyAliases.push(normalized);
                }
            }

            let score = 0;

            if (
                normalizedCode &&
                polyAbbreviation &&
                normalizedCode === polyAbbreviation
            ) {
                score += 300;
            }

            if (
                normalizedName &&
                polyName &&
                normalizedName === polyName
            ) {
                score += 300;
            }

            if (
                normalizedName &&
                polyAliases.includes(normalizedName)
            ) {
                score += 250;
            }

            if (
                normalizedCode &&
                polyAliases.includes(normalizedCode)
            ) {
                score += 250;
            }

            if (
                normalizedName.length >= 5 &&
                polyName.length >= 5 &&
                (
                    normalizedName.includes(polyName) ||
                    polyName.includes(normalizedName)
                )
            ) {
                score += 100;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTeam = team;
            }
        }

        if (
            bestTeam &&
            bestScore >= 100
        ) {
            addPolymarketAliasValue(
                aliases,
                bestTeam?.name
            );

            addPolymarketAliasValue(
                aliases,
                bestTeam?.abbreviation
            );

            addPolymarketAliasValue(
                aliases,
                bestTeam?.alias
            );

            console.log(
                "Automatic Polymarket team match:",
                {
                    riotName: name,
                    riotCode: code,
                    polymarketTeam: bestTeam,
                    score: bestScore,
                    aliases: [...aliases]
                }
            );
        } else {
            console.log(
                "No automatic Polymarket team match:",
                {
                    riotName: name,
                    riotCode: code,
                    aliases: [...aliases]
                }
            );
        }

        return [...aliases].filter(Boolean);
    }

    function isLeagueOfLegendsPolymarketEvent(event) {
        const seriesSlug =
            String(event?.seriesSlug || "")
                .toLowerCase();

        if (seriesSlug === "league-of-legends") {
            return true;
        }

        if (Array.isArray(event?.series)) {
            const hasLolSeries =
                event.series.some(series => {
                    const slug =
                        String(series?.slug || "")
                            .toLowerCase();

                    const title =
                        String(
                            series?.title ||
                            series?.name ||
                            ""
                        ).toLowerCase();

                    return (
                        slug === "league-of-legends" ||
                        title === "league of legends"
                    );
                });

            if (hasLolSeries) {
                return true;
            }
        }

        if (Array.isArray(event?.tags)) {
            const hasLolTag =
                event.tags.some(tag => {
                    const slug =
                        String(tag?.slug || "")
                            .toLowerCase();

                    const label =
                        String(
                            tag?.label ||
                            tag?.name ||
                            ""
                        ).toLowerCase();

                    return (
                        slug === "league-of-legends" ||
                        label === "league of legends"
                    );
                });

            if (hasLolTag) {
                return true;
            }
        }

        /*
         * Polymarket esports matchup titles commonly begin
         * with "LoL:". This is much safer than searching for
         * the substring "lol", which incorrectly matched Hylo.
         */
        const title =
            String(event?.title || "")
                .trim()
                .toLowerCase();

        if (title.startsWith("lol:")) {
            return true;
        }

        /*
         * Season/tournament markets can use a LoL-prefixed
         * slug without having "LoL:" in the title.
         */
        const slug =
            String(event?.slug || "")
                .toLowerCase();

        return /^lol-[a-z0-9]/.test(slug);
    }

    async function loadPolymarketEvents() {
        const now = Date.now();

        if (
            polymarketEvents.length &&
            now - polymarketLoadedAt <
            POLYMARKET_CACHE_MS
        ) {
            return polymarketEvents;
        }

        try {
            const found = new Map();

            /*
             * Use Polymarket's search endpoint directly instead
             * of downloading arbitrary general events first.
             *
             * public-search supports q, limit_per_type, page,
             * and pagination.hasMore, so we can walk through
             * League of Legends-specific search results.
             */
            const queries = [
                "League of Legends",
                "LoL:"
            ];

            for (const query of queries) {
                for (let page = 1; page <= 50; page++) {
                    const url = new URL(
                        "https://gamma-api.polymarket.com/public-search"
                    );

                    url.searchParams.set("q", query);
                    url.searchParams.set(
                        "limit_per_type",
                        "100"
                    );
                    url.searchParams.set(
                        "page",
                        String(page)
                    );
                    url.searchParams.set(
                        "search_profiles",
                        "false"
                    );
                    url.searchParams.set(
                        "keep_closed_markets",
                        "0"
                    );

                    const response =
                        await fetch(url);

                    if (!response.ok) {
                        throw new Error(
                            `Polymarket search API ${response.status}`
                        );
                    }

                    const data =
                        await response.json();

                    const events = [
                        ...(Array.isArray(data?.events)
                            ? data.events
                            : []),
                        ...(Array.isArray(
                            data?.results?.events
                        )
                            ? data.results.events
                            : [])
                    ];

                    for (const event of events) {
                        if (
                            event?.slug &&
                            isLeagueOfLegendsPolymarketEvent(
                                event
                            )
                        ) {
                            found.set(
                                event.slug,
                                event
                            );
                        }
                    }

                    const hasMore =
                        data?.pagination?.hasMore === true;

                    if (!hasMore) {
                        break;
                    }
                }
            }

            polymarketEvents =
                [...found.values()]
                    .filter(event =>
                        event?.active !== false &&
                        event?.closed !== true &&
                        event?.archived !== true
                    );

            polymarketLoadedAt =
                Date.now();

            console.log(
                `Loaded ${polymarketEvents.length} active Polymarket LoL events:`,
                polymarketEvents
            );

            return polymarketEvents;
        } catch (error) {
            console.error(
                "Could not load Polymarket LoL events:",
                error
            );

            return [];
        }
    }

    function polymarketAliasPresent(item, alias) {
        if (!alias) return false;

        const normalizedText = normalizePolymarketText([
            item?.title,
            item?.question,
            item?.subtitle,
            item?.description,
            item?.slug
        ].filter(Boolean).join(" "));

        const slugParts = String(item?.slug || "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);

        if (alias.length <= 4) {
            return slugParts.includes(alias);
        }

        return normalizedText.includes(alias);
    }

    function polymarketDateDifference(item, riotTime) {
        /*
         * BEST SOURCE:
         * Polymarket's actual scheduled match time.
         */
        if (item?.startTime) {
            const matchTime =
                new Date(item.startTime).getTime();

            if (Number.isFinite(matchTime)) {
                return Math.abs(
                    matchTime - riotTime
                );
            }
        }

        /*
         * Next best source:
         * explicit esports event date.
         */
        if (item?.eventDate) {
            const eventTime =
                new Date(
                    item.eventDate +
                    "T12:00:00Z"
                ).getTime();

            if (Number.isFinite(eventTime)) {
                return Math.abs(
                    eventTime - riotTime
                );
            }
        }

        /*
         * Next try the YYYY-MM-DD
         * contained in the esports slug.
         *
         * Example:
         * lol-cpd-wu-2026-09-09
         */
        const slugDate =
            String(item?.slug || "")
                .match(
                    /(\d{4}-\d{2}-\d{2})/
                );

        if (slugDate) {
            const slugTime =
                new Date(
                    slugDate[1] +
                    "T12:00:00Z"
                ).getTime();

            if (Number.isFinite(slugTime)) {
                return Math.abs(
                    slugTime - riotTime
                );
            }
        }

        /*
         * Don't use Polymarket's market-open date here.
         * It can represent when the market was created,
         * not when the esports match is scheduled.
         */

        return Infinity;
    }

    function polymarketTeamIdentityFromAliases(aliases) {
        const aliasSet =
            new Set(
                (aliases || [])
                    .map(normalizePolymarketText)
                    .filter(Boolean)
            );

        let best = null;
        let bestScore = 0;

        for (const team of polymarketTeams) {
            const values = [
                team?.name,
                team?.abbreviation
            ];

            if (Array.isArray(team?.alias)) {
                values.push(...team.alias);
            } else {
                values.push(team?.alias);
            }

            const normalizedValues =
                values
                    .map(normalizePolymarketText)
                    .filter(Boolean);

            let score = 0;

            for (const value of normalizedValues) {
                if (aliasSet.has(value)) {
                    score += value.length <= 6 ? 300 : 200;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                best = team;
            }
        }

        return bestScore > 0
            ? {
                id: String(best?.id ?? ""),
                name: best?.name || "",
                abbreviation:
                    best?.abbreviation || "",
                league: best?.league || "",
                alias: best?.alias || ""
            }
            : null;
    }

    function collectPolymarketEventTeamIds(event) {
        const ids = new Set();

        function add(value) {
            if (
                value !== null &&
                value !== undefined &&
                value !== ""
            ) {
                ids.add(String(value));
            }
        }

        function inspectTeam(team) {
            if (!team || typeof team !== "object") {
                return;
            }

            add(team.id);
            add(team.teamId);
            add(team.team_id);
        }

        if (Array.isArray(event?.teams)) {
            event.teams.forEach(inspectTeam);
        }

        if (
            Array.isArray(
                event?.eventMetadata?.teams
            )
        ) {
            event.eventMetadata.teams
                .forEach(inspectTeam);
        }

        for (const key of [
            "homeTeam",
            "awayTeam",
            "teamA",
            "teamB"
        ]) {
            inspectTeam(event?.[key]);
            inspectTeam(
                event?.eventMetadata?.[key]
            );
        }

        if (Array.isArray(event?.markets)) {
            for (const market of event.markets) {
                if (Array.isArray(market?.teams)) {
                    market.teams.forEach(inspectTeam);
                }

                for (const key of [
                    "homeTeam",
                    "awayTeam",
                    "teamA",
                    "teamB"
                ]) {
                    inspectTeam(market?.[key]);
                }
            }
        }

        return ids;
    }

    async function loadPolymarketEventsNearMatch(
        matchDate
    ) {
        const riotDateKey =
            riotCalendarDateKey(
                matchDate
            );

        if (!riotDateKey) {
            return [];
        }

        const found =
            new Map();

        /*
         * PRIMARY LOOKUP:
         * Ask Polymarket for the exact event_date from Riot's
         * calendar. This matters because some esports events
         * do not reliably appear when filtering by start_time.
         */
        async function fetchKeyset(params) {
            let afterCursor = null;

            for (
                let page = 0;
                page < 10;
                page++
            ) {
                const url =
                    new URL(
                        "https://gamma-api.polymarket.com/events/keyset"
                    );

                url.searchParams.set(
                    "limit",
                    "500"
                );

                url.searchParams.set(
                    "closed",
                    "false"
                );

                for (
                    const [key, value]
                    of Object.entries(params)
                    ) {
                    if (
                        value !== null &&
                        value !== undefined &&
                        value !== ""
                    ) {
                        url.searchParams.set(
                            key,
                            value
                        );
                    }
                }

                if (afterCursor) {
                    url.searchParams.set(
                        "after_cursor",
                        afterCursor
                    );
                }

                const response =
                    await fetch(url);

                if (!response.ok) {
                    console.warn(
                        "Polymarket keyset API failed:",
                        response.status,
                        Object.fromEntries(
                            url.searchParams.entries()
                        )
                    );
                    return;
                }

                const data =
                    await response.json();

                const events =
                    Array.isArray(data?.events)
                        ? data.events
                        : [];

                for (const event of events) {
                    if (
                        event?.slug &&
                        isLeagueOfLegendsPolymarketEvent(
                            event
                        )
                    ) {
                        found.set(
                            event.slug,
                            event
                        );
                    }
                }

                afterCursor =
                    data?.next_cursor ||
                    data?.nextCursor ||
                    null;

                if (!afterCursor) {
                    break;
                }
            }
        }

        /*
         * Polymarket documents event_date as a date-time
         * filter. Noon UTC avoids edge-of-day ambiguity while
         * still representing the Riot calendar day.
         */
        await fetchKeyset({
            event_date:
                `${riotDateKey}T12:00:00Z`
        });

        /*
         * FALLBACK:
         * If event_date returns nothing, try a generous
         * start_time range around the exact calendar day.
         */
        if (!found.size) {
            const dayStart =
                new Date(
                    `${riotDateKey}T00:00:00Z`
                ).getTime();

            const startTimeMin =
                new Date(
                    dayStart -
                    12 * 60 * 60 * 1000
                ).toISOString();

            const startTimeMax =
                new Date(
                    dayStart +
                    36 * 60 * 60 * 1000
                ).toISOString();

            await fetchKeyset({
                start_time_min:
                startTimeMin,
                start_time_max:
                startTimeMax
            });
        }

        const events =
            [...found.values()];

        console.log(
            "Polymarket LoL events for exact Riot date:",
            {
                riotDate:
                riotDateKey,
                count:
                events.length,
                events
            }
        );

        return events;
    }

    function addGenericChallengersAliases(
        teamName,
        teamCode,
        aliases
    ) {
        const result =
            new Set(
                (aliases || [])
                    .map(normalizePolymarketText)
                    .filter(Boolean)
            );

        const normalizedName =
            normalizePolymarketText(
                teamName
            );

        const normalizedCode =
            normalizePolymarketText(
                teamCode
            );

        /*
         * Generic rule, not team-specific:
         * Polymarket often appends "c" to a parent-team code
         * for Challengers teams (example: DNS -> DNSC).
         *
         * We only use this to HELP DISCOVERY. The exact Riot
         * calendar date is still mandatory later.
         */
        if (
            normalizedName.includes(
                "challengers"
            ) &&
            normalizedCode
        ) {
            result.add(
                `${normalizedCode}c`
            );
        }

        return [...result];
    }

    async function searchPolymarketEvents(
        teamA,
        teamB,
        teamACode,
        teamBCode,
        aliasesA,
        aliasesB,
        matchDate
    ) {
        const searches = new Set();

        searches.add(`${teamA} ${teamB}`);

        if (teamACode && teamBCode) {
            searches.add(`${teamACode} ${teamBCode}`);
        }

        for (const a of aliasesA.slice(0, 4)) {
            for (const b of aliasesB.slice(0, 4)) {
                searches.add(`${a} ${b}`);
            }
        }

        const riotDateKey =
            riotCalendarDateKey(
                matchDate
            );

        /*
         * If Riot and Polymarket disagree on one team name,
         * searching both teams together can miss the market.
         * Search each short alias independently with the exact
         * Riot date as well.
         *
         * Example:
         * Riot DNS Challengers -> generic alias DNSC
         * query: "dnsc 2026-09-07"
         * can discover: lol-drxc-dnsc-2026-09-07
         */
        if (riotDateKey) {
            for (
                const alias of
                aliasesA.slice(0, 5)
                ) {
                searches.add(
                    `${alias} ${riotDateKey}`
                );
            }

            for (
                const alias of
                aliasesB.slice(0, 5)
                ) {
                searches.add(
                    `${alias} ${riotDateKey}`
                );
            }
        }

        const found = new Map();

        for (const query of searches) {
            try {
                const url = new URL(
                    "https://gamma-api.polymarket.com/public-search"
                );
                url.searchParams.set("q", query);
                url.searchParams.set("limit_per_type", "100");
                url.searchParams.set("search_profiles", "false");
                url.searchParams.set("keep_closed_markets", "0");

                const response = await fetch(url);

                if (!response.ok) {
                    console.warn("Polymarket search failed:", response.status, query);
                    continue;
                }

                const data = await response.json();

                const events = [
                    ...(Array.isArray(data?.events) ? data.events : []),
                    ...(Array.isArray(data?.results?.events) ? data.results.events : [])
                ];

                for (const item of events) {
                    if (item?.slug) found.set(item.slug, item);
                }
            } catch (error) {
                console.warn("Polymarket search failed for:", query, error);
            }
        }

        return [...found.values()];
    }

    async function searchPolymarketRescheduleEvents(
        teamA,
        teamB,
        teamACode,
        teamBCode,
        aliasesA,
        aliasesB
    ) {
        const searches =
            new Set();

        searches.add(`${teamA} ${teamB}`);

        if (teamACode && teamBCode) {
            searches.add(
                `${teamACode} ${teamBCode}`
            );
        }

        const shortA =
            (aliasesA || [])
                .filter(alias =>
                    alias.length >= 2 &&
                    alias.length <= 8
                )
                .slice(0, 5);

        const shortB =
            (aliasesB || [])
                .filter(alias =>
                    alias.length >= 2 &&
                    alias.length <= 8
                )
                .slice(0, 5);

        for (const a of shortA) {
            for (const b of shortB) {
                searches.add(`${a} ${b}`);
                searches.add(`${b} ${a}`);
            }
        }

        for (
            const a of
            (aliasesA || []).slice(0, 4)
            ) {
            for (
                const b of
                (aliasesB || []).slice(0, 4)
                ) {
                searches.add(`${a} ${b}`);
            }
        }

        const found =
            new Map();

        for (const query of searches) {
            try {
                const url =
                    new URL(
                        "https://gamma-api.polymarket.com/public-search"
                    );

                url.searchParams.set(
                    "q",
                    query
                );
                url.searchParams.set(
                    "limit_per_type",
                    "100"
                );
                url.searchParams.set(
                    "search_profiles",
                    "false"
                );
                url.searchParams.set(
                    "keep_closed_markets",
                    "0"
                );

                const response =
                    await fetch(url);

                if (!response.ok) {
                    continue;
                }

                const data =
                    await response.json();

                const events = [
                    ...(Array.isArray(data?.events)
                        ? data.events
                        : []),
                    ...(Array.isArray(
                        data?.results?.events
                    )
                        ? data.results.events
                        : [])
                ];

                for (const item of events) {
                    if (
                        item?.slug &&
                        isLeagueOfLegendsPolymarketEvent(
                            item
                        )
                    ) {
                        found.set(
                            item.slug,
                            item
                        );
                    }
                }
            } catch (error) {
                console.warn(
                    "Polymarket reschedule search failed for:",
                    query,
                    error
                );
            }
        }

        const events =
            [...found.values()];

        console.log(
            "Polymarket reschedule search:",
            {
                teamA,
                teamB,
                count: events.length,
                events
            }
        );

        return events;
    }

    function normalizeLeagueName(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\bleague of legends\b/g, "")
            .replace(/\besports\b/g, "")
            .replace(/\bgaming\b/g, "")
            .replace(/[^a-z0-9]/g, "");
    }

    function leagueInitials(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, " ")
            .split(/\s+/)
            .filter(Boolean)
            .map(part => part[0])
            .join("");
    }

    function polymarketLeagueScore(item, riotLeagueName) {
        const riotLeague =
            normalizeLeagueName(riotLeagueName);

        const polyLeagueRaw =
            item?.eventMetadata?.league ||
            item?.league ||
            item?.competition ||
            "";

        const polyLeague =
            normalizeLeagueName(polyLeagueRaw);

        let score = 0;
        let relation = "unknown";

        if (
            riotLeague &&
            polyLeague
        ) {
            if (riotLeague === polyLeague) {
                score += 1000;
                relation = "exact";
            } else if (
                riotLeague.length >= 4 &&
                polyLeague.length >= 4 &&
                (
                    riotLeague.includes(polyLeague) ||
                    polyLeague.includes(riotLeague)
                )
            ) {
                score += 700;
                relation = "contains";
            } else {
                const riotInitials =
                    leagueInitials(riotLeagueName);

                const polyInitials =
                    leagueInitials(polyLeagueRaw);

                const riotIsShortCode =
                    /^[a-z0-9]{2,8}$/.test(
                        riotLeague
                    );

                const polyIsShortCode =
                    /^[a-z0-9]{2,8}$/.test(
                        polyLeague
                    );

                if (
                    riotInitials.length >= 2 &&
                    riotInitials === polyInitials
                ) {
                    score += 500;
                    relation = "initials";
                } else if (
                    riotIsShortCode &&
                    riotLeague === polyInitials
                ) {
                    score += 500;
                    relation = "initials";
                } else if (
                    polyIsShortCode &&
                    polyLeague === riotInitials
                ) {
                    score += 500;
                    relation = "initials";
                } else {
                    score -= 250;
                    relation = "mismatch";
                }
            }
        }

        const seriesSlug =
            String(item?.seriesSlug || "")
                .toLowerCase();

        const seriesTitles =
            Array.isArray(item?.series)
                ? item.series.map(series =>
                    String(
                        series?.slug ||
                        series?.title ||
                        series?.name ||
                        ""
                    ).toLowerCase()
                )
                : [];

        const isLeagueOfLegends =
            seriesSlug === "league-of-legends" ||
            seriesTitles.some(value =>
                value.includes("league-of-legends") ||
                value.includes("league of legends")
            ) ||
            String(item?.title || "")
                .toLowerCase()
                .startsWith("lol:");

        if (isLeagueOfLegends) {
            score += 100;
        }

        return {
            score,
            relation,
            riotLeague: riotLeagueName || "",
            polymarketLeague: polyLeagueRaw || "",
            isLeagueOfLegends
        };
    }

    function riotCalendarDateKey(matchDate) {
        const date =
            new Date(matchDate);

        if (
            Number.isNaN(date.getTime())
        ) {
            return "";
        }

        /*
         * Riot schedule dates are rendered in the browser's
         * local timezone, so use the same local calendar date
         * for Polymarket matching.
         */
        const year =
            date.getFullYear();

        const month =
            String(
                date.getMonth() + 1
            ).padStart(2, "0");

        const day =
            String(
                date.getDate()
            ).padStart(2, "0");

        return `${year}-${month}-${day}`;
    }

    function polymarketCalendarDateKey(event) {
        /*
         * Prefer Polymarket's explicit eventDate because that
         * represents the event's calendar day. If unavailable,
         * use the YYYY-MM-DD embedded in the slug, then fall
         * back to startTime converted to local calendar date.
         */
        if (
            /^\d{4}-\d{2}-\d{2}$/.test(
                String(event?.eventDate || "")
            )
        ) {
            return String(
                event.eventDate
            );
        }

        const slugDate =
            String(event?.slug || "")
                .match(
                    /(\d{4}-\d{2}-\d{2})(?:$|[^0-9])/
                );

        if (slugDate?.[1]) {
            return slugDate[1];
        }

        if (event?.startTime) {
            return riotCalendarDateKey(
                event.startTime
            );
        }

        return "";
    }

    function exactDateSlugTokens(
        teamName,
        teamCode,
        aliases
    ) {
        const tokens = new Set();

        const add = value => {
            const token =
                normalizePolymarketText(
                    value
                );

            /*
             * Polymarket esports slugs normally use short team
             * abbreviations such as nip, jdg, gen, hle1, etc.
             * Keep this deliberately small so we do not go back
             * to the noisy brute-force lookup we removed earlier.
             */
            if (
                token.length >= 2 &&
                token.length <= 6
            ) {
                tokens.add(token);
            }
        };

        add(teamCode);

        for (const alias of aliases || []) {
            add(alias);

            if (tokens.size >= 3) {
                break;
            }
        }

        return [...tokens].slice(0, 3);
    }

    async function findPolymarketByExactDateSlug(
        teamA,
        teamB,
        teamACode,
        teamBCode,
        aliasesA,
        aliasesB,
        matchDate
    ) {
        const date =
            riotCalendarDateKey(
                matchDate
            );

        if (!date) {
            return [];
        }

        const tokensA =
            exactDateSlugTokens(
                teamA,
                teamACode,
                aliasesA
            );

        const tokensB =
            exactDateSlugTokens(
                teamB,
                teamBCode,
                aliasesB
            );

        const slugs =
            new Set();

        for (const a of tokensA) {
            for (const b of tokensB) {
                slugs.add(
                    `lol-${a}-${b}-${date}`
                );

                slugs.add(
                    `lol-${b}-${a}-${date}`
                );
            }
        }

        const found = [];

        /*
         * Exact Riot date only. No +/- day guessing.
         * Also, 404s are intentionally silent.
         */
        for (
            const slug of
            [...slugs].slice(0, 12)
            ) {
            try {
                const response =
                    await fetch(
                        `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`
                    );

                if (!response.ok) {
                    continue;
                }

                const event =
                    await response.json();

                if (
                    event?.slug &&
                    isLeagueOfLegendsPolymarketEvent(
                        event
                    )
                ) {
                    found.push(event);

                    console.log(
                        "Polymarket exact-date slug found:",
                        {
                            slug,
                            event
                        }
                    );
                }
            } catch (error) {
                /*
                 * This is only a fallback lookup. A failed slug
                 * should not break the calendar popup.
                 */
            }
        }

        return found;
    }

    function isStrongPolymarketRescheduleCandidate(
        candidate
    ) {
        const SEVEN_DAYS =
            7 * 24 * 60 * 60 * 1000;

        const bothTeamsMatch =
            candidate?.teamMatches === 2;

        const strongLeagueMatch =
            candidate?.leagueMatch?.relation === "exact" ||
            candidate?.leagueMatch?.relation === "contains" ||
            candidate?.leagueMatch?.relation === "initials";

        const dateWithinSevenDays =
            Number.isFinite(
                candidate?.difference
            ) &&
            candidate.difference <= SEVEN_DAYS;

        return (
            bothTeamsMatch &&
            strongLeagueMatch &&
            dateWithinSevenDays
        );
    }

    async function findPolymarketMatch(
        teamA,
        teamB,
        matchDate,
        teamACode = "",
        teamBCode = "",
        riotLeagueName = ""
    ) {
        try {
            let [
                aliasesA,
                aliasesB
            ] = await Promise.all([
                polymarketTeamAliases(
                    teamA,
                    teamACode
                ),
                polymarketTeamAliases(
                    teamB,
                    teamBCode
                )
            ]);

            aliasesA =
                addGenericChallengersAliases(
                    teamA,
                    teamACode,
                    aliasesA
                );

            aliasesB =
                addGenericChallengersAliases(
                    teamB,
                    teamBCode,
                    aliasesB
                );

            const riotTime =
                new Date(matchDate).getTime();

            if (!Number.isFinite(riotTime)) {
                return null;
            }

            /*
             * NEW MATCHING STRATEGY
             *
             * 1. Only look at Polymarket League of Legends events.
             * 2. Only look near the Riot calendar date.
             * 3. Require at least one team to match.
             * 4. Prefer both teams.
             * 5. Use league as confirmation/tie-breaker.
             *
             * This is deliberately much simpler than the
             * previous global-search / slug-guessing approach.
             */
            const dateEvents =
                await loadPolymarketEventsNearMatch(
                    matchDate
                );

            /*
             * The date-filtered Polymarket endpoint can miss real
             * esports events that are visible on the Polymarket
             * website. Restore matchup-specific public-search as
             * a second DISCOVERY source.
             *
             * We still enforce the exact Riot calendar date below,
             * so search cannot pull in a wrong-day matchup.
             */
            const searchedEvents =
                await searchPolymarketEvents(
                    teamA,
                    teamB,
                    teamACode,
                    teamBCode,
                    aliasesA,
                    aliasesB,
                    matchDate
                );

            /*
             * Reschedule discovery intentionally ignores Riot's
             * date. The strict candidate checks below still require
             * both teams + strong league + <= 7 days.
             */
            const rescheduleSearchEvents =
                await searchPolymarketRescheduleEvents(
                    teamA,
                    teamB,
                    teamACode,
                    teamBCode,
                    aliasesA,
                    aliasesB
                );

            /*
             * Public-search can still omit an event even when it
             * exists on the Polymarket LoL page. Try only the
             * exact Riot date + short team-code slug forms as a
             * final discovery fallback.
             *
             * Example:
             * NIP + JDG + 2026-09-05
             * -> lol-nip-jdg-2026-09-05
             */
            const exactSlugEvents =
                await findPolymarketByExactDateSlug(
                    teamA,
                    teamB,
                    teamACode,
                    teamBCode,
                    aliasesA,
                    aliasesB,
                    matchDate
                );

            const discoveredEventMap =
                new Map();

            for (const item of [
                ...dateEvents,
                ...searchedEvents,
                ...rescheduleSearchEvents,
                ...exactSlugEvents
            ]) {
                if (
                    item?.slug &&
                    isLeagueOfLegendsPolymarketEvent(
                        item
                    )
                ) {
                    discoveredEventMap.set(
                        item.slug,
                        item
                    );
                }
            }

            const discoveredEvents =
                [...discoveredEventMap.values()];

            const riotDateKey =
                riotCalendarDateKey(
                    matchDate
                );

            /*
             * Matching rule:
             * - League of Legends event only
             * - exact same Riot calendar date
             * - at least one team matches
             *
             * Discovery can come from the date endpoint OR
             * matchup search, but every candidate must pass the
             * strict same-date check.
             */
            const candidates = [];

            for (const item of discoveredEvents) {
                const polymarketDateKey =
                    polymarketCalendarDateKey(
                        item
                    );

                const exactDateMatch =
                    riotDateKey &&
                    polymarketDateKey &&
                    polymarketDateKey === riotDateKey;

                const hasTeamA =
                    aliasesA.some(
                        alias =>
                            polymarketAliasPresent(
                                item,
                                alias
                            )
                    );

                const hasTeamB =
                    aliasesB.some(
                        alias =>
                            polymarketAliasPresent(
                                item,
                                alias
                            )
                    );

                const teamMatches =
                    Number(hasTeamA) +
                    Number(hasTeamB);

                /*
                 * At least one team MUST match.
                 */
                if (teamMatches === 0) {
                    continue;
                }

                const difference =
                    polymarketDateDifference(
                        item,
                        riotTime
                    );

                const differenceHours =
                    Number.isFinite(difference)
                        ? difference /
                        (60 * 60 * 1000)
                        : Infinity;

                const leagueMatch =
                    polymarketLeagueScore(
                        item,
                        riotLeagueName
                    );

                let score = 0;

                /*
                 * Exact-date matches remain the primary path.
                 */
                if (exactDateMatch) {
                    score += 1000;
                }

                /*
                 * Team matching is the strongest identity signal.
                 */
                if (teamMatches === 2) {
                    score += 600;
                } else {
                    score += 250;
                }

                /*
                 * Time proximity is a tie-breaker.
                 */
                if (differenceHours <= 6) {
                    score += 100;
                } else if (differenceHours <= 12) {
                    score += 75;
                } else if (differenceHours <= 24) {
                    score += 50;
                }

                /*
                 * League is confirmation, not a requirement.
                 * This lets a valid match survive when Riot and
                 * Polymarket label the competition differently.
                 */
                if (
                    leagueMatch.relation === "exact"
                ) {
                    score += 200;
                } else if (
                    leagueMatch.relation === "contains"
                ) {
                    score += 150;
                } else if (
                    leagueMatch.relation === "initials"
                ) {
                    score += 100;
                } else if (
                    leagueMatch.relation === "mismatch"
                ) {
                    score -= 75;
                }

                candidates.push({
                    item,
                    score,
                    teamMatches,
                    hasTeamA,
                    hasTeamB,
                    difference,
                    differenceHours,
                    leagueMatch,
                    exactDateMatch,
                    riotDateKey,
                    polymarketDateKey
                });
            }

            candidates.sort(
                (a, b) => {
                    if (b.score !== a.score) {
                        return b.score - a.score;
                    }

                    if (
                        b.teamMatches !==
                        a.teamMatches
                    ) {
                        return (
                            b.teamMatches -
                            a.teamMatches
                        );
                    }

                    return (
                        a.difference -
                        b.difference
                    );
                }
            );

            console.log(
                "Polymarket LoL date candidates:",
                {
                    riotMatch: {
                        teamA,
                        teamB,
                        teamACode,
                        teamBCode,
                        league:
                        riotLeagueName,
                        startTime:
                        matchDate,
                        calendarDate:
                        riotDateKey
                    },
                    aliasesA,
                    aliasesB,
                    dateEvents:
                    dateEvents.length,
                    searchedEvents:
                    searchedEvents.length,
                    rescheduleSearchEvents:
                    rescheduleSearchEvents.length,
                    exactSlugEvents:
                    exactSlugEvents.length,
                    eventsChecked:
                    discoveredEvents.length,
                    candidates
                }
            );

            if (!candidates.length) {
                console.log(
                    "No Polymarket LoL event matched at least one Riot team."
                );

                return null;
            }

            const exactDateCandidates =
                candidates.filter(
                    candidate =>
                        candidate.exactDateMatch
                );

            let best =
                exactDateCandidates[0] ||
                null;

            /*
             * RESCHEDULE FALLBACK:
             * Only if there is NO exact-date result, allow a
             * different date when:
             * - BOTH teams match
             * - league strongly matches
             * - Polymarket date is within 7 days of Riot
             */
            if (!best) {
                best =
                    candidates.find(
                        isStrongPolymarketRescheduleCandidate
                    ) || null;

                if (best) {
                    console.log(
                        "Using Polymarket reschedule fallback:",
                        {
                            riotDate:
                            best.riotDateKey,
                            polymarketDate:
                            best.polymarketDateKey,
                            differenceDays:
                                best.difference /
                                (24 * 60 * 60 * 1000),
                            leagueMatch:
                            best.leagueMatch,
                            event:
                            best.item
                        }
                    );
                }
            }

            if (!best) {
                console.log(
                    "No exact-date or strong reschedule Polymarket match found."
                );

                return null;
            }

            if (!best.item?.slug) {
                return null;
            }

            const polymarketUrl =
                `https://polymarket.com/event/${best.item.slug}`;

            console.log(
                "Polymarket LoL match selected:",
                {
                    score:
                    best.score,
                    teamMatches:
                    best.teamMatches,
                    differenceHours:
                    best.differenceHours,
                    leagueMatch:
                    best.leagueMatch,
                    event:
                    best.item,
                    url:
                    polymarketUrl
                }
            );

            return {
                title:
                    best.item.title ||
                    best.item.question ||
                    `${teamA} vs ${teamB}`,
                url:
                polymarketUrl
            };
        } catch (error) {
            console.error(
                "Could not find Polymarket LoL match:",
                error
            );

            return null;
        }
    }

    async function openMatch(event) {
        // Stop polling a previously opened match
        if (liveScoreTimer) {
            clearInterval(liveScoreTimer);
            liveScoreTimer = null;
        }

        const teams = event?.match?.teams || [];

        const teamA =
            teams[0]?.name ||
            teams[0]?.code ||
            "TBD";

        const teamB =
            teams[1]?.name ||
            teams[1]?.code ||
            "TBD";

        const time = new Date(event.startTime);

        ui.matchDetails.replaceChildren();

        // League
        const league = document.createElement("p");
        league.className = "detail-league";
        league.textContent = event?.league?.name || "League";

        // Team names
        const teamsLine = document.createElement("div");
        teamsLine.className = "detail-teams";
        teamsLine.textContent = `${teamA} vs ${teamB}`;

        // Score
        const scoreLine = document.createElement("div");
        scoreLine.className = "detail-score";
        scoreLine.textContent = "Loading score…";

        // Match status
        const statusLine = document.createElement("div");
        statusLine.className = "detail-status";

        // Date
        const dateLine = document.createElement("p");
        dateLine.className = "detail-meta";

        dateLine.textContent = new Intl.DateTimeFormat([], {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
        }).format(time);
        const polymarketContainer =
            document.createElement("div");

        polymarketContainer.className =
            "polymarket-container";
        ui.matchDetails.append(
            league,
            teamsLine,
            scoreLine,
            statusLine,
            dateLine,
            polymarketContainer
        );

        const bestOf = event?.match?.strategy?.count;

        if (bestOf) {
            const strategy = document.createElement("p");
            strategy.className = "detail-meta";
            strategy.textContent = `Best of ${bestOf}`;
            ui.matchDetails.append(strategy);
        }

        ui.dialog.showModal();
        const polymarketMatch =
            await findPolymarketMatch(
                teamA,
                teamB,
                event.startTime,
                teams[0]?.code || "",
                teams[1]?.code || "",
                event?.league?.name || ""
            );


// ADD POLYMARKET BUTTON
        if (polymarketMatch) {

            const polymarketLink =
                document.createElement("button");

            polymarketLink.type = "button";
            polymarketLink.className =
                "polymarket-link";

            polymarketLink.textContent =
                "View on Polymarket ↗";

            polymarketLink.addEventListener(
                "click",
                () => {
                    window.open(
                        polymarketMatch.url,
                        "_blank",
                        "noopener,noreferrer"
                    );
                }
            );

            polymarketContainer.append(
                polymarketLink
            );
        }
        async function updateScore() {
            try {
                const details = await getMatchDetails(event.match.id);

                if (!details) {
                    scoreLine.textContent = "Score unavailable";
                    return;
                }

                const detailTeams = details?.match?.teams || [];

                const scoreA =
                    detailTeams[0]?.result?.gameWins ?? 0;

                const scoreB =
                    detailTeams[1]?.result?.gameWins ?? 0;

                scoreLine.textContent =
                    `${teamA} ${scoreA} — ${scoreB} ${teamB}`;

                // Figure out whether the series has finished
                const winTarget = bestOf
                    ? Math.ceil(bestOf / 2)
                    : null;

                const isFinished =
                    event.state === "completed" ||
                    (winTarget &&
                        (scoreA >= winTarget || scoreB >= winTarget));

                if (isFinished) {
                    statusLine.textContent = "FINAL";
                    statusLine.className =
                        "detail-status final";

                    if (liveScoreTimer) {
                        clearInterval(liveScoreTimer);
                        liveScoreTimer = null;
                    }

                } else if (event.state === "inProgress") {
                    statusLine.textContent = "● LIVE";
                    statusLine.className =
                        "detail-status live";

                } else {
                    statusLine.textContent = "UPCOMING";
                    statusLine.className =
                        "detail-status upcoming";
                }

            } catch (error) {
                console.error("Could not load match score:", error);

                const scheduleTeams = event?.match?.teams || [];

                const scoreA =
                    scheduleTeams[0]?.result?.gameWins;

                const scoreB =
                    scheduleTeams[1]?.result?.gameWins;

                if (
                    typeof scoreA === "number" &&
                    typeof scoreB === "number"
                ) {
                    scoreLine.textContent =
                        `${teamA} ${scoreA} — ${scoreB} ${teamB}`;
                } else {
                    scoreLine.textContent =
                        "Score currently unavailable";
                }
            }
        }

        // Get the newest score immediately
        await updateScore();

        // If the match is live, refresh every 20 seconds
        if (event.state === "inProgress") {
            liveScoreTimer = setInterval(
                updateScore,
                20000
            );
        }
    }
    function openDayMatches(date, events) {
        ui.matchDetails.replaceChildren();

        // Date title
        const title = document.createElement("div");
        title.className = "detail-teams";
        title.textContent = date.toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric"
        });

        const count = document.createElement("p");
        count.className = "detail-meta";
        count.textContent = `${events.length} matches`;

        const list = document.createElement("div");
        list.className = "day-match-list";

        // Make sure matches are ordered by time
        const sortedEvents = [...events].sort(
            (a, b) => new Date(a.startTime) - new Date(b.startTime)
        );

        for (const event of sortedEvents) {
            const teams = event?.match?.teams || [];

            const teamA =
                teams[0]?.name ||
                teams[0]?.code ||
                "TBD";

            const teamB =
                teams[1]?.name ||
                teams[1]?.code ||
                "TBD";

            const time = new Date(event.startTime);

            const match = document.createElement("button");

            match.type = "button";
            match.className = "day-match-item";

            if (matchHasAlreadyStarted(event)) {
                match.classList.add("past-match");
            }

            match.innerHTML = `
      <span class="day-match-time">
        ${time.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit"
            })}
      </span>

      <strong>
        ${teamA} vs ${teamB}
      </strong>

      <span class="day-match-league">
        ${event?.league?.name || "League"}
      </span>
    `;

            // Clicking an individual match opens its normal details
            match.addEventListener("click", () => {
                ui.dialog.close();

                setTimeout(() => {
                    openMatch(event);
                }, 0);
            });

            list.append(match);
        }

        ui.matchDetails.append(
            title,
            count,
            list
        );

        ui.dialog.showModal();
    }

    function renderCalendar() {
        const y = state.month.getFullYear();
        const m = state.month.getMonth();
        ui.monthTitle.textContent = state.month.toLocaleDateString([], { month: "long", year: "numeric" });
        ui.matchCount.textContent = `${state.events.length} match${state.events.length === 1 ? "" : "es"}`;

        const byDay = new Map();
        for (const event of state.events) {
            const date = new Date(event.startTime);
            const key = localDateKey(date);
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(event);
        }
        for (const events of byDay.values()) events.sort((a, b) => dateValue(a) - dateValue(b));

        const first = new Date(y, m, 1);
        const gridStart = new Date(y, m, 1 - first.getDay());
        const todayKey = localDateKey(new Date());

        ui.calendar.replaceChildren();

        for (let i = 0; i < 42; i++) {
            const date = new Date(gridStart);
            date.setDate(gridStart.getDate() + i);

            const day = document.createElement("article");
            day.className = "day";
            if (date.getMonth() !== m) day.classList.add("outside");
            if (localDateKey(date) === todayKey) day.classList.add("today");

            const number = document.createElement("div");
            number.className = "day-number";
            const numberText = document.createElement("span");
            numberText.textContent = String(date.getDate());
            number.append(numberText);
            day.append(number);

            const matches = document.createElement("div");
            matches.className = "matches";
            const events = byDay.get(localDateKey(date)) || [];

            for (const event of events.slice(0, 5)) matches.append(matchButton(event));
            if (events.length > 5) {
                const more = document.createElement("button");
                more.type = "button";
                more.className = "more";
                more.textContent = `+${events.length - 5} more`;

                more.addEventListener("click", () => {
                    openDayMatches(date, events);
                });

                matches.append(more);
            }

            day.append(matches);
            ui.calendar.append(day);
        }
    }

    async function loadLeagues() {
        const payload = await apiGet("/getLeagues");
        state.leagues = payload?.data?.leagues || [];

        const restored = restoreSelection();
        const validIds = new Set(state.leagues.map((l) => String(l.id)));

        if (restored) {
            state.selected = new Set([...restored].filter((id) => validIds.has(id)));
        }

        if (!state.selected.size) {
            state.selected = new Set(
                state.leagues.map((l) => String(l.id))
            );
        }

        saveSelection();
        renderLeagueList();
    }

    async function loadSchedule() {
        const requestId = ++state.requestId;
        renderCalendar();

        if (!state.selected.size) {
            state.events = [];
            renderCalendar();
            setStatus("Choose at least one league.");
            return;
        }

        setBusy(true);
        setStatus(`Loading ${state.selected.size} league${state.selected.size === 1 ? "" : "s"}…`);

        const ids = [...state.selected];
        const merged = new Map();
        const errors = [];
        let pagesChecked = 0;

        // Small worker pool: fast enough without hammering the endpoint.
        let cursor = 0;
        async function worker() {
            while (cursor < ids.length) {
                const index = cursor++;
                const id = ids[index];
                try {
                    const result = await fetchLeagueForVisibleMonth(id);
                    pagesChecked += result.pagesChecked;
                    for (const event of result.events) {
                        if (event?.type === "match" && event?.startTime && eventIsInVisibleLocalMonth(event)) {
                            merged.set(eventKey(event), event);
                        }
                    }
                } catch (error) {
                    errors.push(`${id}: ${error.message}`);
                }
            }
        }

        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
        if (requestId !== state.requestId) return;

        state.events = [...merged.values()].sort((a, b) => dateValue(a) - dateValue(b));
        renderCalendar();

        if (errors.length === ids.length) {
            setStatus(`Could not load schedule. ${errors[0] || ""}`, true);
        } else if (errors.length) {
            setStatus(`${pagesChecked} API pages checked · ${errors.length} league request${errors.length === 1 ? "" : "s"} failed`, true);
        } else if (!state.events.length) {
            setStatus(`${pagesChecked} API pages checked · no matches returned for this month`);
        } else {
            setStatus(`${pagesChecked} API pages checked`);
        }

        setBusy(false);
    }

    ui.leagueSearch.addEventListener("input", renderLeagueList);
    ui.prev.addEventListener("click", () => {
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
        loadSchedule();
    });
    ui.next.addEventListener("click", () => {
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
        loadSchedule();
    });
    ui.today.addEventListener("click", () => {
        const now = new Date();
        state.month = new Date(now.getFullYear(), now.getMonth(), 1);
        loadSchedule();
    });
    ui.major.addEventListener("click", () => {
        state.selected = new Set(state.leagues.filter(isMajor).map((l) => String(l.id)));
        saveSelection();
        renderLeagueList();
        loadSchedule();
    });
    ui.all.addEventListener("click", () => {
        state.selected = new Set(state.leagues.map((l) => String(l.id)));
        saveSelection();
        renderLeagueList();
        loadSchedule();
    });
    ui.none.addEventListener("click", () => {
        state.selected.clear();
        saveSelection();
        renderLeagueList();
        loadSchedule();
    });
    // ==============================
// MATCH DIALOG CLOSE
// ==============================

    function closeMatchDialog() {
        ui.dialog.close();

        // Stop checking live scores after the popup is closed
        if (liveScoreTimer) {
            clearInterval(liveScoreTimer);
            liveScoreTimer = null;
        }
    }

// Close when the X button is clicked
    ui.dialogClose.addEventListener("click", closeMatchDialog);

// Close when clicking outside the popup
    ui.dialog.addEventListener("click", (event) => {
        if (event.target === ui.dialog) {
            closeMatchDialog();
        }
    });

    try {
        ui.timezone.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
    } catch (_) {
        ui.timezone.textContent = "Local time";
    }

    (async () => {
        try {
            await loadLeagues();
            await loadSchedule();
        } catch (error) {
            setStatus(error.message || "Could not start calendar.", true);
            setBusy(false);
        }
    })();
})();

