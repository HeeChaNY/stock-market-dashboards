import { RateLimiter } from "./rateLimiter.mjs";

const INVESTOR_DAILY_PATH = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily";
const INVESTOR_DAILY_TR_ID = "FHPTJ04160001";
const INVESTOR_TREND_ESTIMATE_PATH = "/uapi/domestic-stock/v1/quotations/investor-trend-estimate";
const INVESTOR_TREND_ESTIMATE_TR_ID = "HHPTJ04160200";
const RANKING_PATH = "/uapi/domestic-stock/v1/quotations/foreign-institution-total";
const RANKING_TR_ID = "FHPTJ04400000";
const PRICE_PATH = "/uapi/domestic-stock/v1/quotations/inquire-price";
const PRICE_TR_ID = "FHKST01010100";
const NEAR_HIGHLOW_PATH = "/uapi/domestic-stock/v1/ranking/near-new-highlow";
const NEAR_HIGHLOW_TR_ID = "FHPST01870000";
const HOLIDAY_PATH = "/uapi/domestic-stock/v1/quotations/chk-holiday";
const HOLIDAY_TR_ID = "CTCA0903R";

export class KisClient {
  constructor(config) {
    this.baseUrl = config.kisBaseUrl;
    this.appKey = config.kisAppKey;
    this.appSecret = config.kisAppSecret;
    this.limiter = new RateLimiter(config.requestsPerSecond);
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.marketOpenCache = new Map();
    this.tokenRetryDelayMs = config.tokenRetryDelayMs ?? 65_000;
    this.sleep = config.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  assertConfigured() {
    if (!this.appKey || !this.appSecret) throw new Error("KIS_APP_KEY와 KIS_APP_SECRET을 .env에 설정해 주세요.");
  }

  async investorDaily(symbol, baseDate) {
    return this.get(INVESTOR_DAILY_PATH, INVESTOR_DAILY_TR_ID, {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: baseDate,
      FID_ORG_ADJ_PRC: "",
      FID_ETC_CLS_CODE: "",
    });
  }

  async investorTrendEstimate(symbol) {
    return this.get(INVESTOR_TREND_ESTIMATE_PATH, INVESTOR_TREND_ESTIMATE_TR_ID, {
      MKSC_SHRN_ISCD: symbol,
    });
  }

  async currentPrice(symbol) {
    return this.get(PRICE_PATH, PRICE_TR_ID, {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: symbol,
    });
  }

  async isMarketOpenDate(baseDate) {
    if (this.marketOpenCache.has(baseDate)) return this.marketOpenCache.get(baseDate);
    const payload = await this.get(HOLIDAY_PATH, HOLIDAY_TR_ID, {
      BASS_DT: baseDate,
      CTX_AREA_FK: "",
      CTX_AREA_NK: "",
    });
    const rows = Array.isArray(payload.output) ? payload.output : payload.output ? [payload.output] : [];
    const row = rows.find((item) => String(item.bass_dt || item.bass_dt1 || "") === baseDate) || rows[0];
    if (!row || row.opnd_yn == null) throw new Error(`${baseDate} 국내 증시 개장 여부를 확인하지 못했습니다.`);
    const isOpen = String(row.opnd_yn).toUpperCase() === "Y";
    this.marketOpenCache.set(baseDate, isOpen);
    return isOpen;
  }

  async foreignInstitutionRanking({ market = "0000", investor = "1", sort = "0", amount = true }) {
    return this.get(RANKING_PATH, RANKING_TR_ID, {
      FID_COND_MRKT_DIV_CODE: "V",
      FID_COND_SCR_DIV_CODE: "16449",
      FID_INPUT_ISCD: market,
      FID_DIV_CLS_CODE: amount ? "1" : "0",
      FID_RANK_SORT_CLS_CODE: sort,
      FID_ETC_CLS_CODE: investor,
    });
  }

  async nearNewHighRanking(market = "0001") {
    return this.get(NEAR_HIGHLOW_PATH, NEAR_HIGHLOW_TR_ID, {
      FID_APLY_RANG_VOL: "0",
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "20187",
      FID_DIV_CLS_CODE: "0",
      FID_INPUT_CNT_1: "0",
      FID_INPUT_CNT_2: "100",
      FID_PRC_CLS_CODE: "0",
      FID_INPUT_ISCD: market,
      FID_TRGT_CLS_CODE: "0",
      FID_TRGT_EXLS_CLS_CODE: "0",
      FID_APLY_RANG_PRC_1: "0",
      FID_APLY_RANG_PRC_2: "1000000",
    });
  }

  async get(path, trId, query) {
    const token = await this.getToken();
    await this.limiter.wait();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey: this.appKey, appsecret: this.appSecret, tr_id: trId },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.rt_cd === "1") {
      const error = new Error(payload.msg1 || `KIS 요청 실패: HTTP ${response.status}`);
      error.code = payload.msg_cd;
      if (/EGW00201|429|초당|거래건수/i.test(`${error.code || ""} ${error.message}`)) this.limiter.penalize();
      throw error;
    }
    return payload;
  }

  async getToken() {
    this.assertConfigured();
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.#issueToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async #issueToken() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/oauth2/tokenP`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", appkey: this.appKey, appsecret: this.appSecret }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.access_token) {
        this.token = payload.access_token;
        this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 82800) - 300) * 1000;
        return this.token;
      }
      const message = payload.error_description || payload.msg1 || "KIS 접근 토큰 발급 실패";
      const code = payload.error_code || payload.msg_cd || null;
      if (attempt === 0 && isTokenRateLimitError(code, message)) {
        console.warn(`KIS 접근 토큰 발급 제한으로 ${Math.ceil(this.tokenRetryDelayMs / 1000)}초 후 한 번 재시도합니다.`);
        await this.sleep(this.tokenRetryDelayMs);
        continue;
      }
      const error = new Error(message);
      error.code = code || "KIS_TOKEN_ISSUE_FAILED";
      throw error;
    }
    throw new Error("KIS 접근 토큰 발급 실패");
  }
}

function isTokenRateLimitError(code, message) {
  const text = `${code || ""} ${message || ""}`;
  return /1분당\s*1회|분당\s*1회|접근토큰 발급 잠시 후 다시 시도/i.test(text);
}
