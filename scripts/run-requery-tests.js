// Runs the RBL "Requery" test scenarios (REQ_TC_001 - REQ_TC_008) against the RBL UPI sandbox
// and writes a step-by-step report to generated-exports/requery-report-<time>.md
//
// Usage:  node scripts/run-requery-tests.js
// Env (optional):
//   REQUERY_WAIT_SEC   wait between status enquiries in the short scenarios (default 30)
//   POLL_INTERVAL_MIN  interval for REQ_TC_006 periodic enquiries (default 20)
//   POLL_COUNT         number of periodic enquiries for REQ_TC_006 (default 3)
//
// Failure simulation:
//   Response timeout -> payment is sent, but we stop waiting after 200 ms (bank still processes it)
//   Request timeout  -> payment is sent to an unroutable address, so it never reaches the bank
//   HTTP error       -> payment to payee sangeeta@rbl, which the sandbox answers with HTTP 404
//
// The certificate passphrase is read from .env in memory only; it is never written to disk.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

// Credentials come from .env (same variables as src/services/rblPaymentService.js).
const BASE = new URL(`${process.env.RBL_BASE_URL || 'https://apideveloper.rbl.bank.in/test/sb/rbl/api/v1/upi'}/payment`);
const HOST = BASE.host;
const PATH = `${BASE.pathname}?client_id=${process.env.RBL_CLIENT_ID}&client_secret=${process.env.RBL_CLIENT_SECRET}`;
const UNREACHABLE_HOST = '10.255.255.1'; // non-routable: connection never completes
const HEADERS = {
  'Content-Type': 'application/xml',
  'X-IBM-Client-Id': process.env.RBL_CLIENT_ID,
  'X-IBM-Client-Secret': process.env.RBL_CLIENT_SECRET,
  Authorization: 'Basic ' + Buffer.from(`${process.env.RBL_LDAP_USER}:${process.env.RBL_LDAP_PASS}`).toString('base64'),
};
const BCAGENT = process.env.RBL_BC_AGENT;
const MRCH = process.env.RBL_MERCHANT_ID;
const AGGR = process.env.RBL_AGGREGATOR_ID;
const PAYER_VPA = process.env.RBL_PAYER_VPA;
const DEVICE = `<mobile>9876251297</mobile>
  <geocode>28.644800,77.216721</geocode>
  <location>delhi</location>
  <ip>192.168.0.183</ip>
  <type>MOB</type>
  <id></id>
  <os>IOS</os>
  <app>123456</app>
  <capability>100</capability>
  <hmac>79996CB2-584E-4694-93E7-BEFDED3DE5</hmac>`;

const WAIT_SEC = Number(process.env.REQUERY_WAIT_SEC || 30);
const POLL_INTERVAL_MIN = Number(process.env.POLL_INTERVAL_MIN || 20);
const POLL_COUNT = Number(process.env.POLL_COUNT || 3);

const certPath = path.resolve(process.env.RBL_CERT_PATH || 'rbl_cert.pfx');
const agent = new https.Agent({ pfx: fs.readFileSync(certPath), passphrase: process.env.RBL_CERT_PASSPHRASE });

const reportFile = path.resolve('generated-exports', `requery-report-${Date.now()}.md`);
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
const log = (line = '') => {
  console.log(line);
  fs.appendFileSync(reportFile, line + '\n');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const tag = (xml, name) => ((xml || '').match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1];
const compact = (body) => (body || '').replace(/<\?xml[^>]*>/, '').replace(/\s+/g, ' ').trim().slice(0, 400);

// Sends XML. Resolves {code, body} or {error}. With responseTimeoutMs, resolves {timedOut, late}
// once that time passes; `late` resolves later with what the bank actually answered.
function post(xml, { host = HOST, connectTimeoutMs = 90000, responseTimeoutMs } = {}) {
  const full = new Promise((resolve) => {
    const req = https.request(
      { host, path: PATH, method: 'POST', agent: host === HOST ? agent : undefined, headers: { ...HEADERS, 'Content-Length': Buffer.byteLength(xml) } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ code: res.statusCode, body }));
      }
    );
    req.setTimeout(connectTimeoutMs, () => req.destroy(new Error(`ETIMEDOUT (no response within ${connectTimeoutMs / 1000}s)`)));
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(xml);
  });
  if (!responseTimeoutMs) return full;
  return Promise.race([full, sleep(responseTimeoutMs).then(() => ({ timedOut: true, late: full }))]);
}

let session = '';
const login = async () => {
  const r = await post(`<?xml version="1.0" encoding="UTF-8"?>
<channelpartnerloginreq>
  <username>${process.env.RBL_LOGIN_USERNAME}</username>
  <password>${process.env.RBL_LOGIN_PASSWORD}</password>
  <bcagent>${BCAGENT}</bcagent>
</channelpartnerloginreq>`);
  session = tag(r.body, 'sessiontoken');
  if (!session) throw new Error('Login failed: ' + (r.body || r.error));
};
const getTxnId = async () => {
  const r = await post(`<gettxnid>
  <header><sessiontoken>${session}</sessiontoken><bcagent>${BCAGENT}</bcagent></header>
  <mrchOrgId>${MRCH}</mrchOrgId>
  <aggrOrgId>${AGGR}</aggrOrgId>
  ${DEVICE}
</gettxnid>`);
  const id = tag(r.body, 'txnId');
  if (!id) throw new Error('GetTxnId failed: ' + (r.body || r.error));
  return id;
};
const newTxn = async (payee = 'test@mypsp') => {
  const stamp = Date.now() + '' + Math.floor(Math.random() * 1000);
  return {
    txnId: await getTxnId(),
    refId: 'REF' + stamp,
    orgTxnId: 'ORG' + stamp,
    // 100.00 - 999.99 so it never matches the 1.00 - 99.99 amounts used by the Postman suites (e4259 rule).
    amount: (100 + Math.random() * 899.99).toFixed(2),
    payee,
  };
};
const paymentXml = (t) => `<upidisbursement>
  <header><sessiontoken>${session}</sessiontoken><bcagent>${BCAGENT}</bcagent></header>
  <mrchOrgId>${MRCH}</mrchOrgId>
  <aggrOrgId>${AGGR}</aggrOrgId>
  <note>UpiTransaction</note>
  <refId>${t.refId}</refId>
  <refUrl>http://rblbank.com</refUrl>
  <orgTxnId>${t.orgTxnId}</orgTxnId>
  <txnId>${t.txnId}</txnId>
  ${DEVICE}
  <payeraddress>${PAYER_VPA}</payeraddress>
  <payername>Assured Rewards</payername>
  <payeeaddress>${t.payee}</payeeaddress>
  <payeename>test</payeename>
  <amount>${t.amount}</amount>
</upidisbursement>`;
const searchXml = (id, flag = '0') => `<searchrequest>
  <header><sessiontoken>${session}</sessiontoken><bcagent>${BCAGENT}</bcagent></header>
  <mrchOrgId>${MRCH}</mrchOrgId>
  <aggrOrgId>${AGGR}</aggrOrgId>
  ${DEVICE}
  <orgTxnIdorrefId>${id}</orgTxnIdorrefId>
  <flag>${flag}</flag>
</searchrequest>`;

const describe = (r) => {
  if (r.timedOut) return 'NO RESPONSE (partner stopped waiting after 200 ms)';
  if (r.error) return `NETWORK ERROR: ${r.error}`;
  const status = tag(r.body, 'txnstatus') || tag(r.body, 'status');
  const desc = tag(r.body, 'description');
  if (r.code !== 200) return `HTTP ${r.code}: ${compact(r.body)}`;
  return [status && `status=${status}`, desc, tag(r.body, 'custref') && `custref=${tag(r.body, 'custref')}`, tag(r.body, 'amount') && `amount=${tag(r.body, 'amount')}`]
    .filter(Boolean).join('; ') || compact(r.body);
};
const step = (n, text, r) => log(`| ${n} | ${now()} | ${text} | ${describe(r).replace(/\|/g, '\\|')} |`);
const enquire = async (n, t) => step(n, `Status enquiry (txnId ${t.txnId}, flag 0)`, await post(searchXml(t.txnId)));
const header = (id, title, t) => {
  log(`\n## ${id} — ${title}\n`);
  if (t) log(`txnId \`${t.txnId}\` · refId \`${t.refId}\` · amount ${t.amount} · payee ${t.payee}\n`);
  log('| Step | Time | Action | Result |\n|---|---|---|---|');
};
const lateResults = [];

async function main() {
  log(`# RBL Requery test run\n\nStarted ${now()} · wait between enquiries ${WAIT_SEC}s · periodic interval ${POLL_INTERVAL_MIN} min x ${POLL_COUNT}`);
  await login();

  // REQ_TC_001: response timeout, then status enquiry
  const t1 = await newTxn();
  header('REQ_TC_001', 'No response to payment (response timeout)', t1);
  const p1 = await post(paymentXml(t1), { responseTimeoutMs: 200 });
  step(1, 'Payment sent', p1);
  if (p1.late) lateResults.push(['REQ_TC_001', p1.late]);
  await sleep(WAIT_SEC * 1000);
  await enquire(2, t1);

  // REQ_TC_002: request timeout (never reaches bank), 3 enquiries, retry with same txnId/refId
  const t2 = await newTxn();
  header('REQ_TC_002', 'No response to payment (request timeout)', t2);
  step(1, 'Payment sent (request times out before reaching bank)', await post(paymentXml(t2), { host: UNREACHABLE_HOST, connectTimeoutMs: 5000 }));
  for (const n of [2, 3, 4]) { await sleep(WAIT_SEC * 1000); await enquire(n, t2); }
  step(5, 'Retry payment with same txnId and refId', await post(paymentXml(t2)));
  await sleep(5000);
  await enquire(6, t2);

  // REQ_TC_003: delayed processing — response timeout, 3 enquiries, retry (expect duplicate), final enquiry
  const t3 = await newTxn();
  header('REQ_TC_003', 'No response to payment (delayed processing)', t3);
  const p3 = await post(paymentXml(t3), { responseTimeoutMs: 200 });
  step(1, 'Payment sent', p3);
  if (p3.late) lateResults.push(['REQ_TC_003', p3.late]);
  for (const n of [2, 3, 4]) { await sleep(WAIT_SEC * 1000); await enquire(n, t3); }
  step(5, 'Retry payment with same txnId and refId', await post(paymentXml(t3)));
  await sleep(5000);
  await enquire(6, t3);

  // REQ_TC_004: HTTP error response, 3 enquiries, retry (expect duplicate), final enquiry
  const t4 = await newTxn('sangeeta@rbl');
  header('REQ_TC_004', 'HTTP error response to payment', t4);
  step(1, 'Payment sent', await post(paymentXml(t4)));
  for (const n of [2, 3, 4]) { await sleep(WAIT_SEC * 1000); await enquire(n, t4); }
  step(5, 'Retry payment with same txnId and refId', await post(paymentXml(t4)));
  await sleep(5000);
  await enquire(6, t4);

  // REQ_TC_005: transaction not logged at bank (network failure), enquiry
  const t5 = await newTxn();
  header('REQ_TC_005', 'Transaction not logged at bank (network failure)', t5);
  step(1, 'Payment sent (network failure, never reaches bank)', await post(paymentXml(t5), { host: UNREACHABLE_HOST, connectTimeoutMs: 5000 }));
  await sleep(WAIT_SEC * 1000);
  await enquire(2, t5);

  // REQ_TC_008: invalid txnId
  header('REQ_TC_008', 'Status enquiry with non-existent / invalid txnId');
  step(1, 'Status enquiry (txnId RPA0000000000000000000INVALID000000, flag 0)', await post(searchXml('RPA0000000000000000000INVALID000000')));

  // Responses the bank sent after the partner stopped waiting (evidence for TC_001 / TC_003)
  log('\n## Late responses (arrived after the 200 ms partner timeout)\n');
  for (const [id, late] of lateResults) log(`- ${id}: ${describe(await late)}`);

  // REQ_TC_006: periodic enquiries for scenarios 1, 2, 3 (and 5) at POLL_INTERVAL_MIN intervals
  header('REQ_TC_006', `Periodic status enquiry every ${POLL_INTERVAL_MIN} minutes`);
  for (let i = 1; i <= POLL_COUNT; i++) {
    await sleep(POLL_INTERVAL_MIN * 60 * 1000);
    await login(); // keep the session fresh across long waits
    for (const [id, t] of [['TC_001', t1], ['TC_002', t2], ['TC_003', t3], ['TC_005', t5]]) {
      step(`${i}.${id}`, `Enquiry #${i} for ${id} (txnId ${t.txnId})`, await post(searchXml(t.txnId)));
    }
  }

  // REQ_TC_007: after periodic enquiries, initiate transaction with the same txnId as the unlogged one
  header('REQ_TC_007', 'Initiate transaction with same txnId after requery', t5);
  step(1, 'Payment with same txnId as REQ_TC_005', await post(paymentXml(t5)));
  await sleep(5000);
  await enquire(2, t5);

  log(`\nFinished ${now()}`);
}

main().catch((e) => {
  log(`\n**Run aborted:** ${e.message}`);
  process.exit(1);
});
