(() => {
  const API_BASE = location.hostname.endsWith("github.io") ? "https://global-market-radar.asd123asc.chatgpt.site" : "";
  const state = { data: null, dates: [], view: "stocks", market: "all", signal: "all", search: "", loading: false };
  const marketOrder = ["us", "jp", "hk", "cn"];
  const marketNames = { us: "미국", jp: "일본", hk: "홍콩", cn: "중국A" };
  const marketTickerSuffix = { us: "US", jp: "JP", hk: "HK", cn: "CH" };
  const sectorKo = {
    "Electronic Technology":"전자기술","Technology Services":"기술서비스","Commercial Services":"상업서비스",
    "Finance":"금융","Health Technology":"헬스케어","Consumer Services":"소비자서비스",
    "Consumer Durables":"내구소비재","Consumer Non-Durables":"비내구소비재","Process Industries":"공정산업",
    "Producer Manufacturing":"생산재","Industrial Services":"산업서비스","Energy Minerals":"에너지",
    "Non-Energy Minerals":"소재","Utilities":"유틸리티","Transportation":"운송","Retail Trade":"소매",
    "Communications":"통신","Distribution Services":"유통","Health Services":"헬스서비스","Miscellaneous":"기타"
  };
  let excelLibraryPromise;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindControls();
    try {
      const archive = await fetchJson("/api/global/dates");
      state.dates = Array.isArray(archive.dates) ? archive.dates : [];
      const requested = new URLSearchParams(location.search).get("date");
      const selected = state.dates.includes(requested) ? requested : archive.latest || requested;
      populateDateSelect(selected);
      await loadDate(selected);
    } catch {
      state.data = window.GLOBAL_MARKET_DATA;
      if (!state.data?.generatedAt) return showEmpty();
      state.dates = [state.data.date].filter(Boolean);
      populateDateSelect(state.data.date);
      renderAll();
    }
  }

  function bindControls() {
    document.getElementById("view-tabs").addEventListener("click", (event) => selectButton(event, "view"));
    document.getElementById("market-tabs").addEventListener("click", (event) => selectButton(event, "market"));
    document.getElementById("signal-tabs").addEventListener("click", (event) => selectButton(event, "signal"));
    document.getElementById("global-search").addEventListener("input", (event) => { state.search = event.target.value.trim().toLowerCase(); render(); });
    document.getElementById("global-date-select").addEventListener("change", (event) => loadDate(event.target.value));
    document.getElementById("export-global").addEventListener("click", exportExcel);
  }

  async function fetchJson(path) {
    const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function loadDate(date) {
    if (state.loading) return;
    state.loading = true;
    const select = document.getElementById("global-date-select");
    select.disabled = true;
    document.body.classList.add("is-loading");
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const payload = await fetchJson(`/api/global${query}`);
      if (!payload?.generatedAt) throw new Error("empty payload");
      state.data = payload;
      if (payload.date && !state.dates.includes(payload.date)) state.dates.unshift(payload.date);
      populateDateSelect(payload.date);
      const url = new URL(location.href);
      if (payload.date) url.searchParams.set("date", payload.date);
      history.replaceState(null, "", url);
      renderAll();
    } catch {
      showLoadError(date);
    } finally {
      state.loading = false;
      select.disabled = false;
      document.body.classList.remove("is-loading");
    }
  }

  function populateDateSelect(selected) {
    const select = document.getElementById("global-date-select");
    const dates = [...new Set(state.dates.filter(Boolean))].sort((a, b) => b.localeCompare(a));
    select.innerHTML = dates.length ? dates.map((date) => `<option value="${date}" ${date === selected ? "selected" : ""}>${date}</option>`).join("") : '<option value="">저장 데이터 없음</option>';
  }

  function renderAll() {
    renderHeader();
    renderNarrative();
    renderCards();
    render();
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
    document.getElementById("global-method").textContent = `미국·일본·홍콩·중국A · 시총 $${cap.toFixed(0)}B+ · ${state.data.methodology?.primaryWindow || "60거래일"}/${state.data.methodology?.longWindow || "52주"}`;
  }

  function renderNarrative() {
    const rows = commentaryRows();
    document.getElementById("global-narrative").innerHTML = rows.map((row) => `<div class="narrative-row"><span>${escapeHtml(row.label)}</span><p>${escapeHtml(row.text)}</p></div>`).join("");
  }

  function commentaryRows() {
    if (Array.isArray(state.data.commentary) && state.data.commentary.length) return state.data.commentary;
    const market = (id, label) => {
      const item = state.data.markets.find((row) => row.id === id);
      if (!item) return null;
      const indexes = (item.indexes || []).map((row) => `${row.name} ${signed(row.changePct, 2)}%`).join("·");
      return { label, text: `${indexes ? `${indexes} — ` : ""}신고 ${item.high60}·신저 ${item.low60}, 신규 ${item.newHigh + item.newLow}종목.` };
    };
    return [
      { label: "결론", text: state.data.summary || "시장 요약이 없습니다." },
      market("us", "美"), market("jp", "日"),
      { label: "中·홍콩", text: [market("cn", "")?.text, market("hk", "")?.text].filter(Boolean).join(" ") },
      { label: "체크", text: "신규 신호의 지속 여부와 지수 대비 개별 종목·섹터 확산 정도를 함께 확인하세요." },
    ].filter(Boolean);
  }

  function renderCards() {
    const root = document.getElementById("global-market-cards");
    const ordered = marketOrder.map((id) => state.data.markets.find((row) => row.id === id)).filter(Boolean);
    root.innerHTML = ordered.map((market) => {
      const total = Math.max(1, market.high60 + market.low60);
      const highWidth = Math.round((market.high60 / total) * 100);
      return `<button type="button" class="global-market-card" data-market-card="${market.id}">
        <div class="card-top"><small>${market.name}</small><span class="mini-bars" aria-hidden="true"><i style="height:${Math.max(4, Math.min(18, market.high60))}px"></i><b style="height:${Math.max(4, Math.min(18, market.low60))}px"></b></span></div>
        <strong><em>${market.high60}</em><small> 신고</small><b>${market.low60}</b><small> 신저</small></strong>
        <p>NEW ${market.newHigh} 신고 · ${market.newLow} 신저</p>
        <span class="strength-bar"><i style="width:${highWidth}%"></i></span>
      </button>`;
    }).join("");
    root.onclick = (event) => {
      const card = event.target.closest("[data-market-card]");
      if (!card) return;
      state.market = card.dataset.marketCard;
      document.querySelectorAll("#market-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.market === state.market));
      render();
    };
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
      <tbody>${rows.map((row) => `<tr><td>${row.marketName}</td><td class="stock-name">${escapeHtml(sectorName(row.sector))}</td><td class="number">${row.universe}</td><td class="number positive">${row.high || ""}</td><td class="number negative">${row.low || ""}</td><td class="number ${tone(row.netStrength)}">${signed(row.netStrength, 0)}</td><td><span class="verdict ${tone(row.netStrength)}">${row.verdict}</span></td><td class="number">${formatNumber(row.per, 1)}</td><td class="number">${formatNumber(row.pbr, 1)}</td></tr>`).join("") || emptyRow(9)}</tbody>
    </table></div>`;
  }

  function renderEtfs() {
    const rows = state.data.etfs.filter((row) => matchMarket(row) && matchSearch(row));
    const periods = [["d1","1D"],["w1","1주"],["m1","1M"],["m3","3M"],["m6","6M"],["ytd","YTD"],["y1","1Y"],["y3","3Y"],["y5","5Y"]];
    document.getElementById("global-count").textContent = `${rows.length.toLocaleString()}ETF`;
    document.getElementById("global-panel").innerHTML = `<div class="global-table-wrap"><table class="global-table heat-table"><thead><tr><th>시장</th><th>티커</th><th>섹터</th>${periods.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><td>${marketNames[row.market]}</td><td><button class="ticker-copy" type="button" data-copy="${escapeAttr(row.symbol)}">${row.ticker}</button></td><td class="stock-name">${escapeHtml(row.sector)}</td>${periods.map(([key]) => heatCell(row.returns[key])).join("")}</tr>`).join("") || emptyRow(12)}</tbody></table></div>`;
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
    return [row.ticker,row.symbol,row.name,row.sector,sectorName(row.sector),row.reason,row.reasonOriginal,row.marketName,row.market && marketNames[row.market]]
      .filter(Boolean).join(" ").toLowerCase().includes(state.search);
  }

  async function exportExcel() {
    if (!state.data) return;
    const button = document.getElementById("export-global");
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Excel 생성 중";
    try {
      const ExcelJS = await ensureExcelJs();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "글로벌 마켓 스캐너";
      workbook.created = new Date(state.data.generatedAt);
      addSummarySheet(workbook);
      addSectorSheet(workbook);
      addEtfSheet(workbook);
      for (const marketId of marketOrder) addMarketSheet(workbook, marketId);
      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      link.download = `신고신저가_${String(state.data.date).replaceAll("-", "")}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      alert(`Excel 생성에 실패했습니다. 잠시 후 다시 시도하세요.\n${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function ensureExcelJs() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (excelLibraryPromise) return excelLibraryPromise;
    excelLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
      script.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("Excel 모듈을 불러오지 못했습니다."));
      script.onerror = () => reject(new Error("Excel 모듈 다운로드 실패"));
      document.head.appendChild(script);
    });
    return excelLibraryPromise;
  }

  function addSummarySheet(workbook) {
    const sheet = workbook.addWorksheet("요약", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(["시장","데이터 기준일","신고가","신저가","그중 52주 신고가","그중 52주 신저가","오늘 신규진입(NEW)"]);
    for (const id of marketOrder) {
      const market = state.data.markets.find((row) => row.id === id);
      if (market) sheet.addRow([market.name, state.data.date, market.high60, market.low60, market.high52, market.low52, market.newHigh + market.newLow]);
    }
    sheet.addRow([]);
    for (const row of commentaryRows()) {
      const index = sheet.rowCount + 1;
      sheet.mergeCells(`A${index}:G${index}`);
      sheet.getCell(`A${index}`).value = `${row.label === "결론" ? "💬 " : ""}■ ${row.label}: ${row.text}`;
      sheet.getCell(`A${index}`).alignment = { vertical: "middle", wrapText: true };
      sheet.getRow(index).height = 32;
    }
    sheet.addRow([]);
    const note = sheet.rowCount + 1;
    sheet.mergeCells(`A${note}:G${note}`);
    sheet.getCell(`A${note}`).value = "※ 60일은 TradingView 3개월 고저가 기준이며, 신고·신저는 당일 고가·저가가 해당 기간 최고·최저에 도달한 종목입니다.";
    sheet.getCell(`A${note}`).font = { italic: true, color: { argb: "FF666666" } };
    sheet.columns = [{width:14},{width:16},{width:12},{width:12},{width:20},{width:20},{width:22}];
    styleWorksheet(sheet, 7, 5);
  }

  function addSectorSheet(workbook) {
    const sheet = workbook.addWorksheet("섹터동향", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(["시장","섹터","유니버스종목수","신고가","신저가","순강도(신고-신저)","판정","PER(TTM중앙값)","PBR(중앙값)"]);
    state.data.sectors.forEach((row) => sheet.addRow([row.marketName,row.sector,row.universe,row.high,row.low,row.netStrength,row.verdict,row.per,row.pbr]));
    sheet.columns = [{width:12},{width:26},{width:18},{width:11},{width:11},{width:22},{width:12},{width:20},{width:16}];
    styleWorksheet(sheet, 9);
    sheet.getColumn(8).numFmt = "0.0";
    sheet.getColumn(9).numFmt = "0.0";
  }

  function addEtfSheet(workbook) {
    const sheet = workbook.addWorksheet("섹터ETF", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(["시장","티커","섹터","코멘트","1D","1주","1M","3M","6M","YTD","순위YTD","1Y","3Y","5Y"]);
    const ranks = new Map();
    for (const id of marketOrder) {
      [...state.data.etfs].filter((row) => row.market === id && Number.isFinite(Number(row.returns?.ytd))).sort((a,b) => b.returns.ytd-a.returns.ytd).forEach((row,index) => ranks.set(row.symbol,index+1));
    }
    state.data.etfs.forEach((row) => sheet.addRow([marketNames[row.market],excelTicker(row),row.sector,etfComment(row),row.returns.d1,row.returns.w1,row.returns.m1,row.returns.m3,row.returns.m6,row.returns.ytd,ranks.get(row.symbol) || null,row.returns.y1,row.returns.y3,row.returns.y5]));
    sheet.columns = [{width:12},{width:18},{width:22},{width:68},...Array.from({length:10},()=>({width:12}))];
    styleWorksheet(sheet, 14);
    sheet.getColumn(4).alignment = { wrapText: true, vertical: "top" };
    for (let column = 5; column <= 10; column += 1) sheet.getColumn(column).numFmt = "0.0;[Red]-0.0;-";
    for (let column = 12; column <= 14; column += 1) sheet.getColumn(column).numFmt = "0.0;[Red]-0.0;-";
  }

  function addMarketSheet(workbook, marketId) {
    const name = marketNames[marketId];
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(["구분","NEW/OLD","티커","종목명","섹터","종가","등락률(%)","시총($B)","PER(TTM)","PBR","60일","52주","이유"]);
    const rows = state.data.stocks.filter((row) => row.market === marketId);
    for (const item of rows) {
      const row = sheet.addRow([item.signal === "high" ? "신고가" : "신저가",item.isNew ? "NEW" : "OLD",excelTicker(item),item.name,item.sector,item.close,item.changePct,item.marketCapUsd/1e9,item.per,item.pbr,"O",item.hit52 ? "O" : null,item.reasonType === "news" ? item.reason : null]);
      row.getCell(1).font = { color: { argb: item.signal === "high" ? "FFC00000" : "FF0000C0" } };
      if (item.isNew) row.getCell(2).font = { bold: true };
      if (item.reasonUrl && item.reasonType === "news") {
        row.getCell(13).value = { text: item.reason, hyperlink: item.reasonUrl };
        row.getCell(13).font = { color: { argb: "FF0563C1" }, underline: true };
      }
    }
    sheet.columns = [{width:12},{width:12},{width:20},{width:44},{width:28},{width:14},{width:14},{width:14},{width:14},{width:12},{width:9},{width:9},{width:72}];
    styleWorksheet(sheet, 13);
    sheet.getColumn(6).numFmt = "#,##0.00";
    sheet.getColumn(7).numFmt = "+0.00;[Blue]-0.00;-";
    sheet.getColumn(8).numFmt = "0.0";
    sheet.getColumn(9).numFmt = "0.0";
    sheet.getColumn(10).numFmt = "0.0";
    sheet.getColumn(13).alignment = { wrapText: true, vertical: "top" };
  }

  function styleWorksheet(sheet, columnCount, filterLastRow) {
    const header = sheet.getRow(1);
    header.height = 24;
    header.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDDDDD" } };
      cell.font = { bold: true, color: { argb: "FF111111" } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, filterLastRow || sheet.rowCount), column: columnCount } };
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      sheet.getRow(row).eachCell((cell) => { cell.alignment = { ...cell.alignment, vertical: "top" }; });
    }
  }

  function excelTicker(row) { return `${row.ticker} ${marketTickerSuffix[row.market] || ""} Equity`.trim(); }
  function etfComment(row) { const d1 = Number(row.returns?.d1); const m1 = Number(row.returns?.m1); return `${row.sector} ${d1 >= 0 ? "상승" : "하락"}(${signed(d1,1)}%). 1개월 ${signed(m1,1)}%, YTD ${signed(row.returns?.ytd,1)}%.`; }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy]");
    if (button) navigator.clipboard?.writeText(button.dataset.copy);
  });

  function heatCell(value) {
    if (value == null || !Number.isFinite(Number(value))) return '<td class="heat empty">-</td>';
    const number = Number(value); const intensity = Math.min(1, Math.abs(number) / 25);
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
    document.getElementById("global-panel").innerHTML = '<div class="global-empty"><strong>글로벌 데이터 없음</strong><span>/global 명령을 실행하면 날짜별로 저장됩니다.</span></div>';
  }
  function showLoadError(date) {
    document.getElementById("global-panel").innerHTML = `<div class="global-empty"><strong>${escapeHtml(date || "선택 날짜")} 데이터를 불러오지 못했습니다.</strong><span>다른 날짜를 선택하거나 /global을 다시 실행하세요.</span></div>`;
  }
  function emptyRow(columns) { return `<tr><td colspan="${columns}" class="empty-table">조건에 맞는 데이터가 없습니다.</td></tr>`; }
  function sectorName(value) { return sectorKo[value] || value || "기타"; }
  function signed(value, digits = 1) { const number = Number(value) || 0; return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`; }
  function tone(value) { const number = Number(value) || 0; return number > 0 ? "positive" : number < 0 ? "negative" : "neutral"; }
  function formatNumber(value, digits = 1) { return value == null || !Number.isFinite(Number(value)) ? "-" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits }); }
  function formatPrice(value, currency) { return `${currency || ""} ${Number(value || 0).toLocaleString("ko-KR", { maximumFractionDigits: Number(value) < 100 ? 2 : 1 })}`; }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char])); }
  function escapeAttr(value) { return escapeHtml(value); }
})();
