(() => {
  const API_BASE = "https://global-market-radar.asd123asc.chatgpt.site";
  const state = { data: null, view: "stocks", market: "all", signal: "all", search: "" };
  const marketOrder = ["us", "hk", "cn", "jp"];
  const marketNames = { us: "미국", hk: "홍콩", cn: "중국A", jp: "일본" };
  const sectorKo = {
    "Electronic Technology":"전자기술","Technology Services":"기술서비스","Commercial Services":"상업서비스",
    "Finance":"금융","Health Technology":"헬스케어","Consumer Services":"소비자서비스",
    "Consumer Durables":"내구소비재","Consumer Non-Durables":"비내구소비재","Process Industries":"공정산업",
    "Producer Manufacturing":"생산재","Industrial Services":"산업서비스","Energy Minerals":"에너지",
    "Non-Energy Minerals":"소재","Utilities":"유틸리티","Transportation":"운송","Retail Trade":"소매",
    "Communications":"통신","Distribution Services":"유통","Miscellaneous":"기타"
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindControls();
    try {
      const remote = await fetch(`${API_BASE}/api/global`, { cache: "no-store", signal: AbortSignal.timeout(12000) }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      state.data = remote?.generatedAt ? remote : window.GLOBAL_MARKET_DATA;
    } catch {
      state.data = window.GLOBAL_MARKET_DATA;
    }
    if (!state.data?.generatedAt) return showEmpty();
    renderHeader();
    renderCards();
    render();
  }

  function bindControls() {
    document.getElementById("view-tabs").addEventListener("click", (event) => selectButton(event, "view"));
    document.getElementById("market-tabs").addEventListener("click", (event) => selectButton(event, "market"));
    document.getElementById("signal-tabs").addEventListener("click", (event) => selectButton(event, "signal"));
    document.getElementById("global-search").addEventListener("input", (event) => { state.search = event.target.value.trim().toLowerCase(); render(); });
    document.getElementById("export-global").addEventListener("click", exportCsv);
  }

  function selectButton(event, key) {
    const button = event.target.closest(`button[data-${key}]`);
    if (!button) return;
    state[key] = button.dataset[key];
    button.parentElement.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    document.getElementById("signal-tabs").hidden = state.view !== "stocks";
    render();
  }

  function renderHeader() {
    document.getElementById("global-date").textContent = state.data.date || "-";
    const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(state.data.generatedAt));
    document.getElementById("global-updated").textContent = `${stamp} KST 갱신`;
    const cap = (state.data.methodology?.minimumMarketCapUsd || 0) / 1e9;
    document.getElementById("global-method").textContent = `미국·홍콩·중국A·일본 · 시총 $${cap.toFixed(0)}B+ · ${state.data.methodology?.primaryWindow || "60거래일"}/${state.data.methodology?.longWindow || "52주"}`;
    document.getElementById("global-narrative").innerHTML = `<span>●</span> ${escapeHtml(state.data.summary || "시장 요약이 없습니다.")}`;
  }

  function renderCards() {
    const root = document.getElementById("global-market-cards");
    root.innerHTML = state.data.markets.map((market) => {
      const indexes = (market.indexes || []).map((item) => `<span>${escapeHtml(item.name)} <b class="${tone(item.changePct)}">${signed(item.changePct)}%</b></span>`).join("");
      return `<button type="button" class="global-market-card" data-market-card="${market.id}">
        <div><small>${market.name}</small><strong><em>신고 ${market.high60}</em> <i>(NEW ${market.newHigh})</i> · <b>신저 ${market.low60}</b> <i>(NEW ${market.newLow})</i></strong></div>
        <div class="global-indexes">${indexes}</div>
      </button>`;
    }).join("");
    root.addEventListener("click", (event) => {
      const card = event.target.closest("[data-market-card]");
      if (!card) return;
      state.market = card.dataset.marketCard;
      document.querySelectorAll("#market-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.market === state.market));
      render();
    });
  }

  function render() {
    document.body.dataset.globalView = state.view;
    if (state.view === "stocks") renderStocks();
    else if (state.view === "sectors") renderSectors();
    else renderEtfs();
  }

  function renderStocks() {
    const rows = state.data.stocks.filter((row) => matchMarket(row) && matchSignal(row) && matchSearch(row));
    document.getElementById("global-count").textContent = `${rows.length.toLocaleString()}종목`;
    document.getElementById("global-panel").innerHTML = `<div class="global-table-wrap"><table class="global-table stock-table">
      <thead><tr><th>시장</th><th>구분</th><th>NEW</th><th>티커</th><th>종목명</th><th>섹터</th><th>종가</th><th>등락률%</th><th>시총$B</th><th>PER</th><th>PBR</th><th>이유</th></tr></thead>
      <tbody>${rows.map(stockRow).join("") || emptyRow(12)}</tbody>
    </table></div>`;
  }

  function stockRow(row) {
    return `<tr>
      <td>${row.marketName}</td>
      <td><span class="signal ${row.signal}">${row.signal === "high" ? "신고가" : "신저가"}</span></td>
      <td>${row.isNew ? '<span class="new-badge">NEW</span>' : '<span class="old-badge">OLD</span>'}</td>
      <td><button class="ticker-copy" type="button" data-copy="${escapeAttr(row.symbol)}">${escapeHtml(row.ticker)} <small>${escapeHtml(row.exchange)}</small>${row.hit52 ? '<i>52W</i>' : ""}</button></td>
      <td class="stock-name">${escapeHtml(row.name)}</td>
      <td>${escapeHtml(sectorName(row.sector))}</td>
      <td class="number">${formatPrice(row.close, row.currency)}</td>
      <td class="number ${tone(row.changePct)}">${signed(row.changePct, 2)}</td>
      <td class="number">${formatNumber(row.marketCapUsd / 1e9, 1)}</td>
      <td class="number">${formatNumber(row.per, 1)}</td>
      <td class="number">${formatNumber(row.pbr, 1)}</td>
      <td class="reason">${reasonHtml(row)}</td>
    </tr>`;
  }

  function renderSectors() {
    const rows = state.data.sectors.filter((row) => matchMarket(row) && matchSearch(row));
    document.getElementById("global-count").textContent = `${rows.length.toLocaleString()}섹터`;
    document.getElementById("global-panel").innerHTML = `<div class="global-table-wrap"><table class="global-table sector-table">
      <thead><tr><th>시장</th><th>섹터</th><th>유니버스</th><th>신고</th><th>신저</th><th>순강도</th><th>판정</th><th>PER(TTM)</th><th>PBR</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${row.marketName}</td><td class="stock-name">${escapeHtml(sectorName(row.sector))}</td>
        <td class="number">${row.universe}</td><td class="number positive">${row.high || ""}</td>
        <td class="number negative">${row.low || ""}</td><td class="number ${tone(row.netStrength)}">${signed(row.netStrength, 0)}</td>
        <td><span class="verdict ${tone(row.netStrength)}">${row.verdict}</span></td>
        <td class="number">${formatNumber(row.per, 1)}</td><td class="number">${formatNumber(row.pbr, 1)}</td>
      </tr>`).join("") || emptyRow(9)}</tbody>
    </table></div>`;
  }

  function renderEtfs() {
    const rows = state.data.etfs.filter((row) => matchMarket(row) && matchSearch(row));
    const periods = [["d1","1D"],["w1","1주"],["m1","1M"],["m3","3M"],["m6","6M"],["ytd","YTD"],["y1","1Y"],["y3","3Y"],["y5","5Y"]];
    document.getElementById("global-count").textContent = `${rows.length.toLocaleString()}ETF`;
    document.getElementById("global-panel").innerHTML = `<div class="global-table-wrap"><table class="global-table heat-table">
      <thead><tr><th>시장</th><th>티커</th><th>섹터</th>${periods.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr><td>${marketNames[row.market]}</td><td><button class="ticker-copy" type="button" data-copy="${escapeAttr(row.symbol)}">${row.ticker}</button></td><td class="stock-name">${escapeHtml(row.sector)}</td>${periods.map(([key]) => heatCell(row.returns[key])).join("")}</tr>`).join("") || emptyRow(12)}</tbody>
    </table></div>`;
  }

  function matchMarket(row) { return state.market === "all" || row.market === state.market; }
  function matchSignal(row) {
    if (state.signal === "high" || state.signal === "low") return row.signal === state.signal;
    if (state.signal === "new") return row.isNew;
    if (state.signal === "52w") return row.hit52;
    return true;
  }
  function matchSearch(row) {
    if (!state.search) return true;
    return [row.ticker,row.symbol,row.name,row.sector,sectorName(row.sector),row.reason,row.marketName,row.market && marketNames[row.market]]
      .filter(Boolean).join(" ").toLowerCase().includes(state.search);
  }

  function exportCsv() {
    if (!state.data) return;
    let rows;
    if (state.view === "stocks") {
      rows = [["시장","구분","NEW","티커","종목명","섹터","종가","등락률","시총USD","PER","PBR","이유"], ...state.data.stocks.filter((row) => matchMarket(row) && matchSignal(row) && matchSearch(row)).map((row) => [row.marketName,row.signal,row.isNew,row.ticker,row.name,sectorName(row.sector),row.close,row.changePct,row.marketCapUsd,row.per,row.pbr,row.reason])];
    } else if (state.view === "sectors") {
      rows = [["시장","섹터","유니버스","신고","신저","순강도","판정","PER","PBR"], ...state.data.sectors.filter((row) => matchMarket(row) && matchSearch(row)).map((row) => [row.marketName,sectorName(row.sector),row.universe,row.high,row.low,row.netStrength,row.verdict,row.per,row.pbr])];
    } else {
      rows = [["시장","티커","섹터","1D","1W","1M","3M","6M","YTD","1Y","3Y","5Y"], ...state.data.etfs.filter((row) => matchMarket(row) && matchSearch(row)).map((row) => [marketNames[row.market],row.ticker,row.sector,...Object.values(row.returns)])];
    }
    const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `global-${state.view}-${state.data.date}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy]");
    if (button) navigator.clipboard?.writeText(button.dataset.copy);
  });

  function heatCell(value) {
    if (value == null || !Number.isFinite(Number(value))) return '<td class="heat empty">-</td>';
    const number = Number(value);
    const intensity = Math.min(1, Math.abs(number) / 25);
    return `<td class="heat ${number >= 0 ? "up" : "down"}" style="--heat:${intensity.toFixed(2)}">${signed(number, 1)}%</td>`;
  }
  function reasonHtml(row) {
    if (row.reasonType !== "news" || !row.reasonUrl) return '<span class="news-missing">관련 최신 뉴스 미포착</span>';
    const published = row.reasonPublishedAt ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(row.reasonPublishedAt)) : "";
    const meta = [row.reasonSource, published].filter(Boolean).map(escapeHtml).join(" · ");
    return `<a class="news-reason" href="${escapeAttr(row.reasonUrl)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(row.reason)}</strong>${meta ? `<small>${meta}</small>` : ""}</a>`;
  }
  function showEmpty() {
    document.getElementById("global-updated").textContent = "갱신 필요";
    document.getElementById("global-narrative").textContent = "아직 글로벌 데이터가 없습니다. 텔레그램에서 /global을 실행하세요.";
    document.getElementById("global-panel").innerHTML = '<div class="global-empty"><strong>글로벌 데이터 없음</strong><span>/global 명령을 실행하면 이 화면이 갱신됩니다.</span></div>';
  }
  function emptyRow(columns) { return `<tr><td colspan="${columns}" class="empty-table">조건에 맞는 데이터가 없습니다.</td></tr>`; }
  function sectorName(value) { return sectorKo[value] || value || "기타"; }
  function signed(value, digits = 1) { const number = Number(value) || 0; return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`; }
  function tone(value) { const number = Number(value) || 0; return number > 0 ? "positive" : number < 0 ? "negative" : "neutral"; }
  function formatNumber(value, digits = 1) { return value == null || !Number.isFinite(Number(value)) ? "-" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits }); }
  function formatPrice(value, currency) { return `${currency || ""} ${Number(value || 0).toLocaleString("ko-KR", { maximumFractionDigits: Number(value) < 100 ? 2 : 1 })}`; }
  function csvCell(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text; }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char])); }
  function escapeAttr(value) { return escapeHtml(value); }
})();

