(() => {
  "use strict";

  const API_BASE = "https://esports-api.lolesports.com/persisted/gw";
  const API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
  const LOCALE = "en-US";
  const MAX_PAGES_PER_LEAGUE = 45;
  const STORAGE_KEY = "lol-calendar-selected-leagues-v2";

  let liveScoreTimer = null;
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

  function matchButton(event) {
    const teams = event?.match?.teams || [];
    const a = teams[0]?.name || teams[0]?.code || "TBD";
    const b = teams[1]?.name || teams[1]?.code || "TBD";
    const d = new Date(event.startTime);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "match";

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

    async function findPolymarketMatch(
        teamA,
        teamB,
        matchDate,
        teamACode = "",
        teamBCode = ""
    ) {
        try {
            const normalize = (text) =>
                String(text || "")
                    .toLowerCase()
                    .replace(/\besports\b/g, "")
                    .replace(/\bgaming\b/g, "")
                    .replace(/[^a-z0-9]/g, "");

            // Some teams are named differently on Polymarket.
            const knownAliases = {
                "bnkfearx": ["bnkfearx", "fearx", "fox", "fox1"],
                "dpluskia": ["dpluskia", "dplus", "dk"],
                "hanwhalifeesports": ["hanwhalifeesports", "hanwhalife", "hle", "hle1"],
                "hanwhalife": ["hanwhalife", "hle", "hle1"],
                "geng": ["geng", "gen"],
                "gengesports": ["geng", "gen"],
                "ktrolster": ["ktrolster", "kt"],
                "nongshimredforce": ["nongshimredforce", "nongshim", "ns"],
                "drx": ["drx"],
                "t1": ["t1"]
            };

            function getAliases(name, code) {
                const normalizedName = normalize(name);
                const normalizedCode = normalize(code);

                const result = new Set();

                if (normalizedName) {
                    result.add(normalizedName);
                }

                if (normalizedCode) {
                    result.add(normalizedCode);
                }

                const extras = knownAliases[normalizedName];

                if (extras) {
                    for (const alias of extras) {
                        result.add(normalize(alias));
                    }
                }

                return [...result].filter(Boolean);
            }

            const aliasesA = getAliases(
                teamA,
                teamACode
            );

            const aliasesB = getAliases(
                teamB,
                teamBCode
            );

            /*
             * Polymarket does not always index a match using
             * the same team names Riot uses.
             *
             * Search several combinations.
             */
            const searches = new Set();

            searches.add(`${teamA} ${teamB}`);

            if (teamACode && teamBCode) {
                searches.add(
                    `${teamACode} ${teamBCode}`
                );
            }

            for (const a of aliasesA) {
                for (const b of aliasesB) {
                    searches.add(`${a} ${b}`);
                }
            }

            const foundEvents = new Map();

            for (const query of searches) {
                try {
                    const url = new URL(
                        "https://gamma-api.polymarket.com/public-search"
                    );

                    url.searchParams.set(
                        "q",
                        query
                    );

                    const response =
                        await fetch(url);

                    if (!response.ok) {
                        console.warn(
                            "Polymarket search failed:",
                            response.status,
                            query
                        );

                        continue;
                    }

                    const data =
                        await response.json();

                    /*
                     * Different versions of the endpoint have
                     * returned events in slightly different places.
                     */
                    const events =
                        data?.events ||
                        data?.results?.events ||
                        [];

                    for (const item of events) {
                        if (item?.slug) {
                            foundEvents.set(
                                item.slug,
                                item
                            );
                        }
                    }

                } catch (error) {
                    console.warn(
                        "Polymarket search failed for:",
                        query,
                        error
                    );
                }
            }

            console.log(
                "Polymarket events found:",
                [...foundEvents.values()]
            );

            if (!foundEvents.size) {
                return null;
            }

            /*
             * Check whether both teams occur somewhere in
             * the Polymarket event.
             */
            const candidates =
                [...foundEvents.values()]
                    .filter((item) => {

                        const text = normalize(
                            [
                                item?.title,
                                item?.question,
                                item?.slug,
                                item?.description
                            ]
                                .filter(Boolean)
                                .join(" ")
                        );

                        const hasTeamA =
                            aliasesA.some(
                                (alias) =>
                                    text.includes(alias)
                            );

                        const hasTeamB =
                            aliasesB.some(
                                (alias) =>
                                    text.includes(alias)
                            );

                        return (
                            hasTeamA &&
                            hasTeamB
                        );
                    });

            console.log(
                "Polymarket team candidates:",
                candidates
            );

            if (!candidates.length) {
                return null;
            }

            /*
             * Riot gives us the match start time.
             *
             * Prefer a Polymarket event whose date is
             * closest to the Riot match.
             */
            const riotTime =
                new Date(matchDate).getTime();

            const scoredCandidates =
                candidates.map((item) => {

                    const possibleDates = [
                        item?.startDate,
                        item?.endDate,
                        item?.start_date,
                        item?.end_date,
                        item?.createdAt
                    ];

                    let closestDifference =
                        Infinity;

                    for (const value of possibleDates) {

                        if (!value) {
                            continue;
                        }

                        const marketTime =
                            new Date(value).getTime();

                        if (
                            !Number.isFinite(
                                marketTime
                            )
                        ) {
                            continue;
                        }

                        const difference =
                            Math.abs(
                                marketTime -
                                riotTime
                            );

                        if (
                            difference <
                            closestDifference
                        ) {
                            closestDifference =
                                difference;
                        }
                    }

                    /*
                     * Polymarket esports slugs often contain
                     * YYYY-MM-DD. This is more useful than
                     * createdAt when available.
                     */
                    const slugDateMatch =
                        String(item?.slug || "")
                            .match(
                                /(\d{4}-\d{2}-\d{2})/
                            );

                    if (slugDateMatch) {

                        const slugTime =
                            new Date(
                                slugDateMatch[1] +
                                "T12:00:00"
                            ).getTime();

                        if (
                            Number.isFinite(
                                slugTime
                            )
                        ) {
                            const difference =
                                Math.abs(
                                    slugTime -
                                    riotTime
                                );

                            if (
                                difference <
                                closestDifference
                            ) {
                                closestDifference =
                                    difference;
                            }
                        }
                    }

                    return {
                        item,
                        difference:
                        closestDifference
                    };
                });

            scoredCandidates.sort(
                (a, b) =>
                    a.difference -
                    b.difference
            );

            console.log(
                "Polymarket scored candidates:",
                scoredCandidates
            );

            const best =
                scoredCandidates[0];

            if (!best?.item?.slug) {
                return null;
            }

            /*
             * Do not accidentally link an old meeting between
             * the same two teams.
             *
             * If Polymarket supplied usable date information,
             * require it to be within 3 days.
             */
            const THREE_DAYS =
                3 *
                24 *
                60 *
                60 *
                1000;

            if (
                Number.isFinite(
                    best.difference
                ) &&
                best.difference >
                THREE_DAYS
            ) {
                console.log(
                    "Ignoring old Polymarket event:",
                    best.item
                );

                return null;
            }

            /*
             * IMPORTANT:
             *
             * Do NOT hardcode /lck/, /lpl/, etc.
             *
             * The generic event URL works regardless
             * of which LoL league the match belongs to.
             */
            const polymarketUrl =
                `https://polymarket.com/event/${best.item.slug}`;

            console.log(
                "Polymarket match selected:",
                best.item
            );

            console.log(
                "Polymarket URL:",
                polymarketUrl
            );

            return {
                title:
                    best.item.title ||
                    best.item.question ||
                    `${teamA} vs ${teamB}`,

                url: polymarketUrl
            };

        } catch (error) {

            console.error(
                "Could not find Polymarket match:",
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
                teams[1]?.code || ""
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
