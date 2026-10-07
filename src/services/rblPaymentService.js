const axios = require('axios');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Lazily resolve the Prisma client so that requiring this module never
 * touches the database / env (prismaClient throws if DATABASE_URL is unset).
 */
function getPrisma() {
    return require('../config/prismaClient');
}

const RESPONSE_LOG_MAX = 20000;
const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Extract the text content of the first <tag>...</tag> in an XML string.
 * Self-closing (<tag/>, <tag />) or empty tags return null.
 */
function extractTag(xml, tag) {
    if (xml === null || xml === undefined) return null;
    if (typeof xml !== 'string') {
        try { xml = JSON.stringify(xml); } catch (e) { return null; }
    }
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    if (!match) return null;
    const value = match[1].trim();
    return value === '' ? null : value;
}

/**
 * Escape characters that would break the XML document.
 */
function escapeXml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Keep only letters, digits and spaces; collapse whitespace; trim; cap length.
 */
function sanitizeText(value, maxLength, fallback) {
    const cleaned = String(value === null || value === undefined ? '' : value)
        .replace(/[^A-Za-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
        .trim();
    return cleaned || fallback;
}

/**
 * Remove secrets from a request body before persisting it.
 */
function redactSecrets(xml) {
    if (typeof xml !== 'string') return '';
    return xml
        .replace(/<password>[\s\S]*?<\/password>/gi, '<password>***</password>')
        .replace(/<sessiontoken>[\s\S]*?<\/sessiontoken>/gi, '<sessiontoken>***</sessiontoken>');
}

/**
 * RBL "session expired / invalid" detection.
 */
function isSessionError(body) {
    if (typeof body !== 'string' || !body) return false;
    return /session\s+has\s+been\s+expired|session[^<]{0,40}invalid|please\s+relogin/i.test(body);
}

// Calendar day in India Standard Time (UTC+5:30), e.g. '2026-10-07'.
const istDay = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

class RblPaymentService {
    constructor() {
        this.baseURL = process.env.RBL_BASE_URL || 'https://apideveloper.rbl.bank.in/test/sb/rbl/api/v1/upi';
        this.clientId = process.env.RBL_CLIENT_ID;
        this.clientSecret = process.env.RBL_CLIENT_SECRET;
        this.ldapUser = process.env.RBL_LDAP_USER;
        this.ldapPass = process.env.RBL_LDAP_PASS;
        // Channel-partner credentials sent inside <channelpartnerloginreq> (different from the HTTP basic-auth LDAP user).
        this.loginUsername = process.env.RBL_LOGIN_USERNAME || this.ldapUser;
        this.loginPassword = process.env.RBL_LOGIN_PASSWORD || this.ldapPass;

        this.mrchOrgId = process.env.RBL_MERCHANT_ID;
        this.aggrOrgId = process.env.RBL_AGGREGATOR_ID;
        this.bcagent = process.env.RBL_BC_AGENT;

        // Certificate is optional in the code. If the file doesn't exist, it connects without it.
        this.certPath = process.env.RBL_CERT_PATH;
        this.certPassphrase = process.env.RBL_CERT_PASSPHRASE;

        if (this.certPath && fs.existsSync(this.certPath)) {
            this.httpsAgent = new https.Agent({
                pfx: fs.readFileSync(this.certPath),
                passphrase: this.certPassphrase,
                // RBL whitelists our IPv4 address; its Akamai host also resolves to IPv6, so pin IPv4.
                family: Number(process.env.RBL_IP_FAMILY || 4)
            });
        } else {
            console.warn(`RBL client certificate not found at RBL_CERT_PATH=${this.certPath || '(unset)'} - RBL will reject calls (HTTP 403)`);
            this.httpsAgent = new https.Agent({ rejectUnauthorized: false, family: Number(process.env.RBL_IP_FAMILY || 4) });
        }

        // In-memory session cache
        this.sessionToken = null;
        this.sessionObtainedAt = null;
        this._loginPromise = null;
    }

    _getRequestConfig() {
        return {
            auth: {
                username: this.ldapUser,
                password: this.ldapPass
            },
            params: {
                client_id: this.clientId,
                client_secret: this.clientSecret
            },
            headers: {
                'Content-Type': 'application/xml',
                'Accept': 'application/xml',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Axios/1.x',
                'X-IBM-Client-Id': this.clientId,
                'X-IBM-Client-Secret': this.clientSecret,
                'client_id': this.clientId,
                'client_secret': this.clientSecret
            },
            httpsAgent: this.httpsAgent,
            responseType: 'text', // Force axios to not parse JSON automatically
            transformResponse: [(data) => data], // Keep the raw body as-is
            // RBL guideline: Payment and Re-Query APIs answer in 2-30 s; keep the client timeout at 60 s.
            timeout: Number(process.env.RBL_TIMEOUT_MS || 60000),
            maxRedirects: 0, // RBL 302 -> /Error.html must surface, not be followed
            validateStatus: () => true // Never throw on HTTP status; we classify ourselves
        };
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Unique uppercase alphanumeric reference (<= 20 chars).
     * Used for refId and orgTxnId.
     */
    generateRefId() {
        const bytes = crypto.randomBytes(6);
        let suffix = '';
        for (let i = 0; i < bytes.length; i++) {
            suffix += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
        }
        return `AR${Date.now().toString(36).toUpperCase()}${suffix}`.slice(0, 20);
    }

    /**
     * Persist one HTTP exchange to RblApiLog. Never throws.
     */
    async _logApi({ withdrawalId = null, api, txnId = null, requestBody, responseBody = null, httpStatus = null, error = null, durationMs = null }) {
        try {
            let response = responseBody;
            if (response !== null && response !== undefined && typeof response !== 'string') {
                try { response = JSON.stringify(response); } catch (e) { response = String(response); }
            }
            if (typeof response === 'string' && response.length > RESPONSE_LOG_MAX) {
                response = response.slice(0, RESPONSE_LOG_MAX);
            }

            await getPrisma().rblApiLog.create({
                data: {
                    withdrawalId: withdrawalId || null,
                    api,
                    txnId: txnId || null,
                    requestBody: redactSecrets(requestBody),
                    responseBody: response === undefined ? null : response,
                    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
                    error: error ? String(error).slice(0, 5000) : null,
                    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null
                }
            });
        } catch (logError) {
            console.error(`RBL API log write failed (${api}):`, logError.message);
        }
    }

    /**
     * POST an XML payload to the RBL payment endpoint. Never throws.
     * Returns { httpStatus, body, error, durationMs }.
     * httpStatus is null and error is set on transport failure (timeout, socket, DNS...).
     */
    async _post(api, xmlPayload, { withdrawalId = null, txnId = null } = {}) {
        const url = `${this.baseURL}/payment`;
        const startedAt = Date.now();
        let httpStatus = null;
        let body = null;
        let error = null;

        try {
            const response = await axios.post(url, xmlPayload, this._getRequestConfig());
            httpStatus = response.status;
            body = typeof response.data === 'string'
                ? response.data
                : (response.data === undefined || response.data === null ? null : JSON.stringify(response.data));
            if (httpStatus !== 200) {
                const location = response.headers && response.headers.location;
                error = `HTTP ${httpStatus}${location ? ` (Location: ${location})` : ''}`;
            }
        } catch (err) {
            error = `${err.code ? `${err.code}: ` : ''}${err.message}`;
            if (err.response) {
                httpStatus = err.response.status || null;
                body = typeof err.response.data === 'string' ? err.response.data : null;
            }
        }

        const durationMs = Date.now() - startedAt;
        await this._logApi({ withdrawalId, api, txnId, requestBody: xmlPayload, responseBody: body, httpStatus, error, durationMs });

        if (error) {
            console.error(`RBL ${api} error:`, error);
        }

        return { httpStatus, body, error, durationMs };
    }

    /* ------------------------------------------------------------------ */
    /*  1. Channel Partner Login / Session                                */
    /* ------------------------------------------------------------------ */

    async _login() {
        const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<channelpartnerloginreq>
  <username>${escapeXml(this.loginUsername)}</username>
  <password>${escapeXml(this.loginPassword)}</password>
  <bcagent>${escapeXml(this.bcagent)}</bcagent>
</channelpartnerloginreq>`;

        const res = await this._post('login', xmlPayload);
        if (res.error && res.httpStatus === null) {
            throw new Error(`RBL login failed: ${res.error}`);
        }
        if (res.httpStatus !== 200) {
            throw new Error(`RBL login failed: HTTP ${res.httpStatus}`);
        }

        const status = extractTag(res.body, 'status');
        const token = extractTag(res.body, 'sessiontoken');
        if (status !== '1' || !token) {
            const description = extractTag(res.body, 'description');
            throw new Error(`RBL login failed: ${description || 'status ' + status}`);
        }
        return token;
    }

    /**
     * Returns a cached session token, logging in when needed.
     * Concurrent callers share a single in-flight login.
     */
    async getSessionToken({ forceRefresh = false } = {}) {
        if (forceRefresh) {
            this.sessionToken = null;
            this.sessionObtainedAt = null;
        }
        // RBL session tokens expire at 12:00 am (IST) of the calendar day they were created on.
        if (this.sessionToken && this.sessionDay !== istDay()) {
            this.sessionToken = null;
        }
        if (this.sessionToken) return this.sessionToken;

        if (!this._loginPromise) {
            this._loginPromise = (async () => {
                try {
                    const token = await this._login();
                    this.sessionToken = token;
                    this.sessionObtainedAt = Date.now();
                    this.sessionDay = istDay();
                    return token;
                } finally {
                    this._loginPromise = null;
                }
            })();
        }
        return this._loginPromise;
    }

    /* ------------------------------------------------------------------ */
    /*  2. Get Transaction ID                                             */
    /* ------------------------------------------------------------------ */

    _buildGetTxnIdXml(sessionToken) {
        return `<gettxnid>
  <header>
    <sessiontoken>${escapeXml(sessionToken)}</sessiontoken>
    <bcagent>${escapeXml(this.bcagent)}</bcagent>
  </header>
  <mrchOrgId>${escapeXml(this.mrchOrgId)}</mrchOrgId>
  <aggrOrgId>${escapeXml(this.aggrOrgId)}</aggrOrgId>
  <mobile>9999999999</mobile>
  <geocode></geocode>
  <location></location>
  <ip>127.0.0.1</ip>
  <type></type>
  <id>1</id>
  <os></os>
  <app></app>
  <capability></capability>
  <hmac>DUMMY_UNUSED</hmac>
</gettxnid>`;
    }

    async getTransactionId({ withdrawalId } = {}) {
        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const sessionToken = await this.getSessionToken({ forceRefresh: attempt > 0 });
            res = await this._post('gettxnid', this._buildGetTxnIdXml(sessionToken), { withdrawalId });

            if (res.httpStatus === 200 && isSessionError(res.body) && attempt === 0) {
                continue;
            }
            break;
        }

        if (res.httpStatus !== 200) {
            throw new Error(`RBL getTransactionId failed: ${res.error || `HTTP ${res.httpStatus}`}`);
        }
        const txnId = extractTag(res.body, 'txnId');
        if (!txnId) {
            const description = extractTag(res.body, 'description');
            throw new Error(`RBL getTransactionId failed: ${description || 'no txnId in response'}`);
        }
        return txnId;
    }

    /* ------------------------------------------------------------------ */
    /*  3. Validate VPA                                                   */
    /* ------------------------------------------------------------------ */

    _buildValidateVpaXml(sessionToken, vpa, refId) {
        return `<validatevpa>
  <header>
    <sessiontoken>${escapeXml(sessionToken)}</sessiontoken>
    <bcagent>${escapeXml(this.bcagent)}</bcagent>
  </header>
  <mrchOrgId>${escapeXml(this.mrchOrgId)}</mrchOrgId>
  <aggrOrgId>${escapeXml(this.aggrOrgId)}</aggrOrgId>
  <note>TEST</note>
  <refId>${refId}</refId>
  <orgTxnId>${refId}</orgTxnId>
  <refUrl></refUrl>
  <mobile>9999999999</mobile>
  <geocode>28.35,77.03</geocode>
  <location>delhi</location>
  <ip>127.0.0.1</ip>
  <type>MOB</type>
  <id>1</id>
  <os>Android</os>
  <app>cashback</app>
  <capability></capability>
  <hmac>DUMMY_UNUSED</hmac>
  <addr>${escapeXml(String(vpa || '').trim())}</addr>
</validatevpa>`;
    }

    /**
     * Returns { isValid, verifiedName, description }.
     * Throws only on transport failure / non-200 HTTP / login failure.
     */
    async validateVPA(vpa, { withdrawalId } = {}) {
        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const sessionToken = await this.getSessionToken({ forceRefresh: attempt > 0 });
            const refId = this.generateRefId();
            res = await this._post('validatevpa', this._buildValidateVpaXml(sessionToken, vpa, refId), { withdrawalId, txnId: refId });

            if (res.httpStatus === 200 && isSessionError(res.body) && attempt === 0) {
                continue;
            }
            break;
        }

        if (res.httpStatus !== 200) {
            throw new Error(`RBL validateVPA failed: ${res.error || `HTTP ${res.httpStatus}`}`);
        }

        const isValid = extractTag(res.body, 'status') === '1';
        const description = extractTag(res.body, 'description');
        return {
            isValid,
            verifiedName: isValid ? description : null,
            description
        };
    }

    /* ------------------------------------------------------------------ */
    /*  4. Disbursement / Payment                                         */
    /* ------------------------------------------------------------------ */

    _buildDisburseXml(sessionToken, { txnId, refId, orgTxnId, vpa, name, amount, note }) {
        return `<upidisbursement>
  <header>
    <sessiontoken>${escapeXml(sessionToken)}</sessiontoken>
    <bcagent>${escapeXml(this.bcagent)}</bcagent>
  </header>
  <mrchOrgId>${escapeXml(this.mrchOrgId)}</mrchOrgId>
  <aggrOrgId>${escapeXml(this.aggrOrgId)}</aggrOrgId>
  <note>${escapeXml(note)}</note>
  <refId>${escapeXml(refId)}</refId>
  <refUrl></refUrl>
  <orgTxnId>${escapeXml(orgTxnId)}</orgTxnId>
  <txnId>${escapeXml(txnId)}</txnId>
  <mobile>9999999999</mobile>
  <geocode>28.64,77.21</geocode>
  <location>delhi</location>
  <ip>127.0.0.1</ip>
  <type>MOB</type>
  <id></id>
  <os>IOS</os>
  <app>CashbackApp</app>
  <capability>100</capability>
  <hmac>DUMMY_UNUSED</hmac>
  <payeraddress>${escapeXml(process.env.RBL_PAYER_VPA || 'api1.CUBEPAYY@rbl')}</payeraddress>
  <payername>${escapeXml(process.env.RBL_PAYER_NAME || 'CUBEPAYY')}</payername>
  <payeeaddress>${escapeXml(vpa)}</payeeaddress>
  <payeename>${escapeXml(name)}</payeename>
  <amount>${amount}</amount>
</upidisbursement>`;
    }

    /**
     * Classify one disbursement HTTP exchange.
     */
    _classifyDisburse(res) {
        const base = {
            httpStatus: res.httpStatus,
            status: null,
            description: null,
            refid: null,
            raw: res.body
        };

        // Transport failure / timeout / non-200 (302 Error.html, 404, 5xx): money may have moved
        if (res.httpStatus !== 200) {
            return { ...base, outcome: 'uncertain', description: res.error || `HTTP ${res.httpStatus}` };
        }

        const body = typeof res.body === 'string' ? res.body : '';
        const status = extractTag(body, 'status');
        const description = extractTag(body, 'description');
        const refid = extractTag(body, 'refid');
        const result = { ...base, status, description, refid };
        const text = `${description || ''} ${body}`;

        if (status && status.toUpperCase() === 'SUCCESS') {
            return { ...result, outcome: 'success' };
        }
        if (isSessionError(text)) {
            return { ...result, outcome: 'session_expired' };
        }
        if (/ERR010/i.test(text)) {
            return { ...result, outcome: 'duplicate' };
        }
        if (/e4259/i.test(text)) {
            return { ...result, outcome: 'already_posted' };
        }
        // A status-0 error does NOT prove the bank has no record: in the sandbox, CBS errors such as
        // ':e4472' (posting date) came back status 0 while the transaction was logged IN PROGRESS.
        // 'rejected' means: the bank said no, but the payout may only be failed once a status enquiry agrees.
        if (status && (status === '0' || status.toUpperCase() === 'FAILURE') && description) {
            return { ...result, outcome: 'rejected' };
        }

        // Empty / unparseable body, or a status we do not recognise (PENDING, DEEMED, ...)
        return { ...result, outcome: 'uncertain', description: description || 'Unrecognised disbursement response' };
    }

    /**
     * Sends the UPI disbursement. NEVER throws.
     * Returns { outcome, httpStatus, status, description, refid, raw } where outcome is
     * 'success' | 'session_expired' | 'duplicate' | 'already_posted' | 'rejected' (bank error, confirm by enquiry) | 'validation_error' (bad input, nothing sent) | 'uncertain'.
     * On a session error it re-logs in once and resends with the SAME txnId/refId/orgTxnId.
     */
    async disburse({ withdrawalId, txnId, refId, orgTxnId, vpa, name, amount, note } = {}) {
        try {
            const numericAmount = Number(amount);
            if (!txnId || !refId || !vpa || !Number.isFinite(numericAmount) || numericAmount <= 0) {
                // Rejected locally, nothing sent to the bank
                return {
                    outcome: 'validation_error',
                    httpStatus: null,
                    status: null,
                    description: 'Invalid disbursement input (txnId, refId, vpa and positive amount are required)',
                    refid: null,
                    raw: null
                };
            }

            const payload = {
                txnId,
                refId,
                orgTxnId: orgTxnId || refId,
                vpa: String(vpa || '').trim(),
                name: sanitizeText(name, 99, 'Customer'),
                amount: Number(amount).toFixed(2),
                note: sanitizeText(note, 50, 'Cashback Payout')
            };

            let result = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                let sessionToken;
                try {
                    sessionToken = await this.getSessionToken({ forceRefresh: attempt > 0 });
                } catch (loginError) {
                    // Nothing was sent to the bank on this attempt
                    if (attempt === 0) {
                        return {
                            outcome: 'session_expired',
                            httpStatus: null,
                            status: null,
                            description: loginError.message,
                            refid: null,
                            raw: null
                        };
                    }
                    // Re-login failed after a session error: request was never processed
                    return { ...result, outcome: 'session_expired', description: loginError.message };
                }

                const res = await this._post('disburse', this._buildDisburseXml(sessionToken, payload), { withdrawalId, txnId });
                result = this._classifyDisburse(res);

                if (result.outcome === 'session_expired' && attempt === 0) {
                    continue;
                }
                break;
            }
            return result;
        } catch (error) {
            // Defensive: something unexpected after (possibly) sending — treat as uncertain
            console.error('RBL disburse unexpected error:', error.message);
            return {
                outcome: 'uncertain',
                httpStatus: null,
                status: null,
                description: error.message,
                refid: null,
                raw: null
            };
        }
    }

    /* ------------------------------------------------------------------ */
    /*  5. Transaction Status Enquiry (Search)                            */
    /* ------------------------------------------------------------------ */

    _buildSearchXml(sessionToken, id, flag) {
        return `<searchrequest>
  <header>
    <sessiontoken>${escapeXml(sessionToken)}</sessiontoken>
    <bcagent>${escapeXml(this.bcagent)}</bcagent>
  </header>
  <mrchOrgId>${escapeXml(this.mrchOrgId)}</mrchOrgId>
  <aggrOrgId>${escapeXml(this.aggrOrgId)}</aggrOrgId>
  <mobile>9999999999</mobile>
  <geocode></geocode>
  <location></location>
  <ip>127.0.0.1</ip>
  <type></type>
  <id>1</id>
  <os></os>
  <app></app>
  <capability></capability>
  <hmac>DUMMY_UNUSED</hmac>
  <orgTxnIdorrefId>${escapeXml(id)}</orgTxnIdorrefId>
  <flag>${Number(flag) === 1 ? 1 : 0}</flag>
</searchrequest>`;
    }

    _parseSearch(res) {
        const result = {
            ok: false,
            txnStatus: null,
            custRef: null,
            amount: null,
            txnErrorCode: null,
            payeeRespCode: null,
            httpStatus: res.httpStatus,
            raw: res.body,
            error: null
        };

        if (res.httpStatus !== 200) {
            return { ...result, error: res.error || `HTTP ${res.httpStatus}` };
        }

        const body = typeof res.body === 'string' ? res.body : '';
        const rawTxnStatus = extractTag(body, 'txnstatus');
        result.custRef = extractTag(body, 'custref');
        result.amount = extractTag(body, 'amount');
        result.txnErrorCode = extractTag(body, 'txnerrorcode');
        result.payeeRespCode = extractTag(body, 'payeerespcode');

        if (!rawTxnStatus) {
            const description = extractTag(body, 'description');
            return { ...result, error: description || 'Unparseable search response' };
        }

        const normalized = rawTxnStatus.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
        if (/TRANSACTION NOT FOUND/.test(normalized)) {
            return { ...result, ok: true, txnStatus: 'NOT_FOUND' };
        }
        if (normalized === 'SUCCESS') {
            return { ...result, ok: true, txnStatus: 'SUCCESS' };
        }
        if (normalized === 'FAILURE' || normalized === 'FAILED') {
            return { ...result, ok: true, txnStatus: 'FAILURE' };
        }
        if (normalized === 'IN PROGRESS' || normalized === 'INPROGRESS' || normalized === 'PENDING' || normalized === 'DEEMED') {
            return { ...result, ok: true, txnStatus: 'IN PROGRESS' };
        }
        return { ...result, error: `Unrecognised txnstatus: ${rawTxnStatus}` };
    }

    /**
     * Status enquiry. flag 0 = by txnId, flag 1 = by refId. NEVER throws.
     * Returns { ok, txnStatus, custRef, amount, txnErrorCode, payeeRespCode, httpStatus, raw, error }.
     */
    async searchTransaction({ withdrawalId, id, flag = 0 } = {}) {
        try {
            let parsed = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const sessionToken = await this.getSessionToken({ forceRefresh: attempt > 0 });
                const res = await this._post('search', this._buildSearchXml(sessionToken, id, flag), { withdrawalId, txnId: id });

                if (res.httpStatus === 200 && isSessionError(res.body) && attempt === 0) {
                    continue;
                }
                parsed = this._parseSearch(res);
                if (res.httpStatus === 200 && isSessionError(res.body)) {
                    parsed = { ...parsed, ok: false, txnStatus: null, error: 'RBL session expired after re-login' };
                }
                break;
            }
            return parsed;
        } catch (error) {
            console.error('RBL searchTransaction error:', error.message);
            return {
                ok: false,
                txnStatus: null,
                custRef: null,
                amount: null,
                txnErrorCode: null,
                payeeRespCode: null,
                httpStatus: null,
                raw: null,
                error: error.message
            };
        }
    }
}

module.exports = new RblPaymentService();
